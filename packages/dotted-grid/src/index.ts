import { FRAGMENT_SHADER, MAX_TRAIL, VERTEX_SHADER } from "./shader";
import { readNumber, resolveTone, TONE_ATTRS, toneEquals, type RGB, type Tone } from "./tone";

export { resolveTone, TONE_DEFAULTS, type Tone } from "./tone";

// Non-tone defaults. The tone (colours, polarity, gamma, cutoff, ...) has its
// own, in tone.ts, because it resolves through CSS variables as well.
const DEFAULTS = {
	cellSize: 6, // CSS px per grid cell (drives dot density)
	colorReveal: 80, // pointer trail radius (CSS px) when `color-reveal` is empty
	shimmer: 8, // percent of dots that flash when `shimmer` is empty
	revealBoost: 0.3, // vividness of revealed color: 0 = raw sample, 1 = "ascii" pop
	// --- intro wipe (the fullest dots first) ---
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

const MAX_DPR = 2; // default clamp on devicePixelRatio; per-instance via `max-dpr`
const TRAIL_MS = 600; // trail lifetime — longer than fade-in so dots trail out slowly

/**
 * THEME FLIPS. One observer for every live element, on <html>'s class,
 * data-theme and style: whatever a theme toggle changes there, the tone
 * variables may have changed with it. Each element re-resolves its tone and
 * repaints only if something it uses actually moved. Repainting covers paused
 * and reduced-motion elements, which have no running loop to pick the change up.
 *
 * Most class changes there are not the theme: Lenis toggles `lenis-scrolling`
 * / `lenis-smooth` on <html> at every scroll start and stop, and re-resolving a
 * tone costs a style recalc plus canvas readbacks per element. So the pass
 * first compares a key of the three values (Lenis's classes stripped) against
 * the last one, a few string reads, and does nothing when it has not moved.
 *
 * Coalesced to one pass per frame: a toggle that swaps a class AND an
 * attribute fires twice, and the second read would see the same values.
 */
const live = new Set<DottedGridElement>();
let themeObserver: MutationObserver | null = null;
let themePending = false;
let themeKey = "";
const SCROLL_STATE_CLASS = /^lenis(-|$)/;
function readThemeKey(): string {
	const html = document.documentElement;
	const classes = Array.from(html.classList)
		.filter((c) => !SCROLL_STATE_CLASS.test(c))
		.join(" ");
	return `${html.getAttribute("data-theme") ?? ""}|${html.getAttribute("style") ?? ""}|${classes}`;
}
function watchTheme(el: DottedGridElement) {
	live.add(el);
	if (themeObserver || typeof MutationObserver === "undefined") return;
	themeKey = readThemeKey();
	themeObserver = new MutationObserver(() => {
		if (themePending) return;
		themePending = true;
		requestAnimationFrame(() => {
			themePending = false;
			const key = readThemeKey();
			if (key === themeKey) return;
			themeKey = key;
			for (const g of live) g.refreshTone();
		});
	});
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-theme", "style"],
	});
}
function unwatchTheme(el: DottedGridElement) {
	live.delete(el);
	if (live.size === 0 && themeObserver) {
		themeObserver.disconnect();
		themeObserver = null;
	}
}

/** Dev builds only: name a CSS variable that is set but does not parse (once). */
const warned = new Set<string>();
const devWarn: ((message: string) => void) | undefined = (
	import.meta as ImportMeta & { env?: { DEV?: boolean } }
).env?.DEV
	? (message) => {
			if (warned.has(message)) return;
			warned.add(message);
			console.warn(message);
		}
	: undefined;

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
 *
 * TONE. Each of these also reads a CSS custom property, `--dg-<name>` (e.g.
 * `--dg-gamma`), so a stylesheet can tune the grid per theme; see tone.ts.
 * Precedence is attribute, then variable, then default, and the attribute
 * ALWAYS wins: leave one on the element and a theme preset for the same setting
 * silently does nothing. They are resolved once and cached (re-read when an
 * attribute changes, when <html>'s class / data-theme / style changes, or on
 * refreshTone()), never per frame.
 *   ink           dot colour (default: CSS --color-fg)
 *   ink-hi        the fullest dot's colour; dots blend ink -> ink-hi with their
 *                 size, a duotone. Unset => a flat ink.
 *   paper         backdrop colour (default: CSS --color-bg)
 *   glow          colour the highlight lift, bloom and hatch lean toward, or
 *                 `auto` (default): black on a light paper, white on a dark one.
 *   polarity      `positive` (default; dots on the highlights, bright = big) or
 *                 `negative` (dots on the shadows). Polarity is not colour: to
 *                 "invert black and white" flip this OR swap ink and paper; to
 *                 "invert to a colour" set ink / ink-hi to it.
 *   dot-scale     max square half-width as fraction of cell half-size (default 1;
 *                 1 fills the cell so the brightest level is a solid block)
 *   levels        discrete brightness steps for an ASCII-ramp look (default 5);
 *                 each step is a fixed square size, brightest fills the cell.
 *                 Set to 1 (or 0) for a smooth, continuous size ramp.
 *   cutoff        0..1 black point for the DOT ITSELF: any cell whose shaped
 *                 brightness lands at or below it draws nothing, leaving bare
 *                 background instead of a minimum-size dot (default 0). Applied
 *                 after `levels`, so it reads as "drop the bottom rungs of the
 *                 ramp": with levels=5, 0.2 empties the dimmest rung, 0.4 the
 *                 dimmest two. Lets shadows go genuinely empty so the grid reads
 *                 as sparse constellation rather than an even field of specks.
 *                 A cut-off cell is off ENTIRELY — the crosshatch engraving is
 *                 suppressed there too, since that layer keys on low brightness and
 *                 would otherwise come up to full strength in precisely the cells
 *                 this emptied, trading a field of faint dots for a field of faint
 *                 hatch marks. `crosshatch` still shades the dim-but-surviving
 *                 cells above the cutoff.
 *   feather       0..1; width, in brightness units, of a dissolve band directly
 *                 above `cutoff` (default 0 = the cutoff is a hard edge). Dots in
 *                 the band shrink continuously to nothing instead of the ramp's
 *                 lowest rung popping in at full size, so the field fades out rather
 *                 than ending at a contour. Measured against the UN-quantized
 *                 brightness, so it is unaffected by `levels`; every other layer
 *                 (the crosshatch) fades with it. Works with `cutoff` at 0, where the
 *                 band is simply 0..feather.
 *   denoise       0..1; read each cell as the AVERAGE of its own footprint (5 taps)
 *                 instead of one texel at its centre (default 0 = point sample).
 *                 Video sources carry codec noise and macroblock structure that a
 *                 point-sampled halftone turns into salt-and-pepper strays and a
 *                 dithered edge along a contour — worst with a low `gamma` (whose
 *                 slope near black magnifies a 1/255 wobble) or alongside `cutoff`
 *                 (which turns that wobble into presence or absence). Costs 4 extra
 *                 texture reads per fragment, all cache-friendly (every fragment in
 *                 a cell reads the same texels), so it is opt-in per consumer rather
 *                 than always on. 1 is the full average; values between keep some grain.
 *   gamma         luminance exponent (default 0.8)
 *   contrast      luminance contrast (default 1.1)
 *   dot-shape     dot silhouette: `square` (legacy per-axis box), `circle`, or
 *                 `morph` (default) — small/dim dots read as circles, the brightest
 *                 morph to rounded squares, echoing a phosphor dot-matrix display.
 *                 A numeric 0/1/2 works too (for the live playground slider).
 *   bloom         0..1; glow halo + phosphor rim on the brightest dots (default
 *                 0.55). 0 disables it and falls back to the subtle highlight-lift.
 *   crosshatch    0..1; cross-hatch engraving marks in the darkest cells, denser as
 *                 brightness falls (default 0.35). 0 => off.
 *
 * EVERYTHING ELSE (attributes only):
 *   paused        boolean; freezes the animation
 *   rate          playback speed multiplier for the video (default 1). <1 slows the
 *                 scene down, >1 speeds it up; clamped to the range browsers
 *                 accept (0.0625..16). Applies to BOTH buffers, so a clip swap
 *                 keeps the same tempo. Cheaper than re-encoding the source at a
 *                 lower frame rate, and the halftone follows the video's real
 *                 cadence (rVFC), so a slow rate simply means fewer redraws.
 *   color-reveal  pointer trail radius in CSS px; dots within it show the video's
 *                 true color, fading in fast and out slow (comet trail). Absent
 *                 => no trail; empty => default radius.
 *   shimmer       percent (0-100) of dots that spontaneously flash to their true
 *                 color and fade, for ambient life. Absent => off; empty => default.
 *   reveal-boost  0..1; how far a revealed dot's color snaps to the nearest vivid
 *                 ANSI terminal color (default 0.3). 0 = raw sampled color; 1 = full
 *                 "ascii" pop so reveals stay vivid over a dark video. On a light
 *                 paper the palette is pulled part-way toward the ink so a reveal
 *                 does not wash out into the page.
 *   no-loop       boolean; plays the video once instead of looping. On the final
 *                 frame it dispatches a bubbling `dotted-grid:ended` CustomEvent so
 *                 a host (e.g. a carousel) can advance. Absent => loops (default).
 *   intro         boolean-or-ms; develop the picture in ONCE on arrival, fullest
 *                 dots first (the ink side, whichever the polarity). Each cell's dot grows from nothing to its true size as
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
 *                 empty => default 1600ms. Skipped under prefers-reduced-motion, and
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
 * Lifecycle mirrors the other packages (video-carousel): a `listeners`
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
			...TONE_ATTRS,
			"paused",
			"rate",
			"color-reveal",
			"shimmer",
			"reveal-boost",
			"no-loop",
			"intro",
			"intro-delay",
			"intro-jitter",
			"xfade",
			"xfade-mode",
			"xfade-live",
			"max-dpr",
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
	/** Set by cutNext(): make the next swap a hard cut instead of a transition, then
	 *  clear. Lets a host distinguish an automatic advance (transition) from one the
	 *  visitor asked for (cut). */
	private skipNextXfade = false;
	/**
	 * Buffers whose "I am nearly over" signal has already been sent. The advance
	 * fires EARLY (see maybeAnnounceEnding), so the clip's own later `ended` must be
	 * swallowed or the carousel would step twice for one clip.
	 */
	private endingAnnounced = new WeakSet<HTMLVideoElement>();
	private uniforms: Record<string, WebGLUniformLocation | null> = {};

	/**
	 * THE RESOLVED TONE (colours, polarity, the shaping numbers), cached across
	 * frames. See tone.ts.
	 *
	 * Resolving it is not cheap: the values come from CSS custom properties, so it
	 * costs a getComputedStyle() — which forces a style recalc — and each colour a
	 * round-trip through a 2D canvas ending in getImageData(): a synchronous
	 * readback. All for values that only change when the theme flips.
	 *
	 * Measured on the hero when only the two colours were read per frame: 22-28% of
	 * the element's per-frame main thread cost, and because a style recalc is only
	 * forced when styles are already dirty, the spike lands exactly where it hurts —
	 * p95 of a single call reached 1.0ms during scroll, against a 0.13ms average.
	 *
	 * null means "not resolved yet". Every path that can change the answer clears
	 * it: a tone attribute changing, <html>'s class / data-theme / style changing
	 * (the module's MutationObserver), an OS-level colour-scheme flip,
	 * refreshTone(), and connectedCallback (a view transition swaps the element
	 * into a fresh document).
	 */
	private tone: Tone | null = null;

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
		// A view transition can re-insert a PERSISTED element into a freshly built
		// document, so nothing resolved against the old one survives into this life.
		this.tone = null;
		this.reflectPaper();

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

		// Re-resolve the tone when the page theme flips: the module observer on
		// <html> (see watchTheme), plus an OS-level colour-scheme flip, which moves
		// prefers-color-scheme tokens without touching <html> at all.
		watchTheme(this);
		this.listeners.push(() => unwatchTheme(this));
		const onScheme = () => this.refreshTone();
		const scheme = matchMedia("(prefers-color-scheme: dark)");
		scheme.addEventListener("change", onScheme);
		this.listeners.push(() => scheme.removeEventListener("change", onScheme));

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
		if (name === "paper") this.reflectPaper();
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
		if (name === "rate") {
			this.applyPlaybackRate();
			return;
		}
		if (name === "no-loop" && this.video) {
			this.video.loop = !this.hasAttribute("no-loop");
			return;
		}
		// The cap changes the drawing buffer's size, which a repaint alone won't do.
		if (name === "max-dpr") {
			this.resize();
			return;
		}
		// A tone attribute: drop the cached tone so the next draw re-resolves it.
		if (TONE_ATTRS.includes(name)) this.tone = null;
		// Everything else is read fresh each draw, so just repaint the frame.
		this.scheduleRender();
	}

	/**
	 * Re-read the tone (attributes and --dg-* variables) and repaint if it moved.
	 *
	 * Called for you when <html>'s class, data-theme or style changes, and on an
	 * OS colour-scheme flip. Call it yourself after changing a --dg-* variable
	 * anywhere else (on an ancestor's style, say): nothing observes those.
	 */
	refreshTone() {
		if (!this.gl) return;
		const next = this.resolveTone();
		if (toneEquals(this.tone, next)) return;
		this.tone = next;
		this.scheduleRender();
	}

	/**
	 * Mirror a valid `paper` attribute onto the host's --dg-paper, so the box's
	 * pre-frame background (styles.css) is the paper the shader will paint, in
	 * the same order resolveTone reads it: attribute, --dg-paper, --color-bg.
	 * Removed again only if it was this that set it.
	 */
	private reflectedPaper = false;
	private reflectPaper() {
		const paper = this.getAttribute("paper")?.trim();
		if (paper && CSS.supports("color", paper)) {
			this.style.setProperty("--dg-paper", paper);
			this.reflectedPaper = true;
		} else if (this.reflectedPaper) {
			this.style.removeProperty("--dg-paper");
			this.reflectedPaper = false;
		}
	}

	private resolveTone(): Tone {
		const style = getComputedStyle(this);
		return resolveTone(
			(n) => this.getAttribute(n),
			(n) => style.getPropertyValue(n),
			parseCssColor,
			devWarn
		);
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

	/**
	 * Suppress the `xfade` transition for the NEXT source swap only, so it cuts
	 * straight to the incoming clip.
	 *
	 * For a host whose change was explicitly REQUESTED rather than automatic: a
	 * transition blends out of the outgoing clip, so a visitor who picks a clip would
	 * see the one they just left play on and then dissolve away. Cutting makes the
	 * pick land where they aimed. One-shot — the flag is consumed by that swap, so
	 * autoplay's own advances keep their transition.
	 */
	cutNext() {
		this.skipNextXfade = true;
	}

	// --- setup -------------------------------------------------------------

	private createVideo(): HTMLVideoElement {
		const video = document.createElement("video");
		video.muted = true;
		video.defaultMuted = true;
		video.loop = !this.hasAttribute("no-loop");
		video.playsInline = true;
		video.autoplay = true;
		video.playbackRate = this.playbackRate();
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
		const onData = () => {
			video.playbackRate = this.playbackRate();
			this.scheduleRender();
		};
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
		// zero allowed: an explicit intro-delay="0" must mean "start immediately"
		// rather than falling back to the default. Negatives read as 0.
		const elapsed = performance.now() - this.introStart;
		const delay = this.num("intro-delay", DEFAULTS.introDelayMs, true);
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

		const program = this.buildProgram(VERTEX_SHADER, FRAGMENT_SHADER);
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
			"uCutoff",
			"uDenoise",
			"uFeather",
			"uPolarity",
			"uGamma",
			"uContrast",
			"uInk",
			"uInkHi",
			"uPaper",
			"uGlow",
			"uPaletteMix",
			"uTrail",
			"uTrailAge",
			"uTrailCount",
			"uRevealRadius",
			"uTime",
			"uShimmer",
			"uRevealBoost",
			"uShape",
			"uBloom",
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
	 *
	 * THE CAP IS PER-INSTANCE (`max-dpr`), because the cost is per-PIXEL and the
	 * instances differ by an order of magnitude in size. A full-bleed hero canvas is
	 * ~1.3 Mpx at DPR 2 on a phone; the footer widget's card is a fraction of that.
	 * Measured on the mobile hero at 8x CPU throttle, scrolling: 1.32 Mpx cost a 46.6ms
	 * median frame, 0.33 Mpx cost 11.8ms — the canvas was ~76% of the whole frame, and
	 * it scales with area almost exactly. So the big one takes `max-dpr="1"` and the
	 * small one keeps the default.
	 * Lowering the cap does NOT reintroduce the moiré this method exists to avoid: the
	 * integer-upscale property holds at any integer cap, because the divisor is still a
	 * ceiling. DPR 2 with cap 1 → render at 1, composite at 2x; DPR 3 → 1 at 3x. It is
	 * a FRACTIONAL cap (1.5) that beats against the lattice, which is why this takes a
	 * divisor rather than a Math.min. */
	private effectiveDpr(): number {
		const dpr = window.devicePixelRatio || 1;
		const cap = this.num("max-dpr", MAX_DPR);
		const divisor = Math.ceil(dpr / cap); // 1 for dpr<=cap, 2 for dpr in (cap, 2cap]
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

	/** The `rate` attribute, clamped to what HTMLMediaElement.playbackRate accepts.
	 * Outside 0.0625..16 browsers throw or silently ignore the assignment. */
	private playbackRate(): number {
		return Math.min(16, Math.max(0.0625, this.num("rate", 1)));
	}

	/** Push the current `rate` onto both buffers, so a clip swap mid-transition
	 * doesn't hand the scene back at 1x. */
	private applyPlaybackRate() {
		const rate = this.playbackRate();
		if (this.video) this.video.playbackRate = rate;
		if (this.nextVideo) this.nextVideo.playbackRate = rate;
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
		if (this.upload(gl.TEXTURE0, this.texture, video)) this.textureReady = true;
		if (!this.textureReady) return; // nothing to show yet

		const dpr = this.effectiveDpr();
		if (!this.tone) this.tone = this.resolveTone();
		const tone = this.tone;
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
		gl.uniform1f(this.uniforms.uDotScale, tone.dotScale);
		gl.uniform1f(this.uniforms.uLevels, tone.levels);
		gl.uniform1f(this.uniforms.uCutoff, tone.cutoff);
		gl.uniform1f(this.uniforms.uDenoise, tone.denoise);
		gl.uniform1f(this.uniforms.uFeather, tone.feather);
		gl.uniform1f(this.uniforms.uPolarity, tone.polarity);
		gl.uniform1f(this.uniforms.uGamma, tone.gamma);
		gl.uniform1f(this.uniforms.uContrast, tone.contrast);
		gl.uniform3fv(this.uniforms.uInk, tone.ink);
		gl.uniform3fv(this.uniforms.uInkHi, tone.inkHi);
		gl.uniform3fv(this.uniforms.uPaper, tone.paper);
		gl.uniform3fv(this.uniforms.uGlow, tone.glow);
		gl.uniform1f(this.uniforms.uPaletteMix, tone.paletteMix);
		gl.uniform1f(this.uniforms.uShape, tone.dotShape);
		gl.uniform1f(this.uniforms.uBloom, tone.bloom);
		gl.uniform1f(this.uniforms.uCrosshatch, tone.crosshatch);

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
		if (xfade < 1 && this.prevVideo) {
			this.upload(gl.TEXTURE1, this.prevTexture, this.prevVideo);
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
	 * Upload a video's current frame into `texture` on texture `unit`, leaving
	 * unit 0 active afterwards. Returns false (and touches nothing) when the
	 * video has no decodable frame yet. The one place frames reach the GPU: the
	 * live clip each draw, the outgoing clip during a live transition, and the
	 * outgoing clip's still at the start of a frozen one.
	 */
	private upload(unit: number, texture: WebGLTexture | null, video: HTMLVideoElement): boolean {
		const gl = this.gl;
		if (!gl || !texture) return false;
		if (video.readyState < 2 /* HAVE_CURRENT_DATA */ || video.videoWidth === 0) return false;
		gl.activeTexture(unit);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
		gl.activeTexture(gl.TEXTURE0);
		return true;
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
			Math.min(1, this.num("reveal-boost", DEFAULTS.revealBoost, true))
		);
	}

	// --- attribute helpers -------------------------------------------------

	private resolveSrc(): string {
		return this.getAttribute("src") || "";
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
		// Consume the one-shot cut request FIRST, and unconditionally: if it only
		// cleared on the paths that go on to transition, a cut requested while (say)
		// reduced motion was on would linger and swallow a later real transition.
		const cut = this.skipNextXfade;
		this.skipNextXfade = false;

		if (cut) {
			// End any transition still in flight before cutting. A visitor can pick a new
			// clip mid-blend (a fast scrub through the ruler does it constantly), and the
			// buffer that blend was reading is about to be retired — leaving it running
			// would blend the new clip against a dead texture.
			this.endTransition();
			return false;
		}

		if (!gl || !this.prevTexture) return false;
		if (!this.hasAttribute("xfade") || this.reducedMotion?.matches) return false;
		// Upload the outgoing frame once up front either way: the live path needs a
		// valid second source on THIS frame too (its per-frame re-upload happens in
		// render), and the frozen path needs exactly this one still. No frame to
		// upload means no transition.
		if (!outgoing || !this.upload(gl.TEXTURE1, this.prevTexture, outgoing)) return false;
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

	/**
	 * A numeric (non-tone) attribute, else `fallback`. By default it must be
	 * positive (0 falls back); with `zero` it may be 0 and negatives read as 0,
	 * for levers where 0 is a real setting (intro-delay="0", reveal-boost="0").
	 */
	private num(attr: string, fallback: number, zero = false): number {
		const opts = zero ? { min: 0, clamp: true } : { min: 0, exclusiveMin: true };
		return readNumber(this.getAttribute(attr), opts) ?? fallback;
	}
}

// Shared 2D context for color parsing (created lazily, reused). Any CSS colour
// syntax works, by round-tripping it through a 1px fill.
let colorCtx: CanvasRenderingContext2D | null = null;
function parseCssColor(value: string): RGB | null {
	// A canvas silently ignores an invalid fillStyle, which would read back as
	// black; reject it up front so a typo falls back instead of painting black.
	if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("color", value)) {
		return null;
	}
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
