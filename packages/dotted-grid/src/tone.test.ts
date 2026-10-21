import { describe, expect, test } from "bun:test";
import {
	autoGlow,
	paletteMix,
	parsePolarity,
	readNumber,
	resolveTone,
	TONE_DEFAULTS,
	toneEquals,
	type RGB,
} from "./tone";

// A tiny colour parser for the tests: #rrggbb only, null for anything else
// (the element's real one goes through a canvas).
const hex = (v: string): RGB | null => {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v.trim());
	return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
};

const reader = (map: Record<string, string>) => (name: string) => map[name] ?? null;
const css = (map: Record<string, string>) => (name: string) => map[name] ?? "";

const tone = (attrs: Record<string, string> = {}, vars: Record<string, string> = {}, warn?: (m: string) => void) =>
	resolveTone(reader(attrs), css(vars), hex, warn);

describe("resolveTone precedence", () => {
	test("attribute beats variable beats default", () => {
		expect(tone().gamma).toBe(TONE_DEFAULTS.gamma);
		expect(tone({}, { "--dg-gamma": "0.4" }).gamma).toBe(0.4);
		expect(tone({ gamma: "1.5" }, { "--dg-gamma": "0.4" }).gamma).toBe(1.5);
	});

	test("colours follow the same order, then the site tokens", () => {
		const tokens = { "--color-fg": "#ffffff", "--color-bg": "#000000" };
		expect(tone({}, tokens).ink).toEqual([1, 1, 1]);
		expect(tone({}, { ...tokens, "--dg-ink": "#191918" }).ink).toEqual(hex("#191918")!);
		expect(tone({ ink: "#ff0000" }, { ...tokens, "--dg-ink": "#191918" }).ink).toEqual([1, 0, 0]);
		expect(tone({}, { ...tokens, "--dg-paper": "#fff8eb" }).paper).toEqual(hex("#fff8eb")!);
	});

	test("with nothing set at all, the hard fallbacks", () => {
		const t = tone();
		expect(t.ink).toEqual(TONE_DEFAULTS.ink);
		expect(t.paper).toEqual(TONE_DEFAULTS.paper);
	});
});

describe("bad values", () => {
	test("an unparseable attribute falls through to the variable, then the default", () => {
		expect(tone({ gamma: "lots" }, { "--dg-gamma": "0.4" }).gamma).toBe(0.4);
		expect(tone({ gamma: "lots" }).gamma).toBe(TONE_DEFAULTS.gamma);
		expect(tone({ ink: "not-a-colour" }, { "--color-fg": "#ffffff" }).ink).toEqual([1, 1, 1]);
	});

	test("out-of-range numbers fall back or clamp", () => {
		// gamma 0 would collapse the image: rejected, not clamped.
		expect(tone({ gamma: "0" }).gamma).toBe(TONE_DEFAULTS.gamma);
		expect(tone({ "dot-scale": "-1" }).dotScale).toBe(TONE_DEFAULTS.dotScale);
		// 0..1 levers clamp, and 0 is a real setting.
		expect(tone({ cutoff: "2" }).cutoff).toBe(1);
		expect(tone({ cutoff: "-1" }).cutoff).toBe(0);
		expect(tone({ bloom: "0" }).bloom).toBe(0);
		expect(tone({ levels: "0" }).levels).toBe(0);
	});

	test("a broken variable is reported, an 'auto' glow is not", () => {
		const warnings: string[] = [];
		tone({}, { "--dg-gamma": "oops", "--dg-glow": "auto" }, (m) => warnings.push(m));
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("--dg-gamma");
	});

	test("readNumber", () => {
		expect(readNumber(null)).toBeNull();
		expect(readNumber("  ")).toBeNull();
		expect(readNumber("1.5")).toBe(1.5);
		expect(readNumber("0", { min: 0, exclusiveMin: true })).toBeNull();
		expect(readNumber("-3", { min: 0, clamp: true })).toBe(0);
		expect(readNumber("NaN")).toBeNull();
	});
});

describe("glow", () => {
	test("auto is the paper's contrast pole", () => {
		expect(autoGlow(hex("#fff8eb")!)).toEqual([0, 0, 0]);
		expect(autoGlow([0.05, 0.05, 0.05])).toEqual([1, 1, 1]);
		expect(tone({}, { "--dg-paper": "#fff8eb" }).glow).toEqual([0, 0, 0]);
		expect(tone({}, { "--dg-paper": "#101010", "--dg-glow": "auto" }).glow).toEqual([1, 1, 1]);
	});

	test("an explicit glow wins", () => {
		expect(tone({ glow: "#00ff00" }, { "--dg-paper": "#fff8eb" }).glow).toEqual([0, 1, 0]);
	});
});

describe("polarity", () => {
	test("parsing", () => {
		expect(parsePolarity("positive")).toBe(0);
		expect(parsePolarity(" Negative ")).toBe(1);
		expect(parsePolarity("inverted")).toBeNull();
		expect(parsePolarity(null)).toBeNull();
	});

	test("defaults to positive, reads attr and variable", () => {
		expect(tone().polarity).toBe(0);
		expect(tone({}, { "--dg-polarity": "negative" }).polarity).toBe(1);
		expect(tone({ polarity: "positive" }, { "--dg-polarity": "negative" }).polarity).toBe(0);
		expect(tone({ polarity: "sideways" }).polarity).toBe(0);
	});
});

describe("ink-hi", () => {
	test("defaults to the ink (a flat ink)", () => {
		const t = tone({}, { "--dg-ink": "#191918" });
		expect(t.inkHi).toEqual(t.ink);
	});

	test("set, it makes a duotone", () => {
		const t = tone({}, { "--dg-ink": "#191918", "--dg-ink-hi": "#ff0000" });
		expect(t.inkHi).toEqual([1, 0, 0]);
		expect(t.ink).toEqual(hex("#191918")!);
	});
});

describe("derived", () => {
	test("the reveal palette leans toward the ink only on light paper", () => {
		expect(paletteMix([0, 0, 0])).toBe(0);
		expect(paletteMix(hex("#fff8eb")!)).toBe(1);
	});

	test("dot-shape keywords and numbers", () => {
		expect(tone({ "dot-shape": "circle" }).dotShape).toBe(1);
		expect(tone({}, { "--dg-dot-shape": "square" }).dotShape).toBe(0);
		expect(tone({ "dot-shape": "7" }).dotShape).toBe(2);
		expect(tone({ "dot-shape": "blob" }).dotShape).toBe(TONE_DEFAULTS.dotShape);
	});

	test("toneEquals sees a changed colour", () => {
		const a = tone({}, { "--dg-ink": "#191918" });
		expect(toneEquals(a, tone({}, { "--dg-ink": "#191918" }))).toBe(true);
		expect(toneEquals(a, tone({}, { "--dg-ink": "#191919" }))).toBe(false);
		expect(toneEquals(null, a)).toBe(false);
	});
});
