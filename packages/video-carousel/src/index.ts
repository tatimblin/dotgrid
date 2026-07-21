const MINOR_PER_GAP = 3; // decorative minor ticks inserted between majors
const MAGNIFY_SPREAD = 64; // px around the focus point over which ticks grow
const FADE_SPREAD = 180; // px over which distant ticks fade toward FADE_MIN
const FADE_MIN = 0.15; // opacity floor for the farthest ticks
const TICK = {
	// tick length (px) at rest (base) and at the focus point (max), per kind
	minor: { base: 8, max: 16 },
	major: { base: 16, max: 40 },
} as const;
const SWAP_MS = 260; // crossfade dip duration when the clip changes
const TRACK_FRACTION = 0.5; // ticks occupy the top half of the ruler height
const WARP = 5; // fisheye strength: higher spreads ticks near focus, bunches far

/**
 * Fisheye warp of a signed offset `x` in [-1, 1] to [-1, 1], monotonic and
 * odd. A logarithmic curve so spacing is largest near the focus (x≈0) and
 * compresses toward the ends — ticks close to the selection spread out, distant
 * ticks bunch together.
 */
function warp(x: number): number {
	const s = Math.sign(x);
	return (s * Math.log(1 + WARP * Math.abs(x))) / Math.log(1 + WARP);
}

interface Clip {
	src: string;
	desc: string;
	loc: string;
	date: string;
	alt: string;
}

/**
 * `<video-carousel>` — autoplays through a list of clips rendered as a single
 * `<dotted-grid>` halftone, advancing when each clip ends. A vertical ruler on
 * the side acts as a discrete slider (one major tick per clip): ticks magnify
 * toward the selected/pointer position — the iOS Contacts alphabet-scrubber
 * feel — and the ruler doubles as an interactive scrubber (click / drag /
 * keyboard) to jump between clips.
 *
 * The clip list is authored in the light DOM by the Astro wrapper: the ruler
 * (`[data-vc-ruler]`) holds one `<button class="vc__tick vc__tick--major">` per
 * clip carrying `data-index / data-src / data-desc / data-loc / data-date`, so
 * the content is present (and the dates readable) even before/without JS. On
 * connect this element reads those buttons, interleaves decorative minor ticks,
 * and drives the `<dotted-grid data-vc-grid>` + caption from the selection.
 *
 * Lifecycle mirrors the sibling packages (gallery-carousel / dotted-grid): a
 * `listeners` cleanup array, a `rafId` guard, a `ResizeObserver`, reduced-motion
 * handling, and thorough teardown (Layout uses ClientRouter view transitions).
 */
export class VideoCarouselElement extends HTMLElement {
	private grid: Element | null = null;
	private ruler: HTMLElement | null = null;
	private descEl: HTMLElement | null = null;
	private locEl: HTMLElement | null = null;
	private dateEl: HTMLElement | null = null;
	private stage: HTMLElement | null = null;
	private dateLabel: HTMLElement | null = null;

	private clips: Clip[] = [];
	private majorTicks: HTMLElement[] = []; // one per clip, in order
	private allTicks: HTMLElement[] = []; // majors + interleaved minors, DOM order
	private current = 0;

	private resizeObserver: ResizeObserver | null = null;
	private reducedMotion: MediaQueryList | null = null;
	private listeners: Array<() => void> = [];
	private rafId: number | null = null;
	private swapTimer: number | null = null;

	private dragging = false;
	private focusY: number | null = null; // pointer Y (ruler-relative) while dragging

	connectedCallback() {
		this.grid = this.querySelector("[data-vc-grid]");
		this.ruler = this.querySelector<HTMLElement>("[data-vc-ruler]");
		this.stage = this.querySelector<HTMLElement>("[data-vc-stage]");
		this.descEl = this.querySelector<HTMLElement>("[data-vc-desc]");
		this.locEl = this.querySelector<HTMLElement>("[data-vc-loc]");
		this.dateEl = this.querySelector<HTMLElement>("[data-vc-date]");
		if (!this.grid || !this.ruler) return;

		this.majorTicks = Array.from(
			this.ruler.querySelectorAll<HTMLElement>(".vc__tick--major")
		);
		this.clips = this.majorTicks.map((t) => ({
			src: t.dataset.src ?? "",
			desc: t.dataset.desc ?? "",
			loc: t.dataset.loc ?? "",
			date: t.dataset.date ?? "",
			alt: t.dataset.alt ?? "",
		}));
		if (!this.clips.length) return;

		this.buildRuler();

		this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onMotionChange = () => this.magnify();
		this.reducedMotion.addEventListener("change", onMotionChange);
		this.listeners.push(() =>
			this.reducedMotion?.removeEventListener("change", onMotionChange)
		);

		// Advance when the current clip finishes (dotted-grid re-broadcasts the
		// video's `ended` as this bubbling event, thanks to the `no-loop` attr).
		const onEnded = () => {
			if (!this.dragging) this.select(this.current + 1);
		};
		this.addEventListener("dotted-grid:ended", onEnded as EventListener);
		this.listeners.push(() =>
			this.removeEventListener("dotted-grid:ended", onEnded as EventListener)
		);

		this.attachRulerInteraction();

		this.resizeObserver = new ResizeObserver(() => this.magnify());
		this.resizeObserver.observe(this.ruler);

		this.select(0, /* initial */ true);
	}

	disconnectedCallback() {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		if (this.swapTimer !== null) clearTimeout(this.swapTimer);
		this.swapTimer = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.listeners.forEach((off) => off());
		this.listeners = [];
		this.majorTicks = [];
		this.allTicks = [];
		this.dateLabel = null;
	}

	// --- ruler construction ------------------------------------------------

	/**
	 * Interleave decorative minor ticks between the authored major ticks and add
	 * the floating date label. Majors keep their `data-index`; minors are inert
	 * (`aria-hidden`, no pointer target of their own beyond the ruler drag).
	 */
	private buildRuler() {
		const ruler = this.ruler;
		if (!ruler) return;

		ruler.setAttribute("role", "slider");
		ruler.setAttribute("tabindex", "0");
		ruler.setAttribute("aria-valuemin", "0");
		ruler.setAttribute("aria-valuemax", String(this.clips.length - 1));

		const frag = document.createDocumentFragment();
		this.majorTicks.forEach((major, i) => {
			frag.appendChild(major);
			if (i < this.majorTicks.length - 1) {
				for (let m = 0; m < MINOR_PER_GAP; m++) {
					const minor = document.createElement("span");
					minor.className = "vc__tick vc__tick--minor";
					minor.setAttribute("aria-hidden", "true");
					frag.appendChild(minor);
				}
			}
		});
		ruler.replaceChildren(frag);

		this.dateLabel = document.createElement("span");
		this.dateLabel.className = "vc__ruler-date";
		this.dateLabel.setAttribute("aria-hidden", "true");
		ruler.appendChild(this.dateLabel);

		this.allTicks = Array.from(
			ruler.querySelectorAll<HTMLElement>(".vc__tick")
		);
	}

	private attachRulerInteraction() {
		const ruler = this.ruler;
		if (!ruler) return;

		// Click / tap a major tick: jump straight to it.
		const onClick = (e: Event) => {
			const tick = (e.target as Element)?.closest<HTMLElement>(
				".vc__tick--major"
			);
			if (!tick || tick.dataset.index === undefined) return;
			this.select(Number(tick.dataset.index));
		};
		ruler.addEventListener("click", onClick);
		this.listeners.push(() => ruler.removeEventListener("click", onClick));

		// Drag along the ruler: selection follows the pointer to the nearest major
		// tick, ticks magnify around the finger, and autoplay-advance is suspended
		// until release.
		const onPointerDown = (e: PointerEvent) => {
			this.dragging = true;
			ruler.setPointerCapture(e.pointerId);
			this.onDragMove(e);
		};
		const onPointerMove = (e: PointerEvent) => {
			if (this.dragging) this.onDragMove(e);
		};
		const endDrag = (e: PointerEvent) => {
			if (!this.dragging) return;
			this.dragging = false;
			this.focusY = null;
			try {
				ruler.releasePointerCapture(e.pointerId);
			} catch {
				/* pointer may already be released */
			}
			this.magnify(); // settle magnification back onto the selected tick
		};
		ruler.addEventListener("pointerdown", onPointerDown);
		ruler.addEventListener("pointermove", onPointerMove);
		ruler.addEventListener("pointerup", endDrag);
		ruler.addEventListener("pointercancel", endDrag);
		this.listeners.push(() => {
			ruler.removeEventListener("pointerdown", onPointerDown);
			ruler.removeEventListener("pointermove", onPointerMove);
			ruler.removeEventListener("pointerup", endDrag);
			ruler.removeEventListener("pointercancel", endDrag);
		});

		// Keyboard: arrows step through clips (no wrap, matching slider semantics).
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
				e.preventDefault();
				this.select(Math.max(0, this.current - 1));
			} else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
				e.preventDefault();
				this.select(Math.min(this.clips.length - 1, this.current + 1));
			}
		};
		ruler.addEventListener("keydown", onKeyDown);
		this.listeners.push(() => ruler.removeEventListener("keydown", onKeyDown));
	}

	/** Map a drag pointer to the nearest major tick and select it live. */
	private onDragMove(e: PointerEvent) {
		const ruler = this.ruler;
		if (!ruler) return;
		const rect = ruler.getBoundingClientRect();
		this.focusY = e.clientY - rect.top;

		let nearest = 0;
		let best = Infinity;
		this.majorTicks.forEach((tick, i) => {
			const c = this.centerY(tick, rect);
			const d = Math.abs(c - this.focusY!);
			if (d < best) {
				best = d;
				nearest = i;
			}
		});
		if (nearest !== this.current) this.select(nearest);
		else this.magnify(); // still refresh magnification as the finger moves
	}

	// --- selection ---------------------------------------------------------

	/** Select clip `i` (wrapping): swap the video src, update caption + ruler. */
	private select(i: number, initial = false) {
		if (!this.clips.length) return;
		const n = this.clips.length;
		const index = ((i % n) + n) % n; // wrap-around
		const clip = this.clips[index];
		this.current = index;

		if (this.grid && this.grid.getAttribute("src") !== clip.src) {
			this.crossfade();
			this.grid.setAttribute("src", clip.src);
		}

		if (this.descEl) this.descEl.textContent = clip.desc;
		if (this.locEl) this.locEl.textContent = clip.loc;
		if (this.dateEl) this.dateEl.textContent = clip.date;
		if (this.dateLabel) this.dateLabel.textContent = clip.date;

		this.ruler?.setAttribute("aria-valuenow", String(index));
		this.ruler?.setAttribute(
			"aria-valuetext",
			`${clip.desc} — ${clip.loc} — ${clip.date}`
		);

		this.majorTicks.forEach((tick, k) => {
			tick.classList.toggle("vc__tick--selected", k === index);
			tick.setAttribute("aria-selected", k === index ? "true" : "false");
		});

		// Let layout settle on the first paint before measuring tick positions.
		if (initial) requestAnimationFrame(() => this.magnify());
		else this.magnify();
	}

	/** Briefly dip the stage opacity around a src swap (skipped for reduced motion). */
	private crossfade() {
		if (!this.stage || this.reducedMotion?.matches) return;
		this.stage.classList.add("is-swapping");
		if (this.swapTimer !== null) clearTimeout(this.swapTimer);
		this.swapTimer = window.setTimeout(() => {
			this.stage?.classList.remove("is-swapping");
			this.swapTimer = null;
		}, SWAP_MS);
	}

	// --- tick layout + magnification ---------------------------------------

	/**
	 * Position and size every tick, coalesced to one write per frame.
	 *
	 * Position: the ticks occupy the TOP HALF of the ruler (TRACK_FRACTION) and
	 * are laid out with a fisheye warp centered on the selected tick — spacing is
	 * widest near the selection and compresses toward the ends, so ticks far from
	 * the current clip bunch together and nearby ones spread out. The first and
	 * last ticks stay pinned to the track ends.
	 *
	 * Length: each tick's width follows a distance falloff around the focus point
	 * (the selected tick at rest, the pointer while dragging) so ticks swell
	 * toward it like the iOS scrubber.
	 */
	private magnify() {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			const ruler = this.ruler;
			const n = this.allTicks.length;
			if (!ruler || !n) return;

			const trackH = ruler.clientHeight * TRACK_FRACTION;
			const last = Math.max(1, n - 1);
			// Focus in [0,1] along the tick sequence: the selected major's slot.
			const stride = MINOR_PER_GAP + 1; // ticks between consecutive majors
			const uf = Math.min(1, (this.current * stride) / last);
			// Normalize the warp so u=0 -> track top and u=1 -> track bottom while
			// the fisheye expands around uf.
			const denom = warp(1 - uf) - warp(-uf) || 1;
			const yAt = (u: number) => (trackH * (warp(u - uf) - warp(-uf))) / denom;

			// Cache each tick's laid-out center Y, then set positions.
			const ys: number[] = new Array(n);
			for (let i = 0; i < n; i++) {
				const y = yAt(i / last);
				ys[i] = y;
				this.allTicks[i].style.setProperty("--vc-tick-y", `${y.toFixed(1)}px`);
			}

			// Length falloff swells ticks near the SELECTED tick, and also near the
			// POINTER while dragging — a tick grows if it's close to either, so the
			// selection keeps its bulge while the finger raises its own.
			const selY = yAt(uf);
			const ptrY = this.dragging && this.focusY !== null ? this.focusY : null;

			for (let i = 0; i < n; i++) {
				const tick = this.allTicks[i];
				const kind = tick.classList.contains("vc__tick--major")
					? TICK.major
					: TICK.minor;
				const falloff = (from: number) => {
					const t = Math.max(0, 1 - Math.abs(ys[i] - from) / MAGNIFY_SPREAD);
					return t * t * (3 - 2 * t); // smoothstep
				};
				const eased =
					ptrY !== null
						? Math.max(falloff(selY), falloff(ptrY))
						: falloff(selY);
				const len = kind.base + (kind.max - kind.base) * eased;
				tick.style.setProperty("--vc-tick-len", `${len.toFixed(1)}px`);

				// Fade with distance from the focus (selection, or pointer while
				// dragging), so ticks far from the current clip recede.
				const near = ptrY !== null ? Math.min(
					Math.abs(ys[i] - selY),
					Math.abs(ys[i] - ptrY)
				) : Math.abs(ys[i] - selY);
				const prox = Math.max(0, 1 - near / FADE_SPREAD);
				const op = FADE_MIN + (1 - FADE_MIN) * prox;
				tick.style.setProperty("--vc-tick-op", op.toFixed(2));
			}

			this.dateLabel?.style.setProperty("--vc-date-y", `${selY.toFixed(1)}px`);
		});
	}

	/** Vertical center of a tick relative to the ruler's top edge. */
	private centerY(tick: HTMLElement, rulerRect: DOMRect): number {
		const r = tick.getBoundingClientRect();
		return r.top - rulerRect.top + r.height / 2;
	}
}

if (
	typeof customElements !== "undefined" &&
	!customElements.get("video-carousel")
) {
	customElements.define("video-carousel", VideoCarouselElement);
}
