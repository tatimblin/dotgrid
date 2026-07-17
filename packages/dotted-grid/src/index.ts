const DEFAULTS = {
	cellSize: 6, // CSS px per grid cell (drives dot density)
	dotScale: 0.85, // max dot radius as a fraction of the cell half-size
	gamma: 0.8, // luminance shaping exponent (>1 darkens mids)
	contrast: 1.1, // luminance contrast around 0.5
	color: "", // dot color; empty => read --color-fg
	background: "", // backdrop color; empty => read --color-bg
} as const;

const MAX_DPR = 2; // clamp devicePixelRatio so 4K/retina stays affordable

/**
 * `<dotted-grid src="/videos/fabric.web.mp4">` — renders a video as an animated
 * halftone dot grid via a single fullscreen quad + fragment shader (raw WebGL2,
 * no dependencies). Each grid cell samples the video at its center and draws a
 * dot whose radius tracks local brightness.
 *
 * Attributes (all live-updatable):
 *   src         video URL (required)
 *   cell-size   grid cell size in CSS px (default 6)
 *   dot-scale   max dot radius as fraction of cell half-size (default 0.85)
 *   invert      boolean; flips the brightness->radius mapping
 *   color       dot color (default: CSS --color-fg)
 *   background  backdrop color (default: CSS --color-bg)
 *   gamma       luminance exponent (default 0.8)
 *   contrast    luminance contrast (default 1.1)
 *   paused      boolean; freezes the animation
 *
 * Forward-looking seams (declared, currently inert): a `uMouse` uniform for
 * future grid warp / dot bump, and `uColorRestore` for painting source color
 * inside dots. Wiring them later needs no structural change here.
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
		// cell-size / dot-scale / invert / color / background / gamma / contrast:
		// uniforms are read fresh each draw, so just repaint the current frame.
		this.scheduleRender();
	}

	// --- setup -------------------------------------------------------------

	private createVideo(): HTMLVideoElement {
		const video = document.createElement("video");
		video.muted = true;
		video.defaultMuted = true;
		video.loop = true;
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
		uniform vec2 uMouse;        // reserved (grid warp / bump) — currently inert
		uniform float uColorRestore;// reserved (0 = off) — currently inert

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

			vec3 dot = mix(uColor, src, uColorRestore); // uColorRestore=0 => flat color
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
			"uMouse",
			"uColorRestore",
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
	private applyPlaybackState() {
		const video = this.video;
		if (!video) return;
		const wantPlay =
			!this.hasAttribute("paused") &&
			!this.reducedMotion?.matches &&
			this.visible;

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
		gl.uniform2f(this.uniforms.uMouse, -1, -1); // inert until wired
		gl.uniform1f(this.uniforms.uColorRestore, 0); // inert until wired

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);
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
