import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * SHADER SOURCE HAZARDS.
 *
 * The GLSL in packages/dotted-grid (src/shader.ts) lives inside a JS template literal, which makes
 * two ordinary-looking edits break the build in ways the symptom does not point at:
 *
 *   1. A BACKTICK anywhere in that string — including inside a `// comment`, which
 *      is the tempting way to name a variable in prose — terminates the literal
 *      early. The failure surfaces as a TypeScript parse error on the comment line,
 *      so it reads as a syntax problem in code that is actually fine. This bit three
 *      times while building the transition modes.
 *   2. A GLSL RESERVED WORD used as an identifier (`active`, `static`, `sample`,
 *      `filter`, …) compiles fine as TypeScript and fails only at runtime, inside
 *      the WebGL compile step, where it degrades to a blank element rather than an
 *      error most people would notice.
 *
 * These are static checks on the source, so they run without a browser and catch
 * both before the module is ever served.
 */

const SRC = "packages/dotted-grid/src/shader.ts";
const OPEN = "export const FRAGMENT_SHADER = `";

/** Extract the fragment-shader template literal's contents. */
function shaderSource(): string {
	const file = readFileSync(SRC, "utf8");
	const open = file.indexOf(OPEN);
	expect(open, `could not find the fragment shader in ${SRC}`).toBeGreaterThan(-1);
	const start = open + OPEN.length;
	const end = file.indexOf("`;", start);
	expect(end, "fragment shader literal is unterminated").toBeGreaterThan(start);
	return file.slice(start, end);
}

test.describe("dotted-grid shader source", () => {
	test("contains no backticks (they would end the template literal)", () => {
		const offenders = shaderSource()
			.split("\n")
			.map((line, i) => ({ line: i + 1, text: line }))
			.filter((l) => l.text.includes("`"));

		expect(
			offenders,
			`backtick(s) inside the shader literal — use "quotes" in comments instead:\n` +
				offenders.map((o) => `  shader line ${o.line}: ${o.text.trim()}`).join("\n")
		).toEqual([]);
	});

	test("declares no variables named with a GLSL reserved word", () => {
		// Words that are reserved (or built-in) in GLSL ES 3.00 and are also natural
		// English choices for a local — the ones actually at risk of being typed.
		const RESERVED = [
			"active",
			"static",
			"sample",
			"filter",
			"input",
			"output",
			"common",
			"partition",
			"template",
			"this",
			"packed",
			"resource",
			"public",
			"external",
			"interface",
			"long",
			"short",
			"half",
			"fixed",
			"unsigned",
			"superp",
			"namespace",
			"using",
			"cast",
			"double",
			"volatile",
			"inline",
			"noinline",
		];

		// Match GLSL declarations: `float active = …`, `vec2 sample;`, etc.
		const declaration = new RegExp(
			String.raw`\b(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|const\s+float)\s+(${RESERVED.join("|")})\b`,
			"g"
		);

		const src = shaderSource();
		const hits = Array.from(src.matchAll(declaration)).map((m) => m[1]);
		expect(
			hits,
			`GLSL reserved word(s) used as identifiers — these compile as TS but fail ` +
				`at WebGL compile time and blank the element: ${hits.join(", ")}`
		).toEqual([]);
	});
});
