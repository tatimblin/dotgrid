/**
 * TONE: everything about how a <dotted-grid> LOOKS, as opposed to what it plays.
 *
 * Each setting is read from three places, first hit wins:
 *
 *   1. the element's attribute       ink="#191918"
 *   2. a CSS custom property         --dg-ink: #191918;
 *   3. the default below
 *
 * The CSS route is the theming one: a stylesheet can scope a preset to a theme
 * ([data-theme="light"] .hero dotted-grid { --dg-gamma: .4 }) and the element
 * picks the new values up when the theme flips. An ATTRIBUTE ALWAYS BEATS ITS
 * VARIABLE, so a tuning attribute left on an element pins that setting in every
 * theme; a preset that seems to do nothing usually means exactly that.
 *
 * A value that does not parse falls through to the next source rather than
 * becoming NaN on the GPU. Pure (no DOM): the element passes in the three
 * readers, so this can be unit-tested (tone.test.ts).
 */

export type RGB = [number, number, number];

/** Polarity, as the shader's 0/1. */
export const POLARITY = { positive: 0, negative: 1 } as const;

/** `dot-shape` keyword to shader enum. Numbers 0..2 pass through. */
export const DOT_SHAPES: Record<string, number> = { square: 0, circle: 1, morph: 2 };

export interface Tone {
	/** Dot colour (the faintest dot's, when ink-hi is set). */
	ink: RGB;
	/** Fullest dot's colour; equal to ink unless a duotone was asked for. */
	inkHi: RGB;
	/** Backdrop colour. */
	paper: RGB;
	/** What highlights, bloom and hatch lean toward. */
	glow: RGB;
	/** 0 positive (dots on highlights), 1 negative (dots on shadows). */
	polarity: number;
	/** 0..1, the reveal palette's pull toward the ink (derived from the paper). */
	paletteMix: number;
	gamma: number;
	contrast: number;
	cutoff: number;
	feather: number;
	dotScale: number;
	levels: number;
	bloom: number;
	crosshatch: number;
	denoise: number;
	dotShape: number;
}

export const TONE_DEFAULTS = {
	ink: [0.9, 0.9, 0.9] as RGB, // used only when --color-fg is missing too
	paper: [0, 0, 0] as RGB, // ditto --color-bg
	polarity: POLARITY.positive,
	gamma: 0.8, // luminance shaping exponent (>1 darkens mids)
	contrast: 1.1, // luminance contrast around 0.5
	cutoff: 0, // 0 => no black point
	feather: 0, // 0 => the cutoff is a hard edge
	dotScale: 1, // 1 fills the cell edge to edge
	levels: 5, // discrete steps; <=1 => continuous
	bloom: 0.55,
	crosshatch: 0.35,
	denoise: 0,
	dotShape: DOT_SHAPES.morph,
} as const;

/**
 * The numeric settings: attribute name (the CSS variable is `--dg-` + it), the
 * key in Tone, and the accepted range. `min` is inclusive; a value below it, or
 * above `max`, is clamped when `clamp` is set and rejected otherwise (gamma 0
 * would collapse the image, so it falls back instead of clamping).
 */
const NUMBERS: Array<{
	attr: string;
	key: "gamma" | "contrast" | "cutoff" | "feather" | "dotScale" | "levels" | "bloom" | "crosshatch" | "denoise";
	min: number;
	max?: number;
	exclusiveMin?: boolean;
	clamp?: boolean;
}> = [
	{ attr: "gamma", key: "gamma", min: 0, exclusiveMin: true },
	{ attr: "contrast", key: "contrast", min: 0, exclusiveMin: true },
	{ attr: "dot-scale", key: "dotScale", min: 0, exclusiveMin: true },
	{ attr: "levels", key: "levels", min: 0 },
	{ attr: "cutoff", key: "cutoff", min: 0, max: 1, clamp: true },
	{ attr: "feather", key: "feather", min: 0, max: 1, clamp: true },
	{ attr: "denoise", key: "denoise", min: 0, max: 1, clamp: true },
	{ attr: "bloom", key: "bloom", min: 0, max: 1, clamp: true },
	{ attr: "crosshatch", key: "crosshatch", min: 0, max: 1, clamp: true },
];

/** Every attribute this module reads; the element observes them. */
export const TONE_ATTRS = [
	"ink",
	"ink-hi",
	"paper",
	"glow",
	"polarity",
	"dot-shape",
	...NUMBERS.map((n) => n.attr),
];

/**
 * Parse a number from an attribute/CSS string. Returns null for anything that
 * is not a finite number, or that falls outside the range without `clamp`.
 * Shared with the element's non-tone attributes (cell-size, intro, xfade, ...),
 * which use { min: 0, exclusiveMin: true } for "a positive number" and
 * { min: 0, clamp: true } for "zero allowed, negatives read as zero".
 */
export function readNumber(
	raw: string | null | undefined,
	opts: { min?: number; max?: number; exclusiveMin?: boolean; clamp?: boolean } = {}
): number | null {
	if (raw === null || raw === undefined) return null;
	const s = raw.trim();
	if (s === "") return null;
	const n = Number.parseFloat(s);
	if (!Number.isFinite(n)) return null;
	const { min, max, exclusiveMin, clamp } = opts;
	if (min !== undefined && (exclusiveMin ? n <= min : n < min)) {
		return clamp && !exclusiveMin ? min : null;
	}
	if (max !== undefined && n > max) return clamp ? max : null;
	return n;
}

/** Rec. 601 luma, matching the shader's. */
export function luma([r, g, b]: RGB): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** `glow: auto` — the contrast pole of the paper: black on light, white on dark. */
export function autoGlow(paper: RGB): RGB {
	return luma(paper) > 0.5 ? [0, 0, 0] : [1, 1, 1];
}

/**
 * How far the reveal palette leans toward the ink, from the paper's luma: 0 on
 * a dark paper (the palette was tuned there), ramping to 1 on a light one.
 */
export function paletteMix(paper: RGB): number {
	const t = Math.min(1, Math.max(0, (luma(paper) - 0.35) / 0.4));
	return t * t * (3 - 2 * t);
}

export function parsePolarity(raw: string | null | undefined): number | null {
	const s = raw?.trim().toLowerCase();
	if (s === "positive") return POLARITY.positive;
	if (s === "negative") return POLARITY.negative;
	return null;
}

export function parseDotShape(raw: string | null | undefined): number | null {
	const s = raw?.trim().toLowerCase();
	if (!s) return null;
	const named = DOT_SHAPES[s];
	if (named !== undefined) return named;
	const n = Number.parseFloat(s);
	return Number.isFinite(n) ? Math.min(2, Math.max(0, Math.round(n))) : null;
}

/** Reads an attribute; null when absent. */
export type AttrGet = (name: string) => string | null;
/** Reads a computed custom property; "" when unset. */
export type CssGet = (name: string) => string;
/** Parses any CSS colour; null when it is not one. */
export type ColorParse = (value: string) => RGB | null;
/** Called for a CSS variable that is set but unusable (dev builds only). */
export type Warn = (message: string) => void;

/**
 * Resolve the full tone for one element.
 *
 *   attr        the element's getAttribute
 *   css         a getComputedStyle(el).getPropertyValue reader
 *   parseColor  CSS colour -> RGB in 0..1
 *   warn        optional; told about variables that are set but do not parse
 */
export function resolveTone(attr: AttrGet, css: CssGet, parseColor: ColorParse, warn?: Warn): Tone {
	// First source that yields a value wins; an unparseable one is skipped.
	const pick = <T>(name: string, parse: (raw: string) => T | null): T | null => {
		const a = attr(name);
		if (a !== null && a.trim() !== "") {
			const v = parse(a);
			if (v !== null) return v;
		}
		const cssName = `--dg-${name}`;
		const c = css(cssName).trim();
		if (c !== "") {
			const v = parse(c);
			if (v !== null) return v;
			warn?.(`dotted-grid: ignoring ${cssName}: "${c}" (not a valid value)`);
		}
		return null;
	};

	const color = (raw: string) => parseColor(raw.trim());
	const fromToken = (token: string, fallback: RGB): RGB => {
		const v = css(token).trim();
		return (v && parseColor(v)) || fallback;
	};

	const ink = pick("ink", color) ?? fromToken("--color-fg", TONE_DEFAULTS.ink);
	const paper = pick("paper", color) ?? fromToken("--color-bg", TONE_DEFAULTS.paper);
	const inkHi = pick("ink-hi", color) ?? ink;
	// "auto" is a real value, not a parse failure: it resolves (without a
	// warning) to the sentinel below, which then means "derive from the paper".
	const AUTO: RGB = [-1, -1, -1];
	const glowPick = pick("glow", (raw) => (raw.trim().toLowerCase() === "auto" ? AUTO : color(raw)));
	const glow = glowPick && glowPick !== AUTO ? glowPick : autoGlow(paper);

	const tone: Tone = {
		ink,
		inkHi,
		paper,
		glow,
		polarity: pick("polarity", parsePolarity) ?? TONE_DEFAULTS.polarity,
		paletteMix: paletteMix(paper),
		dotShape: pick("dot-shape", parseDotShape) ?? TONE_DEFAULTS.dotShape,
		gamma: TONE_DEFAULTS.gamma,
		contrast: TONE_DEFAULTS.contrast,
		cutoff: TONE_DEFAULTS.cutoff,
		feather: TONE_DEFAULTS.feather,
		dotScale: TONE_DEFAULTS.dotScale,
		levels: TONE_DEFAULTS.levels,
		bloom: TONE_DEFAULTS.bloom,
		crosshatch: TONE_DEFAULTS.crosshatch,
		denoise: TONE_DEFAULTS.denoise,
	};
	for (const n of NUMBERS) {
		const v = pick(n.attr, (raw) => readNumber(raw, n));
		if (v !== null) tone[n.key] = v;
	}
	return tone;
}

/** Same tone? Used to skip a repaint when a theme flip changed nothing here. */
export function toneEquals(a: Tone | null, b: Tone | null): boolean {
	if (!a || !b) return a === b;
	for (const k of Object.keys(a) as Array<keyof Tone>) {
		const x = a[k];
		const y = b[k];
		if (Array.isArray(x) && Array.isArray(y)) {
			if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
		} else if (x !== y) return false;
	}
	return true;
}
