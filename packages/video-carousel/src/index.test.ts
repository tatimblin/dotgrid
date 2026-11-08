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
	const run = frames;
	frames = [];
	run.forEach((f) => f());
};

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
