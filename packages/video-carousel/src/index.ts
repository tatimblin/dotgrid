import { loadTick, resumeTick, playTick } from "./tick-sound";

const TICKS_PER_YEAR = 6; // bi-monthly cadence: one tick every two months
const STEP_YEARS = 1 / TICKS_PER_YEAR; // axis step, in years, between adjacent ticks
const TICK_GAP_PX = 13; // vertical px between adjacent cadence ticks (strip spacing)
const MAGNIFY_SPREAD = 90; // px around the fixed center over which ticks gently grow
const MAGNIFY_GAIN = 0.35; // gentle: max fractional length boost near the center
const FADE_SPREAD = 220; // px over which distant ticks fade toward FADE_MIN
const FADE_MIN = 0.12; // opacity floor for the farthest ticks
const TICK = {
	// tick length (px) at rest (base) and at the center (max), per kind
	cadence: { base: 12, max: 20 },
	year: { base: 22, max: 32 }, // January (year-boundary) ticks are longer
} as const;
const SWAP_MS = 260; // crossfade dip duration when the clip changes
const SETTLE_MS = 420; // strip scroll animation duration for autoplay/keyboard steps
const TICK_MIN_GAP_MS = 55; // min gap between tick sounds so a fast scrub can't machine-gun them

/** Month name → 0-based index, covering full names and the abbreviations the
 *  clip metadata uses (including the non-standard "Sept"). */
const MONTHS: Record<string, number> = {
	jan: 0, january: 0,
	feb: 1, february: 1,
	mar: 2, march: 2,
	apr: 3, april: 3,
	may: 4,
	jun: 5, june: 5,
	jul: 6, july: 6,
	aug: 7, august: 7,
	sep: 8, sept: 8, september: 8,
	oct: 9, october: 9,
	nov: 10, november: 10,
	dec: 11, december: 11,
};

/**
 * Parse a clip date like "June 2025" / "Sept 2024" into a continuous time
 * (year + month/12). Returns NaN when the string doesn't match, so callers can
 * fall back to synthetic evenly-spaced times.
 */
function parseClipTime(date: string): number {
	const m = date.trim().toLowerCase().match(/^([a-z]+)\.?\s+(\d{4})$/);
	if (!m) return NaN;
	const month = MONTHS[m[1]];
	const year = Number(m[2]);
	if (month === undefined || !Number.isFinite(year)) return NaN;
	return year + month / 12;
}

/** Smoothstep easing on t in [0,1]. */
function smoothstep(t: number): number {
	const c = Math.max(0, Math.min(1, t));
	return c * c * (3 - 2 * c);
}

interface Clip {
	src: string; // H.264 mp4 (universal fallback)
	srcWebm: string; // optional AV1/VP9 webm, preferred where playable ("" = none)
	desc: string;
	loc: string;
	date: string;
	alt: string;
}

/**
 * `<video-carousel>` — autoplays through a list of clips rendered as a single
 * `<dotted-grid>` halftone, advancing when each clip ends. A vertical date ruler
 * on the side works like maximeheckel.com's reading-progress ruler: a selection
 * marker is FIXED at the ruler's vertical center while a strip of uniformly
 * spaced cadence ticks SCROLLS behind it. The selected clip's date scrolls to
 * the center marker; the ruler doubles as a scrubber (drag / click / keyboard).
 *
 * Ticks sit on a continuous time axis at a fixed cadence (TICKS_PER_YEAR), so
 * clips generally land mid-tick or on alternating ticks — intended. Ticks that
 * fall on a January (a whole year) are longer and carry the year in small text.
 *
 * The clip list is authored in the light DOM by the Astro wrapper: the ruler
 * (`[data-vc-ruler]`) holds one `<button class="vc__tick vc__tick--major">` per
 * clip carrying `data-index / data-src / data-desc / data-loc / data-date`, so
 * the content is present (and the dates readable) even before/without JS. On
 * connect this element reads those buttons for the clip data + time axis, then
 * replaces them with the generated scrolling strip, and drives the
 * `<dotted-grid data-vc-grid>` + caption from the selection.
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
	private stage: HTMLElement | null = null;
	private strip: HTMLElement | null = null;
	private marker: HTMLElement | null = null;

	private clips: Clip[] = [];
	private clipTimes: number[] = []; // continuous time per clip, in years
	private tickEls: HTMLElement[] = []; // cadence ticks, DOM order
	private tickTimes: number[] = []; // continuous time per cadence tick
	private axisStart = 0; // time (years) of the first cadence tick
	private current = 0;
	private stripOffset = 0; // current strip translateY (px)

	private resizeObserver: ResizeObserver | null = null;
	private reducedMotion: MediaQueryList | null = null;
	private listeners: Array<() => void> = [];
	private rafId: number | null = null;
	private swapTimer: number | null = null;
	private settleTimer: number | null = null;

	private dragging = false;
	private dragStart = 0; // pointer coord (main axis) at drag start (client px)
	private dragStartOffset = 0; // strip offset at drag start (px)
	private dragMoved = false; // pointer moved past the tap threshold since down

	private tickSrc = ""; // tick-sound asset URL (from the `tick-src` attr); "" = off
	private muted = false; // reflects the persisted `sound` preference
	private lastTickAt = 0; // timestamp of the last emitted tick (ms), for throttling

	// Prefetch of the next clip so the grid's incoming buffer reads from cache.
	private prefetchLink: HTMLLinkElement | null = null; // reused <link rel=prefetch>
	private prefersWebm: boolean | null = null; // cached canPlayType('video/webm')

	// Orientation: vertical (desktop, ruler beside the video) or horizontal
	// (mobile, ruler as a strip below the card). The single source of truth for
	// all axis-dependent geometry — recomputed on connect and on the media query.
	private orientation: "vertical" | "horizontal" = "vertical";
	private orientationMQ: MediaQueryList | null = null;

	/** True when the ruler runs along the X axis (mobile). */
	private get horizontal(): boolean {
		return this.orientation === "horizontal";
	}

	/** The ruler's length along its main axis (width when horizontal, else height). */
	private mainSize(): number {
		const r = this.ruler;
		if (!r) return 0;
		return this.horizontal ? r.clientWidth : r.clientHeight;
	}

	connectedCallback() {
		this.grid = this.querySelector("[data-vc-grid]");
		this.ruler = this.querySelector<HTMLElement>("[data-vc-ruler]");
		this.stage = this.querySelector<HTMLElement>("[data-vc-stage]");
		this.descEl = this.querySelector<HTMLElement>("[data-vc-desc]");
		this.locEl = this.querySelector<HTMLElement>("[data-vc-loc]");
		if (!this.grid || !this.ruler) return;

		const majorTicks = Array.from(
			this.ruler.querySelectorAll<HTMLElement>(".vc__tick--major")
		);
		this.clips = majorTicks.map((t) => ({
			src: t.dataset.src ?? "",
			srcWebm: t.dataset.srcWebm ?? "",
			desc: t.dataset.desc ?? "",
			loc: t.dataset.loc ?? "",
			date: t.dataset.date ?? "",
			alt: t.dataset.alt ?? "",
		}));
		if (!this.clips.length) return;

		// Ruler side: `ruler-side="right"` places the ruler to the RIGHT of the card
		// (default "left"). A pure CSS concern in the vertical orientation (tick math
		// is symmetric about the strip), so we just toggle the modifier class on the
		// host; styles.css mirrors the anchoring. Unaffected by the mobile flip.
		this.classList.toggle(
			"vc--ruler-right",
			this.getAttribute("ruler-side") === "right"
		);

		// Orientation drives all axis-dependent geometry; set it before building.
		this.orientationMQ = window.matchMedia("(max-width: 640px)");
		this.orientation = this.orientationMQ.matches ? "horizontal" : "vertical";

		this.buildRuler();

		this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onMotionChange = () => this.refresh();
		this.reducedMotion.addEventListener("change", onMotionChange);
		this.listeners.push(() =>
			this.reducedMotion?.removeEventListener("change", onMotionChange)
		);

		// Flip vertical↔horizontal at the mobile breakpoint. buildRuler() rewrites
		// tick positions (left vs top) + the modifier class; the pointer/keyboard
		// listeners bind to the ruler itself (they survive replaceChildren), so we
		// do NOT re-attach them. scrollToClip re-seats the offset for the new axis.
		const onOrientationChange = () => {
			const next = this.orientationMQ?.matches ? "horizontal" : "vertical";
			if (next === this.orientation) return;
			this.orientation = next;
			this.buildRuler();
			this.scrollToClip(this.current, false);
		};
		this.orientationMQ.addEventListener("change", onOrientationChange);
		this.listeners.push(() =>
			this.orientationMQ?.removeEventListener("change", onOrientationChange)
		);

		// Tick sound: preload the asset (if authored) and track the global mute
		// preference. Mirrors the theme toggle wiring — the footer flips
		// `localStorage.sound` and dispatches `soundchange`; we refresh from it.
		this.tickSrc = this.getAttribute("tick-src") ?? "";
		if (this.tickSrc) loadTick(this.tickSrc);
		this.muted = this.readMuted();
		const onSoundChange = () => {
			this.muted = this.readMuted();
		};
		document.addEventListener("soundchange", onSoundChange);
		this.listeners.push(() =>
			document.removeEventListener("soundchange", onSoundChange)
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

		// Center depends on the ruler's height, so re-center + re-magnify on resize.
		this.resizeObserver = new ResizeObserver(() => this.scrollToClip(this.current, false));
		this.resizeObserver.observe(this.ruler);

		this.select(0, { initial: true });
	}

	disconnectedCallback() {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		if (this.swapTimer !== null) clearTimeout(this.swapTimer);
		this.swapTimer = null;
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.settleTimer = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.listeners.forEach((off) => off());
		this.listeners = [];
		this.tickEls = [];
		this.tickTimes = [];
		this.strip = null;
		this.marker = null;
		this.orientationMQ = null;
	}

	// --- ruler construction ------------------------------------------------

	/**
	 * Fan out runs of clips that parsed to the SAME continuous time so each gets a
	 * distinct, monotonically increasing position. Without this, month-precise dates
	 * make consecutive same-month clips share one strip offset: `nearestClip` can
	 * only ever return the run's first member (so the inner clips are unreachable by
	 * drag/tap) and the selection sits frozen across the run before jumping. Members
	 * after the first are pushed forward across at most one cadence step's worth of
	 * room (never past the next distinct time), keeping the ruler chronological.
	 */
	private spreadSameTimeClips() {
		const n = this.clipTimes.length;
		let i = 0;
		while (i < n) {
			let j = i + 1;
			while (j < n && this.clipTimes[j] === this.clipTimes[i]) j++;
			const runLen = j - i;
			if (runLen > 1) {
				const base = this.clipTimes[i];
				// Room to fan into: up to the next distinct time, but no more than one
				// cadence step so the run stays visually clustered on the ruler.
				const next = j < n ? this.clipTimes[j] : base + STEP_YEARS;
				const room = Math.min(STEP_YEARS, next - base);
				const gap = room / runLen; // leave a slot before `next`, keep order strict
				for (let k = 1; k < runLen; k++) {
					this.clipTimes[i + k] = base + gap * k;
				}
			}
			i = j;
		}
	}

	/**
	 * Build the continuous time axis from the clip dates, generate the uniformly
	 * spaced cadence tick strip (year-boundary ticks enlarged and labelled), and
	 * add the fixed center marker + fixed date label. The scrolling strip and the
	 * fixed elements are siblings inside the ruler so the marker/label stay put.
	 */
	private buildRuler() {
		const ruler = this.ruler;
		if (!ruler) return;

		ruler.setAttribute("role", "slider");
		ruler.setAttribute("tabindex", "0");
		ruler.setAttribute("aria-valuemin", "0");
		ruler.setAttribute("aria-valuemax", String(this.clips.length - 1));
		ruler.classList.toggle("vc__ruler--horizontal", this.horizontal);

		// Clip times: parse dates; if any fails, fall back to synthetic spacing so
		// the ruler still renders sensibly.
		this.clipTimes = this.clips.map((c) => parseClipTime(c.date));
		if (this.clipTimes.some((t) => !Number.isFinite(t))) {
			this.clipTimes = this.clips.map((_, i) => i * STEP_YEARS);
		}

		// Dates are only month-precise, so runs of clips sharing a month (e.g. four
		// "April 2025" clips) collapse onto ONE strip offset — dragging can't land on
		// the inner ones and the selection sits dead across a run, then jumps. Nudge
		// each same-time run into distinct, still-chronological sub-positions: keep
		// the first member on its true time and fan the rest forward across a slice of
		// the room before the next distinct date (capped so they stay within a tick).
		this.spreadSameTimeClips();

		// Snap the axis to whole cadence steps and pad one step on each end so the
		// first/last clip is never flush against a strip edge.
		const tMin = Math.min(...this.clipTimes);
		const tMax = Math.max(...this.clipTimes);
		this.axisStart = Math.floor(tMin / STEP_YEARS) * STEP_YEARS - STEP_YEARS;
		const axisEnd = Math.ceil(tMax / STEP_YEARS) * STEP_YEARS + STEP_YEARS;
		const tickCount = Math.round((axisEnd - this.axisStart) / STEP_YEARS) + 1;

		this.strip = document.createElement("div");
		this.strip.className = "vc__strip";

		this.tickEls = [];
		this.tickTimes = [];
		for (let k = 0; k < tickCount; k++) {
			const time = this.axisStart + k * STEP_YEARS;
			const isYear = Math.abs(time - Math.round(time)) < 1e-6;
			const tick = document.createElement("span");
			tick.className = isYear ? "vc__tick vc__tick--year" : "vc__tick";
			tick.setAttribute("aria-hidden", "true");
			// Position along the strip's main axis; clear the opposite property so a
			// rebuild after an orientation flip never leaves a stale top/left.
			const pos = `${(k * TICK_GAP_PX).toFixed(1)}px`;
			if (this.horizontal) {
				tick.style.left = pos;
				tick.style.top = "";
			} else {
				tick.style.top = pos;
				tick.style.left = "";
			}
			if (isYear) {
				const label = document.createElement("span");
				label.className = "vc__tick-year";
				label.textContent = String(Math.round(time));
				tick.appendChild(label);
			}
			this.strip.appendChild(tick);
			this.tickEls.push(tick);
			this.tickTimes.push(time);
		}

		this.marker = document.createElement("span");
		this.marker.className = "vc__marker";
		this.marker.setAttribute("aria-hidden", "true");

		ruler.replaceChildren(this.strip, this.marker);
	}

	private attachRulerInteraction() {
		const ruler = this.ruler;
		if (!ruler) return;

		// Pointer down/move/up owns BOTH tap and drag (no separate click handler, so
		// a drag's synthetic click can't fight the release snap). A drag scrolls the
		// strip and settles on the clip under the center marker; a tap (no movement
		// past TAP_SLOP) selects the clip nearest the tapped position.
		const TAP_SLOP = 4; // px of movement below which a gesture counts as a tap
		// Pointer coord along the ruler's main axis (X when horizontal, else Y).
		const coordOf = (e: PointerEvent) => (this.horizontal ? e.clientX : e.clientY);
		const onPointerDown = (e: PointerEvent) => {
			this.dragging = true;
			this.dragMoved = false;
			this.dragStart = coordOf(e);
			this.dragStartOffset = this.stripOffset;
			ruler.classList.add("is-dragging");
			ruler.setPointerCapture(e.pointerId);
		};
		const onPointerMove = (e: PointerEvent) => {
			if (!this.dragging) return;
			const coord = coordOf(e);
			if (Math.abs(coord - this.dragStart) > TAP_SLOP) this.dragMoved = true;
			const size = this.mainSize();
			const raw = this.dragStartOffset + (coord - this.dragStart);
			this.stripOffset = this.clampOffset(raw, size);
			this.refresh();
			// Live scrub: select the clip under the center marker as it passes, so a
			// drag flashes each video by. scrollToClip() is a no-op on the offset
			// while dragging (below), so this never yanks the strip off the finger.
			const idx = this.scrubClip(this.timeAtY(size / 2, size));
			if (idx !== this.current) this.select(idx, { userDriven: true });
		};
		const endDrag = (e: PointerEvent) => {
			if (!this.dragging) return;
			this.dragging = false;
			ruler.classList.remove("is-dragging");
			try {
				ruler.releasePointerCapture(e.pointerId);
			} catch {
				/* pointer may already be released */
			}
			const rect = ruler.getBoundingClientRect();
			const size = this.horizontal ? rect.width : rect.height;
			// Drag: snap to the clip at the center marker. Tap: snap to the clip
			// nearest the tapped position along the main axis.
			const at = this.dragMoved
				? size / 2
				: this.horizontal
					? e.clientX - rect.left
					: e.clientY - rect.top;
			this.select(this.nearestClip(this.timeAtY(at, size)), {
				userDriven: true,
			});
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

		// Keyboard: arrows step through clips; Home/End jump to first/last (no wrap,
		// matching slider semantics).
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
				e.preventDefault();
				this.select(Math.max(0, this.current - 1), { userDriven: true });
			} else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
				e.preventDefault();
				this.select(Math.min(this.clips.length - 1, this.current + 1), {
					userDriven: true,
				});
			} else if (e.key === "Home") {
				e.preventDefault();
				this.select(0, { userDriven: true });
			} else if (e.key === "End") {
				e.preventDefault();
				this.select(this.clips.length - 1, { userDriven: true });
			}
		};
		ruler.addEventListener("keydown", onKeyDown);
		this.listeners.push(() => ruler.removeEventListener("keydown", onKeyDown));
	}

	// --- axis helpers ------------------------------------------------------

	/** Strip Y (px from strip top) for a continuous time. */
	private tickY(time: number): number {
		return ((time - this.axisStart) / STEP_YEARS) * TICK_GAP_PX;
	}

	/** Strip offset (translateY) that places `time` at the ruler's vertical center. */
	private offsetFor(time: number, rulerHeight: number): number {
		return rulerHeight / 2 - this.tickY(time);
	}

	/** Continuous time currently sitting at a given ruler-relative Y. */
	private timeAtY(y: number, rulerHeight: number): number {
		// stripY = y - stripOffset; time = axisStart + stripY/TICK_GAP_PX * STEP_YEARS
		void rulerHeight;
		const stripY = y - this.stripOffset;
		return this.axisStart + (stripY / TICK_GAP_PX) * STEP_YEARS;
	}

	/** Clamp the strip offset so clips never scroll past the marker. */
	private clampOffset(offset: number, rulerHeight: number): number {
		const min = this.offsetFor(Math.max(...this.clipTimes), rulerHeight);
		const max = this.offsetFor(Math.min(...this.clipTimes), rulerHeight);
		return Math.max(min, Math.min(max, offset));
	}

	/**
	 * Live-scrub selection with hysteresis. Unlike `nearestClip` (which flips at
	 * the midpoint between two clips — so pointer jitter near that midpoint chatters
	 * A↔B↔A and machine-guns the tick sound), this only leaves the current clip once
	 * the marker actually crosses a NEIGHBOUR's position. Between two clips it holds
	 * the current one, giving each a full "dead zone" up to the next clip's time.
	 */
	private scrubClip(time: number): number {
		let i = this.current;
		// Walk toward the marker one clip at a time; stop as soon as the marker
		// hasn't yet reached the next neighbour in that direction.
		while (i + 1 < this.clipTimes.length && time >= this.clipTimes[i + 1]) i++;
		while (i - 1 >= 0 && time <= this.clipTimes[i - 1]) i--;
		return i;
	}

	/** Index of the clip whose time is nearest a given continuous time. */
	private nearestClip(time: number): number {
		let nearest = 0;
		let best = Infinity;
		this.clipTimes.forEach((t, i) => {
			const d = Math.abs(t - time);
			if (d < best) {
				best = d;
				nearest = i;
			}
		});
		return nearest;
	}

	/** Read the persisted mute preference. Absent / "on" = unmuted; "off" = muted. */
	private readMuted(): boolean {
		try {
			return localStorage.getItem("sound") === "off";
		} catch {
			return false; // storage unavailable (private mode etc.) — default to on
		}
	}

	// --- selection ---------------------------------------------------------

	/**
	 * Select clip `i` (wrapping): swap the video src, update caption + ruler.
	 * `initial` skips the src replay + defers the first layout measure; `userDriven`
	 * marks a direct interaction (click/drag/keyboard) so it can emit a tick sound —
	 * autoplay advance leaves both false and stays silent.
	 */
	private select(
		i: number,
		{ initial = false, userDriven = false }: { initial?: boolean; userDriven?: boolean } = {}
	) {
		if (!this.clips.length) return;
		const n = this.clips.length;
		const index = ((i % n) + n) % n; // wrap-around
		const changed = index !== this.current;
		const clip = this.clips[index];
		this.current = index;

		// Tick on user-driven changes only (not autoplay, not a no-op re-select).
		// Throttle to TICK_MIN_GAP_MS: a fast drag-scrub crosses many clips within a
		// few ms, and one overlapping tick per clip stacks into a glitchy buzz.
		if (userDriven && changed && !this.muted && this.tickSrc) {
			const now = performance.now();
			if (now - this.lastTickAt >= TICK_MIN_GAP_MS) {
				this.lastTickAt = now;
				resumeTick(); // the interaction is a gesture — unlocks the context first time
				playTick(this.tickSrc);
			}
		}

		if (this.grid) {
			if (this.grid.getAttribute("src") !== clip.src) {
				this.crossfade();
				// Set src-webm first so it's present when the grid reacts to `src`;
				// setAttribute fires attributeChangedCallback per attr, and the src
				// change is what triggers the (single) source swap.
				if (clip.srcWebm) this.grid.setAttribute("src-webm", clip.srcWebm);
				else this.grid.removeAttribute("src-webm");
				this.grid.setAttribute("src", clip.src);
			} else if (!initial) {
				// Same file as the outgoing clip (e.g. adjacent clips reuse a src, or
				// wrapping last→first): the src attr is unchanged so it won't reload,
				// and with `no-loop` the video is parked on its final frame. Restart it.
				(this.grid as { replay?: () => void }).replay?.();
			}
			// Warm the following clip regardless of whether THIS one reloaded (covers
			// the initial select, where clip[0] is already the grid's src).
			this.prefetchNext(index);
		}

		if (this.descEl) this.descEl.textContent = clip.desc;
		if (this.locEl) this.locEl.textContent = clip.loc;

		this.ruler?.setAttribute("aria-valuenow", String(index));
		this.ruler?.setAttribute(
			"aria-valuetext",
			`${clip.desc} — ${clip.loc} — ${clip.date}`
		);

		// Let layout settle on the first paint before measuring the ruler height.
		if (initial) requestAnimationFrame(() => this.scrollToClip(index, false));
		else this.scrollToClip(index, true);
	}

	/**
	 * Warm the browser cache with the clip that follows `index` so the grid's
	 * double-buffer decode reads from cache instead of the network at swap time.
	 * Uses a single reused `<link rel="prefetch" as="video">`, picking the webm URL
	 * where the browser can play it. Skipped under Save-Data — the visitor has asked
	 * us not to pull bytes speculatively.
	 */
	private prefetchNext(index: number) {
		const n = this.clips.length;
		if (n < 2) return;
		if (this.saveData()) return;

		const next = this.clips[(index + 1) % n];
		if (this.prefersWebm === null) {
			const probe = document.createElement("video");
			this.prefersWebm = probe.canPlayType("video/webm") !== "";
		}
		const url = this.prefersWebm && next.srcWebm ? next.srcWebm : next.src;
		if (!url) return;

		if (!this.prefetchLink) {
			const link = document.createElement("link");
			link.rel = "prefetch";
			link.as = "video";
			document.head.appendChild(link);
			this.prefetchLink = link;
			this.listeners.push(() => {
				link.remove();
				this.prefetchLink = null;
			});
		}
		if (this.prefetchLink.getAttribute("href") !== url)
			this.prefetchLink.setAttribute("href", url);
	}

	/** True when the visitor has opted into reduced data usage. */
	private saveData(): boolean {
		const conn = (
			navigator as Navigator & { connection?: { saveData?: boolean } }
		).connection;
		return conn?.saveData === true;
	}

	/** Scroll the strip so clip `i`'s date sits at the fixed center marker. */
	private scrollToClip(i: number, animate: boolean) {
		const ruler = this.ruler;
		const strip = this.strip;
		if (!ruler || !strip) return;

		// Mid-drag the pointer owns the strip offset (live-scrub select() calls land
		// here); don't re-center onto the clip or it would fight the finger. On
		// release endDrag clears `dragging` before its select(), so the final clip
		// still settles + tweens normally.
		if (this.dragging) return;

		this.stripOffset = this.offsetFor(this.clipTimes[i], this.mainSize());

		const tween = animate && !this.reducedMotion?.matches;
		strip.classList.toggle("is-settling", tween);
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		if (tween) {
			this.settleTimer = window.setTimeout(() => {
				strip.classList.remove("is-settling");
				this.settleTimer = null;
			}, SETTLE_MS);
		}

		this.refresh();
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

	// --- render (strip offset + gentle magnification) ----------------------

	/**
	 * Coalesced to one write per frame: apply the strip's scroll offset, then a
	 * GENTLE length/opacity falloff on each tick measured by its screen distance
	 * from the fixed center marker — ticks near the marker are a touch longer and
	 * fuller, distant ones recede. This is the subtle fisheye, not a reposition.
	 */
	private refresh() {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			const ruler = this.ruler;
			const strip = this.strip;
			if (!ruler || !strip) return;

			void ruler;
			strip.style.transform = this.horizontal
				? `translateX(${this.stripOffset.toFixed(1)}px)`
				: `translateY(${this.stripOffset.toFixed(1)}px)`;

			const center = this.mainSize() / 2;
			for (let i = 0; i < this.tickEls.length; i++) {
				const tick = this.tickEls[i];
				const kind = tick.classList.contains("vc__tick--year")
					? TICK.year
					: TICK.cadence;
				// Screen position of this tick along the main axis = strip offset +
				// its position in the strip.
				const screen = this.stripOffset + this.tickY(this.tickTimes[i]);
				const dist = Math.abs(screen - center);

				const eased = smoothstep(1 - dist / MAGNIFY_SPREAD);
				const len = kind.base + (kind.max - kind.base) * MAGNIFY_GAIN * eased;
				tick.style.setProperty("--vc-tick-len", `${len.toFixed(1)}px`);

				const prox = Math.max(0, 1 - dist / FADE_SPREAD);
				const op = FADE_MIN + (1 - FADE_MIN) * prox;
				tick.style.setProperty("--vc-tick-op", op.toFixed(2));
			}
		});
	}
}

if (
	typeof customElements !== "undefined" &&
	!customElements.get("video-carousel")
) {
	customElements.define("video-carousel", VideoCarouselElement);
}
