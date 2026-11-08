import { afterEach, describe, expect, mock, test } from "bun:test";

// The repo tests under bun with no DOM library, so this is the slice of the DOM
// the element touches. Layout is whatever a test sets on the ruler; events go
// straight to the node they're dispatched on.
class FakeElement extends EventTarget {
	children: FakeElement[] = [];
	attrs = new Map<string, string>();
	classes = new Set<string>();
	dataset: Record<string, string> = {};
	style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
		setProperty(k: string, v: string) {
			this[k] = v;
		},
	};
	textContent = "";
	clientWidth = 0;
	clientHeight = 0;
	captured = new Set<number>();

	classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
		toggle: (c: string, force: boolean) =>
			void (force ? this.classes.add(c) : this.classes.delete(c)),
	};

	set className(v: string) {
		this.classes = new Set(v.split(/\s+/).filter(Boolean));
	}
	getAttribute(n: string) {
		return this.attrs.get(n) ?? null;
	}
	setAttribute(n: string, v: string) {
		this.attrs.set(n, v);
	}
	removeAttribute(n: string) {
		this.attrs.delete(n);
	}
	hasAttribute(n: string) {
		return this.attrs.has(n);
	}
	appendChild(c: FakeElement) {
		this.children.push(c);
		return c;
	}
	replaceChildren(...c: FakeElement[]) {
		this.children = c;
	}
	remove() {}
	canPlayType() {
		return "";
	}
	setPointerCapture(id: number) {
		this.captured.add(id);
	}
	releasePointerCapture(id: number) {
		this.captured.delete(id);
	}
	getBoundingClientRect() {
		return {
			left: 0,
			top: 0,
			bottom: this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
		};
	}
	matches(sel: string) {
		const attr = /^\[(.+)\]$/.exec(sel);
		return attr ? this.attrs.has(attr[1]) : this.classes.has(sel.slice(1));
	}
	querySelectorAll<T = FakeElement>(sel: string): T[] {
		return this.children.flatMap((c) => [
			...(c.matches(sel) ? [c] : []),
			...c.querySelectorAll(sel),
		]) as T[];
	}
	querySelector<T = FakeElement>(sel: string): T | null {
		return this.querySelectorAll<T>(sel)[0] ?? null;
	}
}

let frames: Array<() => void> = [];
const flush = () => {
	// A frame can queue another: the initial select re-centres, which refreshes.
	while (frames.length) {
		const run = frames;
		frames = [];
		run.forEach((f) => f());
	}
};
let clock = 0; // each read is a second later, so the tick-sound throttle never bites

Object.assign(globalThis, {
	HTMLElement: FakeElement,
	window: Object.assign(globalThis, {
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
	}),
	document: {
		createElement: () => new FakeElement(),
		addEventListener() {},
		removeEventListener() {},
		head: new FakeElement(),
	},
	localStorage: { getItem: () => null },
	performance: { now: () => (clock += 1000) },
	requestAnimationFrame: (f: () => void) => frames.push(f),
	cancelAnimationFrame() {},
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});

let ticks = 0;
mock.module("./tick-sound", () => ({
	loadTick() {},
	resumeTick() {},
	playTick: () => void ticks++,
}));

const { VideoCarouselElement } = await import("./index");

const CLIPS = [
	{ src: "a.mp4", desc: "A", loc: "Here", date: "Feb 2024" },
	{ src: "b.mp4", desc: "B", loc: "There", date: "Apr 2024" },
	{ src: "c.mp4", desc: "C", loc: "", date: "Jun 2024" },
	{ src: "d.mp4", desc: "D", loc: "Far", date: "Aug 2024" },
];
const RULER_W = 200;
const CENTER = RULER_W / 2;
const GAP = 13; // dates two months apart sit one cadence tick apart

const child = (attr?: string) => {
	const el = new FakeElement();
	if (attr) el.setAttribute(attr, "");
	return el;
};

type Host = FakeElement & {
	connectedCallback(): void;
	disconnectedCallback(): void;
};
let mounted: Host[] = [];

function mount(attrs: Record<string, string> = {}, clips = CLIPS) {
	const host = new VideoCarouselElement() as unknown as Host;
	const ruler = child("data-vc-ruler");
	ruler.clientWidth = RULER_W;
	ruler.clientHeight = RULER_W;
	for (const c of clips) {
		const t = new FakeElement();
		t.className = "vc__tick vc__tick--major";
		Object.assign(t.dataset, c);
		ruler.appendChild(t);
	}
	const grid = child("data-vc-grid");
	grid.setAttribute("src", clips[0].src);
	const replays = { count: 0 };
	Object.assign(grid, { replay: () => replays.count++ });
	const desc = child("data-vc-desc");
	const loc = child("data-vc-loc");
	// Nested away from the caption: the fields may sit anywhere in light DOM.
	const date = child("data-vc-date");
	const wrap = new FakeElement();
	wrap.appendChild(date);
	[ruler, grid, desc, loc, wrap].forEach((c) => host.appendChild(c));

	host.setAttribute("orientation", "horizontal");
	for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, v);

	type Seen = { type: string; bubbles: boolean; detail: any };
	const events: Seen[] = [];
	for (const type of ["change", "scrubstart", "scrubend"]) {
		host.addEventListener(`video-carousel:${type}`, (e) => {
			const ev = e as CustomEvent;
			events.push({ type, bubbles: ev.bubbles, detail: ev.detail });
		});
	}
	host.connectedCallback();
	flush();
	mounted.push(host);

	const pointer = (type: string, x: number, y = 10, extra: object = {}) => {
		const e = new Event(type);
		Object.assign(e, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, ...extra });
		ruler.dispatchEvent(e);
		flush();
	};
	return {
		host,
		ruler,
		grid,
		desc,
		loc,
		date,
		events,
		replays,
		pointer,
		ended: () => host.dispatchEvent(new Event("dotted-grid:ended")),
		key: (key: string) => {
			const e = new Event("keydown");
			Object.assign(e, { key });
			ruler.dispatchEvent(e);
			flush();
		},
		changes: () => events.filter((e) => e.type === "change"),
		order: () => events.map((e) => e.type),
		offset: () =>
			Number(/translateX\((.+)px\)/.exec(String(ruler.children[0].style.transform))?.[1]),
		index: () => Number(ruler.getAttribute("aria-valuenow")),
	};
}

afterEach(() => {
	mounted.forEach((h) => h.disconnectedCallback());
	mounted = [];
	frames = [];
	ticks = 0;
});

describe("the date field", () => {
	test("is written on select, wherever it sits in light DOM", () => {
		const c = mount();
		expect(c.date.textContent).toBe("Feb 2024");
		c.key("ArrowRight");
		expect(c.date.textContent).toBe("Apr 2024");
	});

	test("is optional", () => {
		const c = mount();
		c.host.children = c.host.children.filter((n) => n.children[0] !== c.date);
		expect(() => c.key("ArrowRight")).not.toThrow();
	});
});

describe("video-carousel:change", () => {
	test("bubbles with the detail, after the fields are written", () => {
		const c = mount();
		let seen = "";
		c.host.addEventListener("video-carousel:change", () => {
			seen = [c.desc.textContent, c.loc.textContent, c.date.textContent].join("|");
		});
		c.key("ArrowRight");
		expect(seen).toBe("B|There|Apr 2024");
		const last = c.changes().at(-1)!;
		expect(last.bubbles).toBe(true);
		expect(last.detail.index).toBe(1);
		expect(last.detail.clip.desc).toBe("B");
		expect(last.detail.userDriven).toBe(true);
		expect(last.detail.changed).toBe(true);
	});

	test("the initial select reports nothing changed", () => {
		const c = mount();
		expect(c.changes()).toHaveLength(1);
		expect(c.changes()[0].detail).toMatchObject({
			index: 0,
			userDriven: false,
			changed: false,
		});
	});

	test("autoplay is not user-driven", () => {
		const c = mount();
		c.ended();
		expect(c.changes().at(-1)!.detail).toMatchObject({
			index: 1,
			userDriven: false,
			changed: true,
		});
	});
});

describe("pressing the ruler", () => {
	// February is half a cadence step along, after the strip's one padding tick.
	const resting = CENTER - 1.5 * GAP;

	test("a tap never scrubs, and selects the clip under it", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER + 2 * GAP);
		c.pointer("pointermove", CENTER + 2 * GAP + 3);
		c.pointer("pointerup", CENTER + 2 * GAP + 3);
		expect(c.order()).toEqual(["change", "change"]);
		expect(c.changes()[1].detail).toMatchObject({
			index: 2,
			userDriven: true,
			changed: true,
		});
	});

	test("movement inside the slop leaves the strip alone", () => {
		const c = mount();
		expect(c.offset()).toBe(resting);
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 4);
		expect(c.offset()).toBe(resting);
		expect(c.ruler.classes.has("is-dragging")).toBe(false);
		expect(c.order()).toEqual(["change"]);
	});

	test("a scrub announces start, then its selections, then end", () => {
		const c = mount({ "tick-src": "tick.wav" });
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 5);
		expect(c.ruler.classes.has("is-dragging")).toBe(true);
		c.pointer("pointermove", CENTER - 10);
		c.pointer("pointermove", CENTER - 5 - GAP - 2);
		expect(c.index()).toBe(1);
		c.pointer("pointerup", CENTER - 5 - GAP - 2);
		expect(c.order()).toEqual([
			"change", // connect
			"scrubstart",
			"change", // the live crossing
			"change", // the final select, on the same clip
			"scrubend",
		]);
		const [, start, live, final, end] = c.events;
		expect(start.bubbles).toBe(true);
		expect(live.detail).toMatchObject({ index: 1, userDriven: true, changed: true });
		expect(final.detail).toMatchObject({ index: 1, userDriven: true, changed: false });
		expect(end.bubbles).toBe(true);
		expect(end.detail).toEqual({ cancelled: false });
		expect(ticks).toBe(1);
	});

	test("the strip tracks the pointer from where the scrub began", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 6);
		expect(c.offset()).toBe(resting);
		c.pointer("pointermove", CENTER - 9);
		expect(c.offset()).toBe(resting - 3);
	});

	test("a vertical pan doesn't scrub and the cancel selects nothing", () => {
		const c = mount({ "tick-src": "tick.wav" });
		const src = c.grid.getAttribute("src");
		c.pointer("pointerdown", CENTER + 2 * GAP, 10);
		c.pointer("pointermove", CENTER + 2 * GAP + 1, 30);
		c.pointer("pointercancel", 0, 60);
		expect(c.order()).toEqual(["change"]); // connect only
		expect(c.index()).toBe(0);
		expect(c.grid.getAttribute("src")).toBe(src);
		expect(c.replays.count).toBe(0);
		expect(c.offset()).toBe(resting);
		expect(ticks).toBe(0);
	});

	test("a pan that wanders past the slop still doesn't scrub", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER, 10);
		c.pointer("pointermove", CENTER - 8, 40);
		expect(c.order()).toEqual(["change"]);
		expect(c.offset()).toBe(resting);
	});

	test("a vertical ruler scrubs along Y and has no cross-axis gate", () => {
		const c = mount({ orientation: "vertical" });
		c.pointer("pointerdown", CENTER, CENTER);
		c.pointer("pointermove", CENTER + 40, CENTER - 6);
		expect(c.order()).toEqual(["change", "scrubstart"]);
	});

	test("cancelling a scrub restores the strip and selects nothing more", () => {
		const c = mount({ "tick-src": "tick.wav" });
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 5);
		c.pointer("pointermove", CENTER - 5 - GAP - 8); // past clip 1, short of clip 2
		expect(c.index()).toBe(1);
		const before = c.changes().length;
		c.pointer("pointercancel", 0);
		expect(c.changes()).toHaveLength(before);
		expect(c.index()).toBe(1);
		expect(c.offset()).toBe(resting - GAP);
		expect(c.ruler.classes.has("is-dragging")).toBe(false);
		expect(c.events.at(-1)).toMatchObject({
			type: "scrubend",
			bubbles: true,
			detail: { cancelled: true },
		});
		expect(ticks).toBe(1); // the crossing, and nothing for the cancel
	});

	test("cancel leaves the pointer free for the next press", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.pointer("pointercancel", 0);
		expect(c.ruler.captured.size).toBe(0);
		c.pointer("pointerdown", CENTER + GAP);
		c.pointer("pointerup", CENTER + GAP);
		expect(c.index()).toBe(1);
	});

	test("a second finger neither moves nor ends the press", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.pointer("pointerdown", CENTER + 50, 10, { pointerId: 2, isPrimary: false });
		c.pointer("pointermove", CENTER - 40, 10, { pointerId: 2, isPrimary: false });
		c.pointer("pointerup", CENTER - 40, 10, { pointerId: 2, isPrimary: false });
		expect(c.order()).toEqual(["change"]);
		c.pointer("pointerup", CENTER);
		expect(c.order()).toEqual(["change", "change"]);
	});

	test("a press whose pointerup went missing doesn't wedge the ruler", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 6);
		c.pointer("pointerdown", CENTER + GAP); // no pointerup came
		expect(c.events.at(-1)).toMatchObject({
			type: "scrubend",
			detail: { cancelled: true },
		});
		c.pointer("pointerup", CENTER + GAP);
		expect(c.index()).toBe(1);
	});
});

describe("a clip ending during a press", () => {
	test("with no press, advances at once", () => {
		const c = mount();
		c.ended();
		expect(c.index()).toBe(1);
	});

	test("waits for the press, and a cancel still advances, silently", () => {
		const c = mount({ "tick-src": "tick.wav" });
		c.pointer("pointerdown", CENTER, 10);
		c.ended();
		expect(c.index()).toBe(0);
		c.pointer("pointermove", CENTER, 40);
		c.pointer("pointercancel", 0, 60);
		expect(c.index()).toBe(1);
		expect(c.changes().at(-1)!.detail).toMatchObject({
			index: 1,
			userDriven: false,
			changed: true,
		});
		expect(c.changes()).toHaveLength(2);
		expect(ticks).toBe(0);
	});

	test("releasing on the clip that ended advances instead of replaying it", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.ended();
		c.pointer("pointerup", CENTER);
		expect(c.index()).toBe(1);
		expect(c.replays.count).toBe(0);
		expect(c.changes().at(-1)!.detail.userDriven).toBe(false);
	});

	test("a scrub cancelled over the ended clip advances before scrubend", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 5);
		c.ended();
		c.pointer("pointercancel", 0);
		expect(c.index()).toBe(1);
		expect(c.order().slice(-2)).toEqual(["change", "scrubend"]);
	});

	test("tapping a different clip doesn't skip past it", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER + 2 * GAP);
		c.ended();
		c.pointer("pointerup", CENTER + 2 * GAP);
		expect(c.index()).toBe(2);
		expect(c.changes()).toHaveLength(2);
	});

	test("an end from before the scrub moved on is forgotten", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.ended();
		c.pointer("pointermove", CENTER - 5);
		c.pointer("pointermove", CENTER - 5 - GAP - 2); // now on clip 1
		c.pointer("pointercancel", 0);
		expect(c.index()).toBe(1);
	});

	test("doesn't carry over to the next press", () => {
		const c = mount();
		c.pointer("pointerdown", CENTER);
		c.ended();
		c.pointer("pointerup", CENTER); // advanced to clip 1
		c.pointer("pointerdown", CENTER);
		c.pointer("pointerup", CENTER);
		expect(c.index()).toBe(1);
	});
});

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();

describe("styles", () => {
	const rule = (sel: string) =>
		new RegExp(`(?:^|\\n)${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

	test("only the horizontal ruler shares its gesture with the page", () => {
		expect(rule(".vc__ruler--horizontal")).toContain("touch-action: pan-y");
		expect(rule(".vc__ruler")).toContain("touch-action: none");
	});
});

describe('axis="even"', () => {
	// Seven clips bunched by date: three in one month, the rest years apart.
	const bunched = ["Apr 2025", "Apr 2025", "Apr 2025", "Jun 2025", "Jan 2026", "Jan 2027", "Jan 2030"].map(
		(date, i) => ({ src: `${i}.mp4`, desc: `${i}`, loc: "", date })
	);
	const strip = (c: ReturnType<typeof mount>) => c.ruler.children[0];

	test("makes one tick per clip at an even 13px pitch", () => {
		const c = mount({ axis: "even" }, bunched);
		const ticks = strip(c).children;
		expect(ticks).toHaveLength(bunched.length);
		expect(ticks.map((t) => t.style.left)).toEqual(
			bunched.map((_, i) => `${(i * 13).toFixed(1)}px`)
		);
	});

	test("lays out along Y on a vertical ruler", () => {
		const c = mount({ axis: "even", orientation: "vertical" }, bunched);
		expect(strip(c).children.map((t) => t.style.top)).toEqual(
			bunched.map((_, i) => `${(i * 13).toFixed(1)}px`)
		);
		expect(strip(c).style.transform).toBe(`translateY(${CENTER.toFixed(1)}px)`);
	});

	test("omits year ticks and labels, even on a whole-year step", () => {
		const c = mount({ axis: "even" }, bunched); // step 6 would be a whole year
		expect(strip(c).children.some((t) => t.classes.has("vc__tick--year"))).toBe(false);
		expect(strip(c).querySelectorAll(".vc__tick-year")).toHaveLength(0);
	});

	test("puts the selected tick under the center marker", () => {
		const c = mount({ axis: "even" }, bunched);
		expect(c.offset()).toBe(CENTER);
		for (let i = 1; i < bunched.length; i++) {
			c.key("ArrowRight");
			expect(c.offset()).toBe(CENTER - i * 13);
		}
	});

	test("reaches every clip by dragging, one tick at a time", () => {
		const c = mount({ axis: "even" }, bunched);
		c.pointer("pointerdown", CENTER);
		c.pointer("pointermove", CENTER - 5);
		const reached = [c.index()];
		for (let x = CENTER - 5; x > CENTER - 5 - 6 * 13 - 1; x--) {
			c.pointer("pointermove", x);
			if (c.index() !== reached.at(-1)) reached.push(c.index());
		}
		expect(reached).toEqual([0, 1, 2, 3, 4, 5, 6]);
		c.pointer("pointerup", CENTER - 5 - 6 * 13 - 1);
		expect(c.index()).toBe(6);
	});

	test("taps the tick nearest the finger", () => {
		const c = mount({ axis: "even" }, bunched);
		c.pointer("pointerdown", CENTER + 3 * 13 + 2);
		c.pointer("pointerup", CENTER + 3 * 13 + 2);
		expect(c.index()).toBe(3);
	});

	test("the default axis still spaces by date and labels the years", () => {
		const c = mount({}, bunched);
		expect(strip(c).children.length).toBeGreaterThan(bunched.length);
		expect(strip(c).querySelectorAll(".vc__tick-year").length).toBeGreaterThan(0);
	});
});
