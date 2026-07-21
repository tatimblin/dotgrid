const DEFAULTS = {
	cellSize: 6, // CSS px per grid cell (drives dot density)
	dotScale: 0.85, // max dot radius as a fraction of the cell half-size
	gamma: 0.8, // luminance shaping exponent (>1 darkens mids)
	contrast: 1.1, // luminance contrast around 0.5
	color: "", // dot color; empty => read --color-fg
	background: "", // backdrop color; empty => read --color-bg
	colorReveal: 120, // pointer trail radius (CSS px) when `color-reveal` is empty
	shimmer: 8, // percent of dots that flash when `shimmer` is empty
	revealBoost: 1, // vividness of revealed color: 0 = raw sample, 1 = "ascii" pop
} as const;

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
 *   src           video URL (required)
 *   cell-size     grid cell size in CSS px (default 6)
 *   dot-scale     max dot radius as fraction of cell half-size (default 0.85)
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
 *
 * The color reveal (trail + shimmer) is disabled while paused or under
 * prefers-reduced-motion, matching the animation gating.
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
			"cell-size",
			"dot-scale",
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
		];
	}

	private canvas: HTMLCanvasElement | null = null;
	private video: HTMLVideoElement | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private program: WebGLProgram | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private buffer: WebGLBuffer | null = null;
	private texture: WebGLTexture | null = null;
	private uniforms: Record<string, WebGLUniformLocation | null> = {};

	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private reducedMotion: MediaQueryList | null = null;
	private listeners: Array<() => void> = [];
	private rafId: number | null = null;

	private visible = true; // in viewport (IntersectionObserver)
	private textureReady = false; // has at least one frame been uploaded

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
		// page still looks intentional rather than broken.
		if (!gl) return;
		this.gl = gl;

		if (!this.initGL()) return;

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
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;

		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;

		this.listeners.forEach((off) => off());
		this.listeners = [];
		this.trail = [];

		if (this.video) {
			this.video.pause();
			this.video.removeAttribute("src");
			this.video.load(); // release the decoded resource
			this.video.remove();
			this.video = null;
		}

		const gl = this.gl;
		if (gl) {
			if (this.texture) gl.deleteTexture(this.texture);
			if (this.buffer) gl.deleteBuffer(this.buffer);
			if (this.vao) gl.deleteVertexArray(this.vao);
			if (this.program) gl.deleteProgram(this.program);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		}
		this.texture = null;
		this.buffer = null;
		this.vao = null;
		this.program = null;
		this.uniforms = {};
		this.gl = null;
		this.textureReady = false;

		this.canvas?.remove();
		this.canvas = null;
	}

	attributeChangedCallback(name: string, oldValue: string, newValue: string) {
		if (oldValue === newValue) return;
		if (!this.gl) return; // not yet connected

		if (name === "src" && this.video) {
			this.textureReady = false;
			this.video.src = this.resolveSrc();
			this.video.load();
			this.applyPlaybackState();
			return;
		}
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

	// --- setup -------------------------------------------------------------

	private createVideo(): HTMLVideoElement {
		const video = document.createElement("video");
		video.muted = true;
		video.defaultMuted = true;
		video.loop = !this.hasAttribute("no-loop");
		video.playsInline = true;
		video.autoplay = true;
		video.preload = "auto";
		video.crossOrigin = "anonymous";
		video.src = this.resolveSrc();

		// First decodable frame -> upload a texture even while paused (needed for
		// the reduced-motion static render and to avoid a blank first paint).
		const onData = () => this.scheduleRender();
		video.addEventListener("loadeddata", onData);
		video.addEventListener("seeked", onData);
		this.listeners.push(() => {
			video.removeEventListener("loadeddata", onData);
			video.removeEventListener("seeked", onData);
		});

		// With `no-loop`, the video fires `ended` once it reaches its final frame.
		// Re-broadcast it as a bubbling event so a host carousel can advance. (When
		// looping — the default — `ended` never fires, so this stays silent.)
		const onEnded = () =>
			this.dispatchEvent(
				new CustomEvent("dotted-grid:ended", { bubbles: true })
			);
		video.addEventListener("ended", onEnded);
		this.listeners.push(() => video.removeEventListener("ended", onEnded));
		return video;
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
		uniform vec2 uResolution;   // canvas size in device px
		uniform float uVideoAspect; // video w/h
		uniform float uCell;        // cell size in device px
		uniform float uDotScale;    // max radius as fraction of cell half-size
		uniform float uInvert;      // 0 or 1
		uniform float uGamma;
		uniform float uContrast;
		uniform vec3 uColor;        // dot color
		uniform vec3 uBg;           // backdrop color

		// Color reveal: dots within the trail radius or caught by the shimmer show
		// their true sampled color instead of the flat uColor.
		uniform vec2 uTrail[MAX_TRAIL]; // recent pointer positions, device px
		uniform float uTrailAge[MAX_TRAIL]; // 0 = newest .. 1 = oldest
		uniform int uTrailCount;    // active samples (0 => trail off)
		uniform float uRevealRadius;// pointer influence radius, device px
		uniform float uTime;        // seconds, for the shimmer pulse
		uniform float uShimmer;     // fraction 0..1 of dots that shimmer (0 => off)
		uniform float uRevealBoost; // 0 = raw sampled color, 1 = snap to ANSI palette

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
			vec3 src = texture(uTex, clamp(sampleUv, 0.0, 1.0)).rgb;

			// Brightness -> shaped value in [0,1].
			float b = luma(src);
			b = clamp((b - 0.5) * uContrast + 0.5, 0.0, 1.0);
			b = pow(b, uGamma);
			// invert: bright cells give small dots instead of large ones.
			float amount = mix(b, 1.0 - b, uInvert);

			// Distance from the cell center, in units of the cell half-size.
			float halfCell = uCell * 0.5;
			float dist = length(px - cellCenterPx) / halfCell;
			float radius = amount * uDotScale;

			// Anti-aliased dot edge (one device-pixel feather).
			float aa = (1.0 / halfCell) * 1.5;
			float mask = 1.0 - smoothstep(radius - aa, radius + aa, dist);

			// --- color reveal: how much of the true video color to show here -----
			// Pointer trail: strongest near a recent sample, decaying with distance
			// (radial falloff) and sample age (1 - age). Newest sample => full color
			// (fast fade-in); older samples decay over TRAIL_MS (slow fade-out).
			float trail = 0.0;
			for (int i = 0; i < MAX_TRAIL; i++) {
				if (i >= uTrailCount) break;
				float d = distance(cellCenterPx, uTrail[i]);
				float falloff = 1.0 - smoothstep(0.0, uRevealRadius, d);
				trail = max(trail, falloff * (1.0 - uTrailAge[i]));
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
			vec3 revealed = ansiSnap(src);
			vec3 dot = mix(uColor, revealed, colorRestore); // 0 => flat color
			fragColor = vec4(mix(uBg, dot, mask), 1.0);
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

		this.texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		const names = [
			"uTex",
			"uResolution",
			"uVideoAspect",
			"uCell",
			"uDotScale",
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

	private resize() {
		const gl = this.gl;
		const canvas = this.canvas;
		if (!gl || !canvas) return;
		const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
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
		if (this.rafId !== null) return;
		const tick = () => {
			this.rafId = requestAnimationFrame(tick);
			this.render();
		};
		this.rafId = requestAnimationFrame(tick);
	}

	private stopLoop() {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
	}

	/** One-shot repaint (used when paused / on attr or size change). */
	private scheduleRender() {
		if (this.rafId !== null) return; // the loop is already painting
		requestAnimationFrame(() => {
			if (this.rafId === null) this.render();
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

		const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
		const [r, g, b] = this.readColor("color", "--color-fg", [0.9, 0.9, 0.9]);
		const [br, bg, bb] = this.readColor("background", "--color-bg", [0, 0, 0]);
		const aspect = video.videoWidth / Math.max(1, video.videoHeight);

		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(this.uniforms.uTex, 0);
		gl.uniform2f(this.uniforms.uResolution, gl.canvas.width, gl.canvas.height);
		gl.uniform1f(this.uniforms.uVideoAspect, aspect);
		gl.uniform1f(this.uniforms.uCell, this.num("cell-size", DEFAULTS.cellSize) * dpr);
		gl.uniform1f(this.uniforms.uDotScale, this.num("dot-scale", DEFAULTS.dotScale));
		gl.uniform1f(this.uniforms.uInvert, this.hasAttribute("invert") ? 1 : 0);
		gl.uniform1f(this.uniforms.uGamma, this.num("gamma", DEFAULTS.gamma));
		gl.uniform1f(this.uniforms.uContrast, this.num("contrast", DEFAULTS.contrast));
		gl.uniform3f(this.uniforms.uColor, r, g, b);
		gl.uniform3f(this.uniforms.uBg, br, bg, bb);
		this.uploadReveal(gl, dpr);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);
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
