const DEFAULTS = {
	cellSize: 6, // CSS px per grid cell (drives dot density)
	dotScale: 1, // max square half-width as a fraction of the cell half-size;
	// 1 fills the cell edge-to-edge so the brightest level reads as a solid block
	levels: 5, // discrete brightness steps (ASCII-ramp look); <=1 => continuous
	gamma: 0.8, // luminance shaping exponent (>1 darkens mids)
	contrast: 1.1, // luminance contrast around 0.5
	color: "", // dot color; empty => read --color-fg
	background: "", // backdrop color; empty => read --color-bg
	colorReveal: 80, // pointer trail radius (CSS px) when `color-reveal` is empty
	shimmer: 8, // percent of dots that flash when `shimmer` is empty
	revealBoost: 0.3, // vividness of revealed color: 0 = raw sample, 1 = "ascii" pop
	// --- CRT "display" look (ported from the science-lab dot-matrix shader) ---
	dotShape: 2, // 0 = square (legacy), 1 = circle, 2 = morph circle->rounded-square
	bloom: 0.55, // 0..1 glow + phosphor rim on the brightest dots; 0 => off
	scanlines: 0.12, // 0..1 CRT horizontal scanline darkening; 0 => off
	vignette: 0.4, // 0..1 edge darkening; 0 => off
	crosshatch: 0.35, // 0..1 cross-hatch shading strength in the darkest cells; 0 => off
	// --- intro wipe (brightest dots first) ---
	introMs: 2600, // duration of the develop-in when `intro` is present but empty
	introDelayMs: 500, // hold the grid empty this long first, so the wipe reads as
	// a deliberate entrance rather than something already half-finished by the time
	// the eye lands on it
	introJitter: 0.16, // grain in the brightness wavefront (0 = a clean contour sweep)
	// --- clip transition (see TRANSITIONS) ---
	// Duration of a clip-to-clip transition when `xfade` is present but empty. Slow
	// enough to be read as a deliberate effect: at ~700ms the per-cell modes (rain's
	// falling columns, threshold's brightest-first assembly) resolve faster than the
	// eye can follow their structure, which wastes what makes them interesting.
	xfadeMs: 1600,
} as const;

// Map the `dot-shape` attribute string to its shader enum. Numbers pass through
// (so the playground can drive it with a 0/1/2 range); unknown values fall back
// to the default morph.
const DOT_SHAPES: Record<string, number> = { square: 0, circle: 1, morph: 2 };

/**
 * Clip-transition styles for `xfade-mode`, mapped to the shader's enum. Both blend
 * the outgoing and incoming clips PER CELL (see the uXfade block in the fragment
 * shader) rather than dipping the whole stage's opacity, so the grid itself carries
 * the change — something a plain video crossfade cannot do.
 *
 *   threshold — a hard per-cell flip ordered by the INCOMING dot's brightness, so
 *               the new image assembles out of its own highlights. The default.
 *   rain      — Matrix code rain: per-column drops type the new clip in, most
 *               columns flickering between the two clips before they settle.
 *
 * These two were chosen from a wider set of experiments (dissolve, develop,
 * shuffle, sweep, iris, bloom, collapse, scanline, ripple, static, spiral); the
 * rest were dropped rather than kept as dead shader branches every fragment pays
 * to skip. Numbers pass through so a slider can drive it.
 *
 * NB the numbers are the shader's branch order: they must stay contiguous and in
 * step with the `m < N.5` bounds there, so adding a mode means editing both sides.
 */
const TRANSITIONS: Record<string, number> = {
	threshold: 0,
	rain: 1,
};

const MAX_DPR = 2; // clamp devicePixelRatio so 4K/retina stays affordable
const MAX_TRAIL = 32; // pointer samples kept for the color-reveal trail
const TRAIL_MS = 600; // trail lifetime — longer than fade-in so dots trail out slowly

/**
 * `<dotted-grid src="/videos/fabric.web.mp4">` — renders a video as an animated
 * halftone dot grid via a single fullscreen quad + fragment shader (raw WebGL2,
 * no dependencies). Each grid cell samples the video at its center and draws a
 * dot whose radius tracks local brightness.
 *
 * Attributes (all live-updatable):
 *   src           video URL (required; H.264 mp4 — the universal fallback)
 *   src-webm      optional WebM (AV1/VP9) URL preferred over `src` where the
 *                 browser can play it. When set, the <video> is fed an ordered
 *                 <source> list (webm, then mp4) so the browser picks the best.
 *   cell-size     grid cell size in CSS px (default 6)
 *   dot-scale     max square half-width as fraction of cell half-size (default 1;
 *                 1 fills the cell so the brightest level is a solid block)
 *   levels        discrete brightness steps for an ASCII-ramp look (default 5);
 *                 each step is a fixed square size, brightest fills the cell.
 *                 Set to 1 (or 0) for a smooth, continuous size ramp.
 *   invert        boolean; flips the brightness->radius mapping
 *   color         dot color (default: CSS --color-fg)
 *   background    backdrop color (default: CSS --color-bg)
 *   gamma         luminance exponent (default 0.8)
 *   contrast      luminance contrast (default 1.1)
 *   paused        boolean; freezes the animation
 *   color-reveal  pointer trail radius in CSS px; dots within it show the video's
 *                 true color, fading in fast and out slow (comet trail). Absent
 *                 => no trail; empty => default radius.
 *   shimmer       percent (0-100) of dots that spontaneously flash to their true
 *                 color and fade, for ambient life. Absent => off; empty => default.
 *   reveal-boost  0..1; how far a revealed dot's color snaps to the nearest vivid
 *                 ANSI terminal color (default 1). 0 = raw sampled color; 1 = full
 *                 "ascii" pop so reveals stay vivid over a dark video.
 *   no-loop       boolean; plays the video once instead of looping. On the final
 *                 frame it dispatches a bubbling `dotted-grid:ended` CustomEvent so
 *                 a host (e.g. a carousel) can advance. Absent => loops (default).
 *   dot-shape     dot silhouette: `square` (legacy per-axis box), `circle`, or
 *                 `morph` (default) — small/dim dots read as circles, the brightest
 *                 morph to rounded squares, echoing a phosphor dot-matrix display.
 *                 A numeric 0/1/2 works too (for the live playground slider).
 *   bloom         0..1; glow halo + phosphor rim on the brightest dots (default
 *                 0.55). 0 disables it and falls back to the subtle highlight-lift.
 *   scanlines     0..1; CRT horizontal scanline darkening (default 0.12). 0 => off.
 *   vignette      0..1; edge darkening toward the frame corners (default 0.4). 0 => off.
 *   crosshatch    0..1; cross-hatch engraving marks in the darkest cells, denser as
 *                 brightness falls (default 0.35). 0 => off.
 *   intro         boolean-or-ms; develop the picture in ONCE on arrival, brightest
 *                 dots first. Each cell's dot grows from nothing to its true size as
 *                 a brightness threshold sweeps from the highlights down into the
 *                 shadows, so the image resolves out of the backdrop like a print in
 *                 developer. Absent => off (the image simply appears); empty =>
 *                 default 2600ms; a number sets the duration.
 *                 The clock starts at the FIRST DECODED FRAME, so a slow network
 *                 delays the wipe instead of eating it, and it never replays — a
 *                 clip swap mid-carousel must not re-develop the frame.
 *   intro-delay   ms to hold the grid EMPTY before the wipe starts (default 500).
 *                 Also measured from the first decoded frame, so delay + duration
 *                 compose into one predictable entrance however long the video took
 *                 to arrive. 0 => start developing immediately.
 *   intro-jitter  brightness-units of per-cell noise in that wavefront (default
 *                 0.16), so the arrival edge breaks into grain instead of sweeping
 *                 as a visible contour line through flat areas. 0 => a clean sweep.
 *   xfade         boolean-or-ms; animate CLIP-TO-CLIP changes (a `src` swap) instead
 *                 of cutting. The outgoing clip's last frame is frozen into a second
 *                 texture at the swap, and the shader blends the two PER CELL — so
 *                 the grid itself carries the transition rather than the whole stage
 *                 dipping in opacity. Absent => a plain cut (previous behaviour);
 *                 empty => default 700ms. Skipped under prefers-reduced-motion, and
 *                 whenever the outgoing buffer has no frame to freeze (a cut is
 *                 better than blending against black).
 *   xfade-mode    which transition: `threshold` (default) or `rain`. Both blend the
 *                 two clips per cell and drive dot size, so they read as the display
 *                 resolving rather than two videos mixing. A number (0-1) also works.
 *                 See TRANSITIONS.
 *   xfade-live    boolean; run the transition WHILE BOTH CLIPS PLAY. The outgoing
 *                 buffer is kept alive and decoding (its frame re-uploaded every
 *                 frame) instead of frozen at a still, and — with `no-loop` — the
 *                 clip announces its end one transition EARLY so the blend plays out
 *                 over its tail rather than after it.
 *                 The trade, accepted deliberately: the last `xfade` ms of every clip
 *                 is partly obscured by the incoming one, so clip endings are no
 *                 longer seen cleanly. Absent => the cheaper frozen-frame blend,
 *                 which starts only once the old clip has finished.
 *
 * The color reveal (trail + shimmer) is disabled while paused or under
 * prefers-reduced-motion, matching the animation gating. So is `intro` — a
 * develop-in is decorative, so that visitor gets the finished image immediately.
 *
 * Lifecycle mirrors the other packages (gallery-carousel): a `listeners`
 * cleanup array, a `rafId` guard, a `ResizeObserver`, and reduced-motion
 * handling. Teardown is thorough because Layout.astro uses ClientRouter (view
 * transitions), so elements disconnect/reconnect on navigation and the GL
 * context + RAF loop must not leak.
 */
export class DottedGridElement extends HTMLElement {
	static get observedAttributes() {
		return [
			"src",
			"src-webm",
			"cell-size",
			"dot-scale",
			"levels",
			"invert",
			"color",
			"background",
			"gamma",
			"contrast",
			"paused",
			"color-reveal",
			"shimmer",
			"reveal-boost",
			"no-loop",
			"dot-shape",
			"bloom",
			"scanlines",
			"vignette",
			"crosshatch",
			"intro",
			"intro-delay",
			"intro-jitter",
			"xfade",
			"xfade-mode",
			"xfade-live",
		];
	}

	private canvas: HTMLCanvasElement | null = null;
	// Double-buffered <video>: `video` is the one currently rendered; `nextVideo`
	// is where an incoming clip decodes off-screen during a src swap. When its first
	// frame is ready we flip the pointer so the swap is gapless (no black dip). Hero
	// single-`src` usages only ever touch `video`; `nextVideo` stays null.
	private video: HTMLVideoElement | null = null;
	private nextVideo: HTMLVideoElement | null = null;
	// Cleanup for the in-flight nextVideo's readiness listener, so a rapid second
	// swap can cancel the first without leaking handlers.
	private pendingSwapCleanup: (() => void) | null = null;
	// Per-video listener teardown (loadeddata/seeked/ended). Videos are created and
	// retired across swaps, so each carries its own cleanup rather than sharing the
	// element-lifetime `listeners` array.
	private videoCleanups = new WeakMap<HTMLVideoElement, () => void>();
	private gl: WebGL2RenderingContext | null = null;
	private program: WebGLProgram | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private buffer: WebGLBuffer | null = null;
	private texture: WebGLTexture | null = null;
	/** Second texture unit: the OUTGOING clip during a transition. */
	private prevTexture: WebGLTexture | null = null;
	/**
	 * The outgoing clip's buffer, kept alive and STILL DECODING for the duration of
	 * a transition so both clips play through the blend. Retired when it completes.
	 */
	private prevVideo: HTMLVideoElement | null = null;
	/** Wall-clock ms when the current clip transition began; null when idle. */
	private xfadeStart: number | null = null;
	/** True while prevTexture holds a real outgoing frame — without it a transition
	 *  would blend against an empty (black) second source. */
	private xfadeHasPrev = false;
	/**
	 * Buffers whose "I am nearly over" signal has already been sent. The advance
	 * fires EARLY (see maybeAnnounceEnding), so the clip's own later `ended` must be
	 * swallowed or the carousel would step twice for one clip.
	 */
	private endingAnnounced = new WeakSet<HTMLVideoElement>();
	private uniforms: Record<string, WebGLUniformLocation | null> = {};

	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private reducedMotion: MediaQueryList | null = null;
	private listeners: Array<() => void> = [];
	// The animation loop. We prefer requestVideoFrameCallback (rVFC) so the shader
	// runs at the video's true frame rate (~30fps) instead of the display's 60fps —
	// re-uploading + re-shading an unchanged frame is otherwise ~half the GPU work.
	// Firefox lacks rVFC, so we fall back to requestAnimationFrame. The two use
	// different cancel APIs, so `useVfc` records which handle `frameHandle` holds.
	// `scheduleRender` still uses `rafId` for its one-shot paints.
	private playing = false;
	private useVfc = false;
	private frameHandle: number | null = null;
	private rafId: number | null = null;

	private visible = true; // in viewport (IntersectionObserver)
	private textureReady = false; // has at least one frame been uploaded
	/** Whether the "first frame is up" announcement has already been made. Distinct
	 *  from textureReady, which goes back to false on teardown and on every clip
	 *  swap — this must fire exactly ONCE per element so the canvas fades in on
	 *  arrival and never re-fades mid-carousel (the swap has its own crossfade). */
	private announcedReady = false;

	/** Wall-clock ms at which the intro wipe started, or null when it isn't running.
	 *  Started on the first textured frame (not on connect): the wipe reveals the
	 *  picture, so it can only begin once there IS a picture to reveal. */
	private introStart: number | null = null;
	/** Set once the wipe has run, so it plays as an ENTRANCE and never replays —
	 *  a clip swap mid-carousel must not re-develop the whole frame. */
	private introDone = false;

	// Recent pointer positions (device px, canvas-relative) with timestamps,
	// newest last. Drives the color-reveal comet trail; ages out over TRAIL_MS.
	private trail: Array<{ x: number; y: number; t: number }> = [];
	// Preallocated upload buffers so render() doesn't allocate per frame.
	private trailXY = new Float32Array(MAX_TRAIL * 2);
	private trailAge = new Float32Array(MAX_TRAIL);

	connectedCallback() {
		this.canvas = document.createElement("canvas");
		this.appendChild(this.canvas);

		const gl = this.canvas.getContext("webgl2", {
			alpha: false,
			antialias: false,
			premultipliedAlpha: false,
		});
		// No WebGL2: bail gracefully. The element keeps its CSS background so the
		// page still looks intentional rather than broken. Announce readiness on the
		// way out — there will never be a frame here, and anything waiting on this
		// element must not be held back by a browser that can't run the effect.
		if (!gl) {
			this.announceReady();
			return;
		}
		this.gl = gl;

		if (!this.initGL()) {
			this.announceReady();
			return;
		}

		this.video = this.createVideo();
		this.appendChild(this.video);

		this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onMotionChange = () => this.applyPlaybackState();
		this.reducedMotion.addEventListener("change", onMotionChange);
		this.listeners.push(() =>
			this.reducedMotion?.removeEventListener("change", onMotionChange)
		);

		// Pointer trail for the color reveal. Always listen; the shader ignores the
		// trail when `color-reveal` is absent. On pointer leave we simply stop
		// adding samples — the existing ones age out over TRAIL_MS for a natural
		// fade. The reveal only shows while playing, when the RAF loop is already
		// running, so recording a sample is all we need here.
		const onPointerMove = (e: PointerEvent) => this.pushTrail(e);
		this.addEventListener("pointermove", onPointerMove);
		this.listeners.push(() =>
			this.removeEventListener("pointermove", onPointerMove)
		);

		// Repaint when the page theme flips. The color/background uniforms are read
		// fresh each draw, so a running loop already re-tints; this covers the
		// paused / reduced-motion case where no loop is painting.
		const onThemeChange = () => this.scheduleRender();
		document.addEventListener("themechange", onThemeChange);
		this.listeners.push(() =>
			document.removeEventListener("themechange", onThemeChange)
		);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this);

		// Pause decode + RAF when the element scrolls out of view.
		this.intersectionObserver = new IntersectionObserver(
			(entries) => {
				this.visible = entries.some((e) => e.isIntersecting);
				this.applyPlaybackState();
			},
			{ rootMargin: "100px" }
		);
		this.intersectionObserver.observe(this);

		this.resize();
		this.applyPlaybackState();
	}

	disconnectedCallback() {
		this.stopLoop(); // cancels the rVFC/rAF loop via the correct API
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;

		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;

		this.listeners.forEach((off) => off());
		this.listeners = [];
		this.trail = [];

		// Cancel any in-flight swap and retire its off-screen buffer.
		if (this.pendingSwapCleanup) {
			this.pendingSwapCleanup();
			this.pendingSwapCleanup = null;
		}
		if (this.nextVideo) {
			this.retireVideo(this.nextVideo);
			this.nextVideo = null;
		}

		// An in-flight live transition may still be holding the outgoing buffer.
		if (this.prevVideo) {
			this.retireVideo(this.prevVideo);
			this.prevVideo = null;
		}

		if (this.video) {
			this.retireVideo(this.video);
			this.video = null;
		}

		const gl = this.gl;
		if (gl) {
			if (this.prevTexture) gl.deleteTexture(this.prevTexture);
			if (this.texture) gl.deleteTexture(this.texture);
			if (this.buffer) gl.deleteBuffer(this.buffer);
			if (this.vao) gl.deleteVertexArray(this.vao);
			if (this.program) gl.deleteProgram(this.program);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		}
		this.texture = null;
		this.prevTexture = null;
		this.xfadeStart = null;
		this.xfadeHasPrev = false;
		this.buffer = null;
		this.vao = null;
		this.program = null;
		this.uniforms = {};
		this.gl = null;
		this.textureReady = false;
		// Reset the announcement too: a re-connected element (ClientRouter can move
		// nodes between documents) starts from a blank canvas, so it must be allowed
		// to fade in again rather than inheriting a stale "ready".
		this.announcedReady = false;
		this.introStart = null;
		this.introDone = false;
		delete this.dataset.ready;

		this.canvas?.remove();
		this.canvas = null;
	}

	attributeChangedCallback(name: string, oldValue: string, newValue: string) {
		if (oldValue === newValue) return;
		if (!this.gl) return; // not yet connected

		// `src` drives the (gapless) swap; it reads `src-webm` fresh, so a host that
		// updates both sets src-webm first, then src. A lone src-webm change with an
		// unchanged src is a no-op (nothing to reload).
		if (name === "src" && this.video) {
			this.swapSource();
			return;
		}
		if (name === "src-webm") return;
		if (name === "paused") {
			this.applyPlaybackState();
			return;
		}
		if (name === "no-loop" && this.video) {
			this.video.loop = !this.hasAttribute("no-loop");
			return;
		}
		// cell-size / dot-scale / invert / color / background / gamma / contrast:
		// uniforms are read fresh each draw, so just repaint the current frame.
		this.scheduleRender();
	}

	/**
	 * Restart playback of the CURRENT video from its first frame. Useful for a host
	 * that "advances" to a clip using the same `src` as the current one (e.g. a
	 * carousel wrapping from its last clip back to a first clip that reuses the same
	 * file): re-setting an unchanged `src` attribute wouldn't reload, and with
	 * `no-loop` the video is parked on its final frame, so seek to 0 and play.
	 */
	replay() {
		const video = this.video;
		if (!video) return;
		try {
			video.currentTime = 0;
		} catch {
			/* seeking may throw before metadata; play() below still restarts it */
		}
		this.applyPlaybackState();
	}

	// --- setup -------------------------------------------------------------

	private createVideo(): HTMLVideoElement {
		const video = document.createElement("video");
		video.muted = true;
		video.defaultMuted = true;
		video.loop = !this.hasAttribute("no-loop");
		video.playsInline = true;
		video.autoplay = true;
		// Drop to metadata under Save-Data / a slow link: the visitor has asked us
		// not to eagerly pull whole video files. The first frame still uploads.
		video.preload = this.saveData() ? "metadata" : "auto";
		video.crossOrigin = "anonymous";
		this.setVideoSources(video);
		this.bindVideoListeners(video);
		return video;
	}

	/**
	 * Point a <video> at the current sources. With `src-webm`, feed an ordered
	 * <source> list (webm first, then mp4) so the browser picks the best it can
	 * play; otherwise set `video.src` directly (hero single-source usage). Always
	 * ends with load() so the element (re)starts fetching.
	 */
	private setVideoSources(video: HTMLVideoElement) {
		const webm = this.getAttribute("src-webm");
		const mp4 = this.resolveSrc();
		if (webm) {
			video.removeAttribute("src");
			video.replaceChildren();
			for (const [url, type] of [
				[webm, "video/webm"],
				[mp4, "video/mp4"],
			] as const) {
				if (!url) continue;
				const source = document.createElement("source");
				source.src = url;
				source.type = type;
				video.appendChild(source);
			}
		} else {
			video.replaceChildren();
			video.src = mp4;
		}
		video.load();
	}

	/** Wire the readiness + `ended` listeners for a video, tracking teardown so a
	 * retired buffer can be cleaned without touching the element-lifetime array. */
	private bindVideoListeners(video: HTMLVideoElement) {
		// First decodable frame -> upload a texture even while paused (needed for
		// the reduced-motion static render and to avoid a blank first paint).
		const onData = () => this.scheduleRender();
		video.addEventListener("loadeddata", onData);
		video.addEventListener("seeked", onData);

		// With `no-loop`, the video fires `ended` once it reaches its final frame.
		// Re-broadcast it as a bubbling event so a host carousel can advance. (When
		// looping — the default — `ended` never fires, so this stays silent.)
		//
		// Guarded by endingAnnounced: with `xfade` the advance is announced EARLY from
		// timeupdate below, so by the time the real `ended` lands the host has already
		// stepped. Firing again would skip a clip.
		const onEnded = () => {
			if (this.endingAnnounced.has(video)) return;
			this.endingAnnounced.add(video);
			this.dispatchEvent(new CustomEvent("dotted-grid:ended", { bubbles: true }));
		};
		video.addEventListener("ended", onEnded);

		// EARLY ADVANCE. To transition WHILE the outgoing clip is still playing, the
		// host has to be told to advance before the clip is over — one transition's
		// worth of lead time. timeupdate fires ~4x/sec, which is ample for a lead
		// measured in hundreds of ms.
		const onTimeUpdate = () => this.maybeAnnounceEnding(video);
		video.addEventListener("timeupdate", onTimeUpdate);

		this.videoCleanups.set(video, () => {
			video.removeEventListener("loadeddata", onData);
			video.removeEventListener("seeked", onData);
			video.removeEventListener("ended", onEnded);
			video.removeEventListener("timeupdate", onTimeUpdate);
		});
	}

	/**
	 * Announce "this clip is nearly over" one transition ahead of its real end, so a
	 * host carousel advances early and the crossfade plays out OVER the tail of the
	 * outgoing clip — both clips visibly running through the blend, rather than the
	 * new one starting from a frozen last frame.
	 *
	 * Costs the last `xfade` ms of each clip: the end of a clip is partly obscured by
	 * the incoming one. That is the deliberate trade — see the `xfade-live` attribute.
	 *
	 * No-ops without `xfade-live`, without a known duration (a stream, or metadata not
	 * in yet), or once already announced for this buffer.
	 */
	private maybeAnnounceEnding(video: HTMLVideoElement) {
		if (!this.hasAttribute("xfade-live")) return;
		if (!this.hasAttribute("no-loop")) return; // looping clips never "end"
		if (this.endingAnnounced.has(video)) return;
		if (video !== this.video) return; // only the live buffer advances the host
		const duration = video.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;

		// Lead = the transition's own length, so the blend finishes about when the
		// outgoing clip does. Clamped so a long xfade on a short clip cannot ask for a
		// lead longer than the clip itself.
		const lead = Math.min(
			this.num("xfade", DEFAULTS.xfadeMs) / 1000,
			duration * 0.5
		);
		if (video.currentTime < duration - lead) return;

		this.endingAnnounced.add(video);
		this.dispatchEvent(new CustomEvent("dotted-grid:ended", { bubbles: true }));
	}

	/** Fully retire a buffer: cancel listeners, stop decode, release the resource. */
	private retireVideo(video: HTMLVideoElement) {
		this.videoCleanups.get(video)?.();
		this.videoCleanups.delete(video);
		video.pause();
		video.removeAttribute("src");
		video.replaceChildren();
		video.load(); // release the decoded resource
		video.remove();
	}

	/**
	 * Gapless clip swap. Decode the incoming clip into an off-screen second buffer
	 * while the current one keeps rendering; flip the active pointer only once the
	 * newcomer has a frame ready (`loadeddata`), then retire the old buffer. Avoids
	 * the black dip of resetting the live video's src mid-render.
	 */
	private swapSource() {
		const current = this.video;
		if (!current) return;

		// Cancel any earlier in-flight swap (rapid scrubbing): retire its buffer.
		if (this.pendingSwapCleanup) {
			this.pendingSwapCleanup();
			this.pendingSwapCleanup = null;
		}
		if (this.nextVideo) {
			this.retireVideo(this.nextVideo);
			this.nextVideo = null;
		}

		const next = this.createVideo();
		this.nextVideo = next;
		this.appendChild(next);

		const promote = () => {
			if (this.nextVideo !== next) return; // superseded by a later swap
			next.removeEventListener("loadeddata", promote);
			next.removeEventListener("canplay", promote);
			this.pendingSwapCleanup = null;
			this.nextVideo = null;

			// Begin the transition against the OUTGOING clip. With `xfade-live` the
			// old buffer is KEPT (still playing, still uploading frames) so both clips
			// run through the blend; otherwise its current frame is frozen once and the
			// buffer retired, which is the cheaper cut.
			const live = this.beginTransition(current);

			// Stop the loop before flipping: startLoop()'s rVFC tick captures the
			// video it was started on, so it must be torn down and restarted against
			// the new buffer (applyPlaybackState → startLoop rebinds it).
			this.stopLoop();
			this.video = next;
			this.textureReady = false; // force a re-upload from the new buffer
			// Retire the old buffer NOW only if it isn't needed for a live blend; the
			// live path retires it when the transition completes (see endTransition).
			if (current && !live) this.retireVideo(current);
			this.applyPlaybackState();
		};

		next.addEventListener("loadeddata", promote);
		next.addEventListener("canplay", promote); // belt-and-suspenders
		this.pendingSwapCleanup = () => {
			next.removeEventListener("loadeddata", promote);
			next.removeEventListener("canplay", promote);
			this.retireVideo(next);
		};

		// Start the incoming buffer decoding immediately (muted, off-screen).
		next.play().catch(() => {
			/* autoplay may be blocked; promote still fires on loadeddata */
		});
	}

	/**
	 * Intro-wipe progress in [0,1]: 0 = blank grid, 1 = the finished image.
	 *
	 * Returns 1 (wipe off) unless the `intro` attribute is present, and also for
	 * reduced motion — a develop-in is decorative, so that visitor gets the image
	 * outright. The clock starts at the first textured frame, so a slow network
	 * delays the wipe rather than eating it.
	 *
	 * Eased ease-OUT (not smoothstep): the wavefront should leave the highlights
	 * promptly and then decelerate as it works down into the shadows, which is both
	 * how a print actually develops and where the interesting detail is. A
	 * symmetric smoothstep instead spends its slow phase at BOTH ends, and since the
	 * shader's shoulder already softens the start, the two compounded into ~0.8s of
	 * a 2.6s wipe where nothing perceptible happened.
	 */
	private introProgress(): number {
		if (this.introDone || !this.hasAttribute("intro")) return 1;
		if (this.reducedMotion?.matches) return 1;
		if (this.introStart === null) return 0; // no frame yet: hold the grid empty

		// Hold empty for the delay, THEN develop. Measured from the first decoded
		// frame like the wipe itself, so the two compose into one predictable
		// entrance regardless of how long the video took to arrive.
		// numZero (not num): an explicit intro-delay="0" must mean "start immediately"
		// rather than falling back to the default. It already clamps negatives.
		const elapsed = performance.now() - this.introStart;
		const delay = this.numZero("intro-delay", DEFAULTS.introDelayMs);
		if (elapsed < delay) return 0;

		const ms = Math.max(1, this.num("intro", DEFAULTS.introMs));
		const t = Math.min(1, (elapsed - delay) / ms);
		if (t >= 1) {
			// Latch: past the end the branch is skipped entirely from here on.
			this.introDone = true;
			return 1;
		}
		return t * (2 - t); // easeOutQuad
	}

	/** True when the visitor has opted into reduced data usage (Save-Data header
	 * or the browser's data-saver toggle). Used to soften preload. */
	private saveData(): boolean {
		const conn = (
			navigator as Navigator & { connection?: { saveData?: boolean } }
		).connection;
		return conn?.saveData === true;
	}

	private initGL(): boolean {
		const gl = this.gl;
		if (!gl) return false;

		const vs = `#version 300 es
		in vec2 aPos;
		out vec2 vUv;
		void main() {
			// aPos spans the clip-space quad [-1,1]; map to [0,1] uv with v flipped
			// so the video is upright (texture origin is bottom-left).
			vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
			gl_Position = vec4(aPos, 0.0, 1.0);
		}`;

		const fs = `#version 300 es
		precision highp float;
		#define MAX_TRAIL ${MAX_TRAIL}
		in vec2 vUv;
		out vec4 fragColor;

		uniform sampler2D uTex;
		uniform sampler2D uPrevTex;  // outgoing clip's last frame, during a transition

		// CLIP TRANSITION. uXfade 0..1 walks the outgoing clip to the incoming one;
		// 1 (the idle state) means "show uTex only" and skips every branch below.
		// uXfadeMode selects the character of the transition — see TRANSITIONS in
		// index.ts for the names.
		uniform float uXfade;
		uniform float uXfadeMode;
		uniform vec2 uResolution;   // canvas size in device px
		uniform float uVideoAspect; // video w/h
		uniform float uCell;        // cell size in device px
		uniform float uDotScale;    // max radius as fraction of cell half-size
		uniform float uLevels;      // discrete brightness steps (<=1 => continuous)
		uniform float uInvert;      // 0 or 1
		uniform float uGamma;
		uniform float uContrast;
		uniform vec3 uColor;        // dot color
		uniform vec3 uBg;           // backdrop color

		// CRT "display" look. Each is off at 0 so a uniform branch skips its cost.
		uniform float uShape;       // 0 square, 1 circle, 2 morph circle->rounded-square
		uniform float uBloom;       // 0..1 glow + phosphor rim on bright dots
		uniform float uScanlines;   // 0..1 horizontal scanline darkening
		uniform float uVignette;    // 0..1 edge darkening
		uniform float uCrosshatch;  // 0..1 cross-hatch marks in the darkest cells

		// Color reveal: dots within the trail radius or caught by the shimmer show
		// their true sampled color instead of the flat uColor.
		uniform vec2 uTrail[MAX_TRAIL]; // recent pointer positions, device px
		uniform float uTrailAge[MAX_TRAIL]; // 0 = newest .. 1 = oldest
		uniform int uTrailCount;    // active samples (0 => trail off)
		uniform float uRevealRadius;// pointer influence radius, device px
		uniform float uTime;        // seconds, for the shimmer pulse
		uniform float uShimmer;     // fraction 0..1 of dots that shimmer (0 => off)
		uniform float uRevealBoost; // 0 = raw sampled color, 1 = snap to ANSI palette

		// INTRO WIPE. 0 = nothing drawn (flat backdrop), 1 = the full image. Cells
		// cross in by BRIGHTNESS — the highlights arrive first and the shadows last,
		// so the picture develops out of the background like a photographic print
		// rather than cross-fading as one flat layer. 1 disables it entirely.
		uniform float uIntro;
		uniform float uIntroJitter; // randomness in the wavefront, in brightness units

		// "cover" mapping: fit the video across the canvas without stretching,
		// centered, cropping the overflowing axis.
		vec2 coverUv(vec2 uv) {
			float canvasAspect = uResolution.x / uResolution.y;
			vec2 scale = vec2(1.0);
			if (canvasAspect > uVideoAspect) {
				scale.y = uVideoAspect / canvasAspect; // pillar: crop top/bottom
			} else {
				scale.x = canvasAspect / uVideoAspect; // letter: crop left/right
			}
			return (uv - 0.5) * scale + 0.5;
		}

		float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

		// Highlight lift: the brightest cells blend from uColor toward the contrast
		// pole of the background (white on a dark bg, black on a light bg) so
		// highlights glow instead of reading as same-color-but-bigger dots. Automatic
		// and uniform — no attribute. HI_THRESHOLD is where the lift starts on the
		// shaped brightness; HI_STRENGTH is how far it goes at full brightness.
		const float HI_THRESHOLD = 0.75;
		const float HI_STRENGTH = 0.85;

		// Stable per-cell pseudo-random in [0,1) from integer cell coords.
		float hash(vec2 cell) {
			return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
		}

		// Snap a sampled color to the nearest vivid ANSI terminal color, giving the
		// reveal a bright "ascii art" pop. The source is normalized to full value
		// first (hue preserved, brightness maxed) so even dark pixels resolve to a
		// vivid palette entry instead of a muddy near-black one. Palette = the 6
		// bright ANSI hues + bright white (black/greys are intentionally excluded so
		// revealed dots always pop). uRevealBoost blends raw sample -> snapped.
		vec3 ansiSnap(vec3 c) {
			const vec3 PALETTE[7] = vec3[7](
				vec3(1.0, 0.0, 0.0), // bright red
				vec3(0.0, 1.0, 0.0), // bright green
				vec3(1.0, 1.0, 0.0), // bright yellow
				vec3(0.36, 0.36, 1.0), // bright blue
				vec3(1.0, 0.0, 1.0), // bright magenta
				vec3(0.0, 1.0, 1.0), // bright cyan
				vec3(1.0, 1.0, 1.0)  // bright white
			);
			float m = max(max(c.r, c.g), c.b);
			vec3 norm = c / max(m, 1e-4); // push brightest channel to 1 (keep hue)
			vec3 best = PALETTE[0];
			float bestD = 1e9;
			for (int i = 0; i < 7; i++) {
				float d = distance(norm, PALETTE[i]);
				if (d < bestD) { bestD = d; best = PALETTE[i]; }
			}
			return mix(c, best, uRevealBoost);
		}

		void main() {
			// Work in device pixels so cells are square regardless of aspect.
			vec2 px = vUv * uResolution;
			vec2 cell = floor(px / uCell);
			vec2 cellCenterPx = (cell + 0.5) * uCell;

			// Sample the video at the cell center (cover-mapped).
			vec2 sampleUv = coverUv(cellCenterPx / uResolution);
			vec2 sUv = clamp(sampleUv, 0.0, 1.0);
			vec3 src = texture(uTex, sUv).rgb;

			// CLIP TRANSITION. Blends the outgoing frame into the incoming one PER CELL
			// rather than fading the whole stage, so the grid itself carries the cut.
			// Each mode decides, for this cell, how far along the blend it is: t < 0
			// means "still the old clip here", t > 1 "fully the new one". The dot's
			// brightness is then read from whichever mix that implies, so a cell can
			// finish switching before its neighbour has started.
			//
			// Uniform branch on the idle value, so a carousel sitting on one clip pays
			// nothing for any of this.
			//
			// xfPulse is a per-cell dot-SIZE multiplier a mode may drive, so a
			// transition can swell or collapse the dots as it passes through them
			// instead of only changing what they sample. Applied after the level ramp
			// (below) and clamped there, so a bulging dot fattens within its own cell
			// rather than bleeding into its neighbours and turning the grid to mush.
			float xfPulse = 1.0;
			// A transition may also tint its wake (xfTintAmt 0 = leave the dot colour
			// alone), so a mode can carry its own light — e.g. the phosphor green of a
			// code rain -- without permanently touching the element's "color" attribute.
			vec3 xfTint = vec3(1.0);
			float xfTintAmt = 0.0;

			if (uXfade < 1.0) {
				vec3 prev = texture(uPrevTex, sUv).rgb;
				float t = uXfade;
				float m = uXfadeMode;

				if (m < 0.5) {
					// 0 THRESHOLD (default) — a hard per-cell flip, ordered by the INCOMING
					// dot's own value. The new clip's brightest cells claim their place first
					// and its shadows last, so the image assembles by its own structure:
					// highlights arrive as a sparse constellation that fills into a picture.
					// Each cell holds on the old clip until its moment, then switches — the
					// snap is the point, so this is deliberately not a soft cross-fade.
					float rank = 1.0 - luma(src);      // 0 = brightest incoming cell
					// A hard-ish edge (0.12) rather than a soft shoulder: the flip should read
					// as a switch, not a fade. A sliver of jitter keeps cells of identical
					// value from popping as one flat sheet.
					float j = (hash(cell + 29.0) - 0.5) * 0.07;
					float k = smoothstep(rank + j, rank + j + 0.12, t * 1.12);
					src = mix(prev, src, k);
					// Brief overshoot as each cell lands, so the arrival has a tick to it.
					xfPulse = 1.0 + (k - k * k) * 1.6;
				} else {
					// 1 RAIN — Matrix code rain. Each COLUMN of dots has its own drop falling
					// down it; the clip is rewritten behind each drop as it passes, so the
					// image is literally typed down the screen in phosphor green.
					//
					// Most columns fall MORE THAN ONCE, writing new-then-old-then-new, so they
					// visibly flicker between the two clips before settling. Columns also
					// finish at staggered times, so the rain thins out and dies down rather
					// than every drop stopping at once.
					float cols = uResolution.x / uCell;
					float rows = uResolution.y / uCell;
					float col = floor(sUv.x * cols);
					float row = floor(sUv.y * rows);

					// Passes per column: 1..3, from a per-column hash.
					float passes = 1.0 + floor(hash(vec2(col, 13.0)) * 3.0);
					// Head start, as a fraction of ONE pass, so columns are out of step.
					float stagger = hash(vec2(col, 7.0)) * 0.6;

					// WHEN this column finishes, as a fraction of the transition: spread over
					// the second half and skewed (the square) so most land early and a few
					// stragglers trail, which is what makes the rain die down.
					float fin = hash(vec2(col, 19.0));
					float finish = 0.45 + 0.55 * fin * fin;

					// Travel in passes, normalized so this column completes exactly at its own
					// finish time and then HOLDS. Every column completes — none is left
					// mid-fall with the old clip still showing in its lower half.
					float local = clamp(t / finish, 0.0, 1.0);
					float travel = (local + stagger) / (1.0 + stagger) * passes;
					float pass = floor(travel);            // which pass this column is on
					float within = fract(travel);          // 0..1 progress through it

					// The drop's head, in rows, for the current pass. Runs from above the top
					// edge to past the bottom so the whole column is covered.
					float span = rows + 12.0;
					float head = within * span - 6.0;
					float d = head - row;                  // >0 once the drop has passed

					// Which clip this pass writes. The LAST pass must land on the incoming
					// clip, so alternate backwards from the end: with N passes total and some
					// complete, an even number remaining means this pass writes the new clip.
					float remaining = passes - 1.0 - pass;
					float writesNew = mod(remaining, 2.0) < 0.5 ? 1.0 : 0.0;
					// Cells the drop has passed show this pass's target; cells ahead of it show
					// whatever the previous pass left, which is the opposite clip (or, on the
					// first pass, the outgoing one).
					float behind = clamp(d * 0.6, 0.0, 1.0);
					float already = (pass < 0.5) ? 0.0 : (1.0 - writesNew);
					float k = mix(already, writesNew, behind);
					src = mix(prev, src, k);

					// The drop itself: a soft green trail ABOVE the head, fading upward. No
					// enlarged or whitened head cell — the leading edge reads as the brightest
					// point of the trail rather than a blob travelling down the column.
					float trail = (d <= 0.0) ? clamp(1.0 + d / 10.0, 0.0, 1.0) : 0.0;
					xfTint = vec3(0.35, 1.0, 0.45);
					xfTintAmt = trail * 0.85;
					src += vec3(0.10) * trail;
				}
			}

			// Brightness -> shaped value in [0,1].
			float b = luma(src);
			b = clamp((b - 0.5) * uContrast + 0.5, 0.0, 1.0);
			b = pow(b, uGamma);
			// invert: bright cells give small dots instead of large ones.
			float amount = mix(b, 1.0 - b, uInvert);

			// ASCII-ramp look: snap brightness to a few discrete steps so the grid
			// reads as stepped glyph densities rather than a smooth size gradient.
			// Level 0 is empty; the top level fills the whole cell (solid block).
			if (uLevels > 1.0) {
				float step = round(amount * uLevels) / uLevels;
				amount = step;
			}

			// INTRO WIPE, scaling "amount" -- the dot's SIZE driver -- rather than the
			// final color. That makes each dot GROW from nothing to its true size, so
			// the reveal speaks the grid's own vocabulary: the quantity that encodes
			// brightness also encodes arrival. Fading the finished image instead would
			// just be a cross-dissolve with extra steps.
			//
			// The wavefront is a moving threshold on brightness: at uIntro = t, cells
			// brighter than roughly (1 - t) have arrived and dimmer ones have not, with
			// a soft shoulder so the edge is a gradient rather than a hard cut.
			// Highlights therefore land first and the shadows fill in last.
			//
			// Deliberately AFTER the level quantization: the ramp fixes each dot's
			// TARGET size and the intro then scales continuously toward it. Quantizing
			// afterwards instead would make every dot climb the ramp's discrete steps
			// on its way in, which reads as chunky stair-stepping mid-animation.
			//
			// Gated on < 1.0 so the steady state costs nothing -- a uniform branch, so
			// every fragment takes the same path and there is no warp divergence.
			// Per-cell arrival, 0 = not yet here, 1 = fully arrived. Kept in scope past
			// this block because the CRT layers below have to honour it too.
			float arrived = 1.0;
			if (uIntro < 1.0) {
				// Rank this cell on the wavefront by its own brightness, plus a little
				// per-cell noise so the boundary breaks into grain instead of sweeping
				// as a visible contour through flat regions of the image.
				float rank = b + (hash(cell) - 0.5) * uIntroJitter;
				// Widen the sweep past both ends so uIntro 0 is genuinely empty (even
				// the brightest cell is out) and 1 is genuinely complete (even the
				// darkest is in), jitter included.
				const float SHOULDER = 0.22; // softness of the arrival edge
				float front = mix(1.0 + uIntroJitter, -uIntroJitter - SHOULDER, uIntro);
				arrived = smoothstep(front, front + SHOULDER, rank);
				amount *= arrived;
			}

			// Dot silhouette. Three shapes share the same half-width (device px);
			// only the edge test differs.
			float halfCell = uCell * 0.5;
			vec2 dvec = px - cellCenterPx;                // signed offset from center
			vec2 absD = abs(dvec);                        // device px from center
			// Dot half-width (device px). xfPulse lets a transition swell/shrink dots as
			// it passes; clamped to the cell's half-diagonal so even a big pulse fills
			// its own cell at most and the grid never smears into a solid sheet.
			float halfW = amount * uDotScale * halfCell * max(xfPulse, 0.0);
			halfW = min(halfW, halfCell * 1.415);
			float circleDist = length(dvec);
			const float AA = 1.0;                         // fixed ~1px feather (device px)

			// sd is a signed distance (px, <0 inside) used by the bloom halo and
			// phosphor rim regardless of the drawn shape.
			float mask;
			float sd;
			if (uShape < 0.5) {
				// Legacy square: per-axis box (product of two 1D edges) with fwidth AA.
				// A Chebyshev max() distance is discontinuous along the cell diagonals,
				// so fwidth()-based AA spikes there and corners read as stray triangles;
				// two smooth axis edges avoid that. (The bloom/rim sd below may use the
				// box SDF safely because it feathers with a fixed AA, not fwidth.)
				vec2 aa = fwidth(absD);
				vec2 edge = 1.0 - smoothstep(halfW - aa, halfW + aa, absD);
				mask = (halfW > 0.0) ? edge.x * edge.y : 0.0;
				sd = max(absD.x, absD.y) - halfW;
			} else if (uShape < 1.5) {
				// Circle.
				sd = circleDist - halfW;
				mask = (halfW > 0.0) ? 1.0 - smoothstep(-AA, AA, sd) : 0.0;
			} else {
				// Morph: dim/small dots read as circles, bright dots pull toward a
				// rounded square (corner radius shrinks as brightness rises).
				float cornerR = min(halfW, mix(halfW * 0.9, halfW * 0.25, smoothstep(0.15, 0.7, amount)));
				vec2 qd = absD - vec2(halfW - cornerR);
				float sdRound = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - cornerR;
				float sq = smoothstep(0.15, 0.7, amount);
				sd = mix(circleDist - halfW, sdRound, sq);
				mask = (halfW > 0.0) ? 1.0 - smoothstep(-AA, AA, sd) : 0.0;
			}

			// Bloom halo + phosphor rim on the brightest dots (branch-gated: 0 cost
			// when uBloom == 0 or the cell is dim). The halo is a soft ring just
			// OUTSIDE the dot edge; the rim is a bright lip just INSIDE it — together
			// they read as glowing phosphor rather than a flat, larger dot.
			float glow = 0.0;
			float rim = 0.0;
			if (uBloom > 0.0 && amount > 0.5 && halfW > 0.0) {
				float bright = smoothstep(0.5, 1.0, amount);
				float haloW = max(2.0, halfW * 0.9);
				glow = (sd > 0.0) ? (1.0 - smoothstep(0.0, haloW, sd)) * bright * uBloom * 0.5 : 0.0;
				float rimPx = max(1.0, halfW * 0.3);
				float inner = 1.0 - smoothstep(-AA, AA, sd + rimPx);
				rim = max(mask - inner, 0.0) * bright * uBloom;
			}

			// Cross-hatch engraving in the darkest cells: a rotated dot-lattice whose
			// marks grow denser as brightness falls (branch-gated to shadow cells).
			// NB the * arrived at the end: this layer keys off LOW amount, and the intro
			// wipe drives amount toward 0 — so without it the hatch would grow STRONGER
			// the less of a cell had arrived, actively drawing the shadow texture over
			// the very cells the wipe is holding back.
			float hatch = 0.0;
			if (uCrosshatch > 0.0 && amount < 0.4) {
				float shadow = smoothstep(0.4, 0.0, amount); // 1 in the darkest cells
				float spacing = uCell * 0.7;
				float ca = cos(0.4363), sa = sin(0.4363);   // ~25deg
				vec2 rp = vec2(ca * px.x - sa * px.y, sa * px.x + ca * px.y);
				vec2 hcell = floor(rp / spacing);
				vec2 hcenter = (hcell + 0.5) * spacing;
				float hd = length(rp - hcenter);
				float hr = mix(0.4, spacing * 0.18, shadow);
				hatch = (1.0 - smoothstep(hr - 0.6, hr + 0.6, hd)) * shadow * uCrosshatch * arrived;
			}

			// --- color reveal: how much of the true video color to show here -----
			// Pointer trail: strongest near a recent sample, decaying with distance
			// (radial falloff) and sample age (1 - age). Newest sample => full color
			// (fast fade-in); older samples decay over TRAIL_MS (slow fade-out).
			// Skip the whole scan when the trail is empty (the common case — the hero
			// has no color-reveal), so those fragments don't spin the MAX_TRAIL loop.
			float trail = 0.0;
			if (uTrailCount > 0) {
				for (int i = 0; i < MAX_TRAIL; i++) {
					if (i >= uTrailCount) break;
					float d = distance(cellCenterPx, uTrail[i]);
					float falloff = 1.0 - smoothstep(0.0, uRevealRadius, d);
					trail = max(trail, falloff * (1.0 - uTrailAge[i]));
				}
			}

			// Shimmer: a fraction (uShimmer) of cells, chosen by hash, flash to color
			// on their own cycle. Each participating cell gets a random phase/speed
			// and a narrow spike per loop so only a few glow at any instant.
			float shimmer = 0.0;
			if (uShimmer > 0.0) {
				float h = hash(cell);
				if (h < uShimmer) {
					float speed = 0.15 + hash(cell + 7.0) * 0.35;
					float phase = hash(cell + 3.0);
					float cycle = fract(uTime * speed + phase);
					// Short bright spike (~12% of the cycle) that eases out.
					shimmer = 1.0 - smoothstep(0.0, 0.12, cycle);
				}
			}

			float colorRestore = clamp(max(trail, shimmer), 0.0, 1.0);
			// Revealed dots show a vivid ANSI-snapped color; unrevealed stay flat.
			// Guard the ansiSnap() palette search so it only runs where a dot is
			// actually revealed — most cells have colorRestore == 0 and would just
			// discard the result, so this skips the 7-iteration loop grid-wide.
			vec3 dot = uColor;
			if (colorRestore > 0.0) {
				dot = mix(uColor, ansiSnap(src), colorRestore);
			}
			// A transition's own light (the code rain's phosphor head/trail). Applied
			// after the reveal colour so it rides over everything, and only where the
			// mode asked for it — xfTintAmt is 0 for every other mode and at rest.
			if (xfTintAmt > 0.0) {
				dot = mix(dot, xfTint, clamp(xfTintAmt, 0.0, 1.0));
			}

			// Highlight lift: push the brightest cells toward the background's
			// contrast pole so they glow. Keyed on amount (the value that drives
			// dot size, so the biggest dots glow — and it stays correct under
			// invert, where amount differs from b). Attenuated by (1 - colorRestore)
			// so a dot currently showing its revealed/shimmer color keeps it instead
			// of being washed toward the pole. Pole derived from uBg => theme-safe
			// (both consumers hardcode uColor; only the bg flips with theme).
			vec3 hiPole = mix(vec3(1.0), vec3(0.0), step(0.5, luma(uBg)));
			// When bloom drives the highlight glow, fold back the standing highlight-lift
			// so the two don't double-count (bloom is the stronger, explicit version).
			float hiLift = smoothstep(HI_THRESHOLD, 1.0, amount) * HI_STRENGTH
				* (1.0 - colorRestore) * (1.0 - clamp(uBloom, 0.0, 1.0));
			dot = mix(dot, hiPole, hiLift);

			// Compose: start from the backdrop, engrave the shadow hatch, add the bloom
			// halo, paint the dot, then lift its phosphor rim toward the glow pole.
			vec3 result = uBg;
			result = mix(result, mix(uColor, hiPole, 0.3), hatch);
			result += hiPole * glow;
			result = mix(result, dot, mask);
			result += hiPole * rim * 0.6;

			// CRT scanlines: darken alternating device-pixel rows. Branch-gated.
			// Scaled by uIntro (the GLOBAL progress, not per-cell "arrived"): these two
			// layers are properties of the whole display rather than of any one dot, so
			// they come up with the picture as a whole. Without this the "empty" grid is
			// not actually empty — it is a striped, corner-darkened rectangle, which is
			// what a fully-suppressed wipe was still showing.
			if (uScanlines > 0.0) {
				float scan = 0.5 + 0.5 * sin(vUv.y * uResolution.y * 3.14159265);
				result *= 1.0 - uScanlines * uIntro * (1.0 - scan);
			}
			// Vignette: darken toward the frame corners. Branch-gated.
			if (uVignette > 0.0) {
				vec2 vg = vUv * (1.0 - vUv);
				float v = pow(clamp(vg.x * vg.y * 16.0, 0.0, 1.0), uVignette * 0.6);
				result *= mix(1.0, v, uVignette * uIntro);
			}

			fragColor = vec4(result, 1.0);
		}`;

		const program = this.buildProgram(vs, fs);
		if (!program) return false;
		this.program = program;

		// Fullscreen quad as a triangle strip.
		const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
		this.vao = gl.createVertexArray();
		this.buffer = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
		const aPos = gl.getAttribLocation(program, "aPos");
		gl.enableVertexAttribArray(aPos);
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const makeTexture = () => {
			const t = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			return t;
		};
		this.texture = makeTexture();
		// Second unit, holding the OUTGOING clip's last frame during a transition so
		// the shader can blend two sources per-cell instead of dipping the whole
		// stage's opacity. Allocated up front (a texture with no upload costs
		// nothing to keep) so a swap never has to create GL resources mid-frame.
		this.prevTexture = makeTexture();

		const names = [
			"uTex",
			"uResolution",
			"uVideoAspect",
			"uCell",
			"uDotScale",
			"uLevels",
			"uInvert",
			"uGamma",
			"uContrast",
			"uColor",
			"uBg",
			"uTrail",
			"uTrailAge",
			"uTrailCount",
			"uRevealRadius",
			"uTime",
			"uShimmer",
			"uRevealBoost",
			"uShape",
			"uBloom",
			"uScanlines",
			"uVignette",
			"uCrosshatch",
			"uIntro",
			"uIntroJitter",
			"uPrevTex",
			"uXfade",
			"uXfadeMode",
		];
		for (const n of names) this.uniforms[n] = gl.getUniformLocation(program, n);
		return true;
	}

	private buildProgram(vsSrc: string, fsSrc: string): WebGLProgram | null {
		const gl = this.gl;
		if (!gl) return null;
		const vs = this.compile(gl.VERTEX_SHADER, vsSrc);
		const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc);
		if (!vs || !fs) return null;
		const program = gl.createProgram();
		if (!program) return null;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.error("dotted-grid: program link failed:", gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return null;
		}
		return program;
	}

	private compile(type: number, src: string): WebGLShader | null {
		const gl = this.gl;
		if (!gl) return null;
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, src);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.error("dotted-grid: shader compile failed:", gl.getShaderInfoLog(shader));
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	// --- sizing & playback -------------------------------------------------

	/**
	 * Device-pixel ratio to render at, clamped so fill cost stays affordable while
	 * keeping the compositor's canvas→physical-pixel upscale at an INTEGER ratio.
	 *
	 * The dot grid is a regular lattice, so a non-integer upscale resamples it and
	 * the rows/columns beat against the physical pixel grid — visible plaid/moiré.
	 * A flat cap like 1.5 triggers exactly this on a DPR-2 phone (2/1.5 = 1.33x).
	 * So instead of capping to a fixed number, we render at devicePixelRatio
	 * divided by the smallest integer that brings it within MAX_DPR:
	 *   DPR 1 → 1 (1x),  DPR 2 → 2 (1x upscale),  DPR 3 → 1.5 (2x upscale, integer).
	 * Every result composites at a whole-number ratio, so the lattice stays crisp,
	 * and DPR-3 devices still save ~44% of the fragments vs rendering at 3x.
	 * Read fresh each time so the ResizeObserver re-evaluates it on rotation.
	 */
	private effectiveDpr(): number {
		const dpr = window.devicePixelRatio || 1;
		const divisor = Math.ceil(dpr / MAX_DPR); // 1 for dpr<=2, 2 for dpr in (2,4]
		return dpr / divisor;
	}

	private resize() {
		const gl = this.gl;
		const canvas = this.canvas;
		if (!gl || !canvas) return;
		const dpr = this.effectiveDpr();
		const w = Math.max(1, Math.round(this.clientWidth * dpr));
		const h = Math.max(1, Math.round(this.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		}
		this.scheduleRender();
	}

	/** Reconcile play/pause + the RAF loop with paused attr, motion pref, and
	 * visibility. Animating only runs when playing; otherwise we draw once. */
	/** True when the effect should animate: not paused, motion allowed, on-screen.
	 * Also gates the color reveal (off for the static/reduced-motion frame). */
	private wantsPlay(): boolean {
		return (
			!this.hasAttribute("paused") &&
			!this.reducedMotion?.matches &&
			this.visible
		);
	}

	private applyPlaybackState() {
		const video = this.video;
		if (!video) return;
		const wantPlay = this.wantsPlay();

		if (wantPlay) {
			video.play().catch(() => {
				/* autoplay may be blocked; the poster/first frame still shows */
			});
			this.startLoop();
		} else {
			video.pause();
			this.stopLoop();
			this.scheduleRender(); // keep the last/first frame painted
		}
	}

	private startLoop() {
		if (this.playing) return;
		this.playing = true;
		const video = this.video as HTMLVideoElement & {
			requestVideoFrameCallback?: (cb: () => void) => number;
		};
		if (video && typeof video.requestVideoFrameCallback === "function") {
			// rVFC path: fires once per decoded frame, so the shader tracks the
			// video's real cadence instead of the display refresh rate.
			this.useVfc = true;
			const tick = () => {
				if (!this.playing) return;
				this.frameHandle = video.requestVideoFrameCallback!(tick);
				this.render();
			};
			this.frameHandle = video.requestVideoFrameCallback(tick);
		} else {
			// Firefox fallback: display-synced rAF loop (the previous behavior).
			this.useVfc = false;
			const tick = () => {
				this.frameHandle = requestAnimationFrame(tick);
				this.render();
			};
			this.frameHandle = requestAnimationFrame(tick);
		}
	}

	private stopLoop() {
		if (this.frameHandle !== null) {
			const video = this.video as HTMLVideoElement & {
				cancelVideoFrameCallback?: (h: number) => void;
			};
			if (this.useVfc) video?.cancelVideoFrameCallback?.(this.frameHandle);
			else cancelAnimationFrame(this.frameHandle);
		}
		this.frameHandle = null;
		this.playing = false;
	}

	/** One-shot repaint (used when paused / on attr or size change). */
	private scheduleRender() {
		if (this.playing) return; // the loop is already painting
		if (this.rafId !== null) return; // a one-shot is already queued
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			if (!this.playing) this.render();
		});
	}

	// --- draw --------------------------------------------------------------

	private render() {
		const gl = this.gl;
		const video = this.video;
		if (!gl || !video || !this.program) return;

		// Upload the current video frame when one is available.
		if (video.readyState >= 2 /* HAVE_CURRENT_DATA */ && video.videoWidth > 0) {
			gl.bindTexture(gl.TEXTURE_2D, this.texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
			this.textureReady = true;
		}
		if (!this.textureReady) return; // nothing to show yet

		const dpr = this.effectiveDpr();
		const [r, g, b] = this.readColor("color", "--color-fg", [0.9, 0.9, 0.9]);
		const [br, bg, bb] = this.readColor("background", "--color-bg", [0, 0, 0]);
		const aspect = video.videoWidth / Math.max(1, video.videoHeight);

		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(this.uniforms.uTex, 0);
		// Unit 1 carries the outgoing clip's frozen frame during a transition. Bound
		// every draw (not just mid-transition) so the sampler always points at a real
		// texture — an unbound sampler2D is undefined behaviour on some drivers even
		// when the branch that reads it is skipped.
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.prevTexture);
		gl.uniform1i(this.uniforms.uPrevTex, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform2f(this.uniforms.uResolution, gl.canvas.width, gl.canvas.height);
		gl.uniform1f(this.uniforms.uVideoAspect, aspect);
		gl.uniform1f(this.uniforms.uCell, this.num("cell-size", DEFAULTS.cellSize) * dpr);
		gl.uniform1f(this.uniforms.uDotScale, this.num("dot-scale", DEFAULTS.dotScale));
		gl.uniform1f(this.uniforms.uLevels, this.num("levels", DEFAULTS.levels));
		gl.uniform1f(this.uniforms.uInvert, this.hasAttribute("invert") ? 1 : 0);
		gl.uniform1f(this.uniforms.uGamma, this.num("gamma", DEFAULTS.gamma));
		gl.uniform1f(this.uniforms.uContrast, this.num("contrast", DEFAULTS.contrast));
		gl.uniform3f(this.uniforms.uColor, r, g, b);
		gl.uniform3f(this.uniforms.uBg, br, bg, bb);
		gl.uniform1f(this.uniforms.uShape, this.shape());
		gl.uniform1f(this.uniforms.uBloom, this.numZero("bloom", DEFAULTS.bloom));
		gl.uniform1f(this.uniforms.uScanlines, this.numZero("scanlines", DEFAULTS.scanlines));
		gl.uniform1f(this.uniforms.uVignette, this.numZero("vignette", DEFAULTS.vignette));
		gl.uniform1f(this.uniforms.uCrosshatch, this.numZero("crosshatch", DEFAULTS.crosshatch));

		// Intro wipe. Read BEFORE the draw so this frame paints the current progress,
		// and note it must be sampled every frame while running — see the pump in
		// announceReady() that keeps frames coming even when the video is paused.
		const intro = this.introProgress();
		gl.uniform1f(this.uniforms.uIntro, intro);
		gl.uniform1f(
			this.uniforms.uIntroJitter,
			this.num("intro-jitter", DEFAULTS.introJitter)
		);

		// Clip transition, same contract as the intro: read before the draw, and keep
		// frames coming while it runs (see the pump below).
		const xfade = this.xfadeProgress();
		gl.uniform1f(this.uniforms.uXfade, xfade);
		gl.uniform1f(this.uniforms.uXfadeMode, this.xfadeMode());

		// LIVE OUTGOING CLIP. Re-upload the old buffer's CURRENT frame every frame of
		// the transition, so the clip being replaced keeps moving while it is blended
		// out — the whole point of xfade-live. (The frozen path uploaded once, at
		// beginTransition, and this block is skipped.)
		const prevVideo = this.prevVideo;
		if (
			xfade < 1 &&
			prevVideo &&
			prevVideo.readyState >= 2 &&
			prevVideo.videoWidth > 0
		) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.prevTexture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prevVideo);
			gl.activeTexture(gl.TEXTURE0);
		}

		this.uploadReveal(gl, dpr);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);

		// Keep the wipe animating while it runs. The rAF/rVFC loop only runs when the
		// video is PLAYING, so a paused or reduced-motion-static grid would otherwise
		// freeze the wipe at whatever progress its single one-shot paint captured.
		if (intro < 1 || xfade < 1) this.scheduleRender();

		// The canvas now holds real pixels. Announce AFTER the draw (not when
		// textureReady flips above): the CSS fade is keyed off this, and starting it
		// a frame early would fade in an empty canvas.
		this.announceReady();
	}

	/**
	 * Publish "there is something to look at" — once per element. Sets a
	 * `data-ready` marker (styles.css fades the canvas in on it, and it lets an
	 * observer that arrives late detect the state it missed) and dispatches a
	 * bubbling `dotted-grid:ready`, matching the `dotted-grid:ended` idiom.
	 *
	 * Also called on the paths where there will never BE a frame — no WebGL2, or a
	 * shader that failed to compile — because a consumer waiting on this event must
	 * not be left waiting forever by a browser that simply can't render the effect.
	 */
	private announceReady() {
		if (this.announcedReady) return;
		this.announcedReady = true;
		// Start the intro wipe from the moment there is actually an image to develop,
		// so a slow video delays the animation rather than consuming it.
		if (this.introStart === null) this.introStart = performance.now();
		this.dataset.ready = "true";
		this.dispatchEvent(new CustomEvent("dotted-grid:ready", { bubbles: true }));
	}

	// --- color reveal ------------------------------------------------------

	/** Record a pointer position (device px, canvas-relative) for the trail. */
	private pushTrail(e: PointerEvent) {
		const canvas = this.canvas;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const scaleX = canvas.width / Math.max(1, rect.width);
		const scaleY = canvas.height / Math.max(1, rect.height);
		this.trail.push({
			x: (e.clientX - rect.left) * scaleX,
			y: (e.clientY - rect.top) * scaleY,
			t: performance.now(),
		});
		if (this.trail.length > MAX_TRAIL) {
			this.trail.splice(0, this.trail.length - MAX_TRAIL);
		}
	}

	/** Upload the trail + shimmer uniforms. Both are silenced while not playing
	 * (paused / reduced-motion) so the static frame stays flat-colored. */
	private uploadReveal(gl: WebGL2RenderingContext, dpr: number) {
		const revealOn = this.hasAttribute("color-reveal") && this.wantsPlay();
		const now = performance.now();

		let count = 0;
		if (revealOn) {
			// Drop expired samples, then take the newest MAX_TRAIL, newest first.
			this.trail = this.trail.filter((s) => now - s.t <= TRAIL_MS);
			const start = Math.max(0, this.trail.length - MAX_TRAIL);
			for (let i = this.trail.length - 1; i >= start; i--) {
				const s = this.trail[i];
				this.trailXY[count * 2] = s.x;
				this.trailXY[count * 2 + 1] = s.y;
				this.trailAge[count] = (now - s.t) / TRAIL_MS; // 0 newest .. 1 oldest
				count++;
			}
		}
		gl.uniform2fv(this.uniforms.uTrail, this.trailXY);
		gl.uniform1fv(this.uniforms.uTrailAge, this.trailAge);
		gl.uniform1i(this.uniforms.uTrailCount, count);
		gl.uniform1f(
			this.uniforms.uRevealRadius,
			this.num("color-reveal", DEFAULTS.colorReveal) * dpr
		);

		const shimmerOn = this.hasAttribute("shimmer") && this.wantsPlay();
		const shimmer = shimmerOn
			? Math.min(1, this.num("shimmer", DEFAULTS.shimmer) / 100)
			: 0;
		gl.uniform1f(this.uniforms.uShimmer, shimmer);
		gl.uniform1f(this.uniforms.uTime, now / 1000);
		gl.uniform1f(
			this.uniforms.uRevealBoost,
			Math.min(1, this.numZero("reveal-boost", DEFAULTS.revealBoost))
		);
	}

	// --- attribute helpers -------------------------------------------------

	private resolveSrc(): string {
		return this.getAttribute("src") || "";
	}

	/** Resolve `dot-shape` to its shader enum (0 square / 1 circle / 2 morph).
	 * Accepts the named strings or a raw 0/1/2 (the playground slider). */
	private shape(): number {
		const raw = this.getAttribute("dot-shape");
		if (raw === null) return DEFAULTS.dotShape;
		const named = DOT_SHAPES[raw.trim().toLowerCase()];
		if (named !== undefined) return named;
		const n = Number.parseFloat(raw);
		return Number.isFinite(n) ? Math.min(2, Math.max(0, Math.round(n))) : DEFAULTS.dotShape;
	}

	/**
	 * Start a clip transition against `outgoing`, at the swap's promote step — the one
	 * instant where both buffers coexist.
	 *
	 * Returns true when the outgoing buffer must be KEPT ALIVE for a live blend, in
	 * which case the caller must not retire it (endTransition does, later). Returns
	 * false for the frozen-frame path and for every bail-out, so the caller retires
	 * it immediately as before.
	 *
	 * Bails (leaving xfadeHasPrev false, so xfadeProgress reports idle and the swap is
	 * a plain cut) when there is no `xfade`, no GL, or the outgoing buffer has no
	 * decodable frame — better a cut than a blend against black.
	 */
	private beginTransition(outgoing: HTMLVideoElement | null): boolean {
		const gl = this.gl;
		if (!gl || !this.prevTexture) return false;
		if (!this.hasAttribute("xfade") || this.reducedMotion?.matches) return false;
		if (!outgoing || outgoing.readyState < 2 || outgoing.videoWidth === 0) return false;

		// Upload the outgoing frame once up front either way: the live path needs a
		// valid second source on THIS frame too (its per-frame re-upload happens in
		// render), and the frozen path needs exactly this one still.
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.prevTexture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, outgoing);
		gl.activeTexture(gl.TEXTURE0);
		this.xfadeHasPrev = true;
		this.xfadeStart = performance.now();

		if (!this.hasAttribute("xfade-live")) return false;

		// Live blend: hold on to the buffer and keep it playing so its motion carries
		// through the transition. It is already unmuted-safe (muted at creation) and
		// off-screen (1x1, opacity 0) per the package's stylesheet.
		this.prevVideo = outgoing;
		outgoing.play().catch(() => {
			/* a paused tail still blends — it just stops moving */
		});
		return true;
	}

	/** Retire the outgoing buffer once a live transition has finished. */
	private endTransition() {
		if (this.prevVideo) {
			this.retireVideo(this.prevVideo);
			this.prevVideo = null;
		}
		this.xfadeHasPrev = false;
		this.xfadeStart = null;
	}

	/** Resolve `xfade-mode` (a name or a number) to the shader's enum. */
	private xfadeMode(): number {
		const raw = this.getAttribute("xfade-mode");
		if (raw === null) return TRANSITIONS.threshold;
		const named = TRANSITIONS[raw.trim().toLowerCase()];
		if (named !== undefined) return named;
		const n = Number.parseFloat(raw);
		// Upper bound derived from the table, not hardcoded — a mode added there would
		// otherwise be silently clamped away when driven by number.
		const max = Math.max(...Object.values(TRANSITIONS));
		return Number.isFinite(n)
			? Math.min(max, Math.max(0, Math.round(n)))
			: TRANSITIONS.threshold;
	}

	/**
	 * Clip-transition progress in [0,1]: 0 = fully the outgoing clip, 1 = fully the
	 * incoming one (and the idle state, which the shader skips).
	 *
	 * Returns 1 unless a transition is actually running — no `xfade` attribute, no
	 * captured outgoing frame, or reduced motion all mean "just cut", which is the
	 * pre-existing behaviour.
	 */
	private xfadeProgress(): number {
		if (!this.hasAttribute("xfade")) return 1;
		if (this.reducedMotion?.matches) return 1;
		if (this.xfadeStart === null || !this.xfadeHasPrev) return 1;
		const ms = Math.max(1, this.num("xfade", DEFAULTS.xfadeMs));
		const t = (performance.now() - this.xfadeStart) / ms;
		if (t >= 1) {
			// Latch idle so the shader branch and the per-frame pump both switch off,
			// and release the outgoing buffer if the live path was holding one.
			this.endTransition();
			return 1;
		}
		return t * (2 - t); // easeOutQuad, matching the intro wipe
	}

	private num(attr: string, fallback: number): number {
		const raw = this.getAttribute(attr);
		if (raw === null) return fallback;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	}

	/** Like num() but allows 0 (and clamps negatives to 0). Used for levers where
	 * zero is a valid setting, e.g. reveal-boost=0 (raw color, no ANSI snap). */
	private numZero(attr: string, fallback: number): number {
		const raw = this.getAttribute(attr);
		if (raw === null) return fallback;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
	}

	/**
	 * Resolve a color to normalized RGB. Uses the attribute if set, else the
	 * given CSS custom property from the cascade, else the hard fallback. Parsed
	 * by round-tripping through the canvas 2D context so any CSS color works.
	 */
	private readColor(
		attr: string,
		cssVar: string,
		fallback: [number, number, number]
	): [number, number, number] {
		let value = this.getAttribute(attr)?.trim();
		if (!value) {
			value = getComputedStyle(this).getPropertyValue(cssVar).trim();
		}
		if (!value) return fallback;
		const rgb = parseCssColor(value);
		return rgb ?? fallback;
	}
}

// Shared 2D context for color parsing (created lazily, reused).
let colorCtx: CanvasRenderingContext2D | null = null;
function parseCssColor(value: string): [number, number, number] | null {
	if (!colorCtx) {
		const c = document.createElement("canvas");
		c.width = c.height = 1;
		colorCtx = c.getContext("2d", { willReadFrequently: true });
	}
	if (!colorCtx) return null;
	colorCtx.clearRect(0, 0, 1, 1);
	colorCtx.fillStyle = "#000";
	colorCtx.fillStyle = value; // invalid values are ignored, leaving #000
	colorCtx.fillRect(0, 0, 1, 1);
	const [r, g, b] = colorCtx.getImageData(0, 0, 1, 1).data;
	return [r / 255, g / 255, b / 255];
}

if (typeof customElements !== "undefined" && !customElements.get("dotted-grid")) {
	customElements.define("dotted-grid", DottedGridElement);
}
