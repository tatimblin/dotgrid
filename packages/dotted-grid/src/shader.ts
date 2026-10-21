/**
 * The GLSL for <dotted-grid>, as exported strings.
 *
 * Kept apart from the element so it can be read, and statically checked (see
 * tests/shader-source.spec.ts), on its own. Two hazards live in these literals:
 * a BACKTICK anywhere inside one (comments included) ends it early, and a GLSL
 * reserved word used as an identifier compiles as TypeScript but fails at WebGL
 * compile time, which blanks the element.
 */

/** Pointer samples kept for the color-reveal trail (a uniform array bound). */
export const MAX_TRAIL = 32;

export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	// aPos spans the clip-space quad [-1,1]; map to [0,1] uv with v flipped
	// so the video is upright (texture origin is bottom-left).
	vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
#define MAX_TRAIL ${MAX_TRAIL}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform sampler2D uPrevTex;  // outgoing clip's last frame, during a transition

// CLIP TRANSITION. uXfade 0..1 walks the outgoing clip to the incoming one;
// 1 (the idle state) means "show uTex only" and skips every branch below.
// uXfadeMode selects the character of the transition — see TRANSITIONS in
// index.ts for the names.
uniform float uXfade;
uniform float uXfadeMode;
uniform vec2 uResolution;   // canvas size in device px
uniform float uVideoAspect; // video w/h
uniform float uCell;        // cell size in device px
uniform float uDotScale;    // max radius as fraction of cell half-size
uniform float uLevels;      // discrete brightness steps (<=1 => continuous)
uniform float uCutoff;      // dots at/below this brightness are not drawn at all
uniform float uDenoise;     // 0 = point-sample the cell centre, 1 = average the cell
uniform float uFeather;     // width (brightness units) of the dissolve above uCutoff
uniform float uPolarity;    // 0 positive (dots on highlights), 1 negative (dots on shadows)
uniform float uGamma;
uniform float uContrast;
// THE PALETTE. Colour is independent of polarity: polarity decides WHICH cells
// carry dots, these decide what the dots and the ground look like.
uniform vec3 uInk;          // dot colour for the faintest dot
uniform vec3 uInkHi;        // dot colour for the fullest dot (= uInk for a flat ink)
uniform vec3 uPaper;        // backdrop colour
uniform vec3 uGlow;         // what highlights, bloom and hatch lean toward
// 0..1: how far the vivid reveal palette is pulled toward the ink. The ANSI
// palette was tuned on a dark ground; on a light one its yellows, cyans and
// white vanish into the paper, so the CPU raises this with the paper's luma.
uniform float uPaletteMix;

// CRT "display" look. Each is off at 0 so a uniform branch skips its cost.
uniform float uShape;       // 0 square, 1 circle, 2 morph circle->rounded-square
uniform float uBloom;       // 0..1 glow + phosphor rim on bright dots
uniform float uCrosshatch;  // 0..1 cross-hatch marks in the darkest cells

// Color reveal: dots within the trail radius or caught by the shimmer show
// their true sampled color instead of the flat ink.
uniform vec2 uTrail[MAX_TRAIL]; // recent pointer positions, device px
uniform float uTrailAge[MAX_TRAIL]; // 0 = newest .. 1 = oldest
uniform int uTrailCount;    // active samples (0 => trail off)
uniform float uRevealRadius;// pointer influence radius, device px
uniform float uTime;        // seconds, for the shimmer pulse
uniform float uShimmer;     // fraction 0..1 of dots that shimmer (0 => off)
uniform float uRevealBoost; // 0 = raw sampled color, 1 = snap to ANSI palette

// INTRO WIPE. 0 = nothing drawn (flat backdrop), 1 = the full image. Cells
// cross in by BRIGHTNESS — the highlights arrive first and the shadows last,
// so the picture develops out of the background like a photographic print
// rather than cross-fading as one flat layer. 1 disables it entirely.
uniform float uIntro;
uniform float uIntroJitter; // randomness in the wavefront, in brightness units

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

// WHAT ONE CELL SEES. Point-sampling the centre asks a single texel to speak for
// the whole cell, and video is the worst possible source for that: an H.264 frame
// carries quantization noise and macroblock structure that no eye can see in the
// footage itself, but a halftone hands every one of those wobbles a vote on
// whether its cell lights up. The damage is nonlinear-shaped too -- pow(b, gamma)
// with a low gamma has a huge slope near black, so a 1/255 codec wobble in the
// shadows becomes a visible jump in dot size, and next to a cutoff it becomes
// presence or absence. That is what reads as salt-and-pepper strays and a
// dithered, ragged edge along a fold.
//
// Averaging the cell's own footprint answers the question the halftone is
// actually asking -- "how bright is this REGION" — instead of "how bright is this
// one texel". Five taps (centre plus the quarter-points) on a rotated-square
// pattern: enough to swamp per-texel noise, cheap because every fragment in a
// cell reads the same five texels, so they are already in cache.
//
// uDenoise blends between the two rather than switching, so a consumer can keep
// some of the grain if the noise is part of the look.
vec3 sampleCell(sampler2D tex, vec2 centerPx) {
	vec2 c = clamp(coverUv(centerPx / uResolution), 0.0, 1.0);
	vec3 mid = texture(tex, c).rgb;
	if (uDenoise <= 0.0) return mid;
	float o = uCell * 0.25;
	vec3 sum = mid;
	sum += texture(tex, clamp(coverUv((centerPx + vec2(-o, -o)) / uResolution), 0.0, 1.0)).rgb;
	sum += texture(tex, clamp(coverUv((centerPx + vec2( o, -o)) / uResolution), 0.0, 1.0)).rgb;
	sum += texture(tex, clamp(coverUv((centerPx + vec2(-o,  o)) / uResolution), 0.0, 1.0)).rgb;
	sum += texture(tex, clamp(coverUv((centerPx + vec2( o,  o)) / uResolution), 0.0, 1.0)).rgb;
	return mix(mid, sum * 0.2, uDenoise);
}

// Highlight lift: the fullest dots blend from the ink toward uGlow (by default
// white on a dark paper, black on a light one; see "glow" in tone.ts) so
// highlights glow instead of reading as same-color-but-bigger dots. HI_THRESHOLD is where the lift starts on the
// shaped brightness; HI_STRENGTH is how far it goes at full brightness.
const float HI_THRESHOLD = 0.75;
const float HI_STRENGTH = 0.85;

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
	vec3 snapped = mix(c, best, uRevealBoost);
	// On light paper, pull the palette part-way toward the ink so a revealed dot
	// still reads as a mark on the page rather than a hole in it. 0.45 keeps the
	// hue legible (yellow becomes ochre, white a mid grey) without going muddy.
	return mix(snapped, uInk, 0.45 * uPaletteMix);
}

void main() {
	// Work in device pixels so cells are square regardless of aspect.
	vec2 px = vUv * uResolution;
	vec2 cell = floor(px / uCell);
	vec2 cellCenterPx = (cell + 0.5) * uCell;

	// Sample the video over the cell (cover-mapped) — see sampleCell.
	vec2 sampleUv = coverUv(cellCenterPx / uResolution);
	vec2 sUv = clamp(sampleUv, 0.0, 1.0);
	vec3 src = sampleCell(uTex, cellCenterPx);

	// CLIP TRANSITION. Blends the outgoing frame into the incoming one PER CELL
	// rather than fading the whole stage, so the grid itself carries the cut.
	// Each mode decides, for this cell, how far along the blend it is: t < 0
	// means "still the old clip here", t > 1 "fully the new one". The dot's
	// brightness is then read from whichever mix that implies, so a cell can
	// finish switching before its neighbour has started.
	//
	// Uniform branch on the idle value, so a carousel sitting on one clip pays
	// nothing for any of this.
	//
	// xfPulse is a per-cell dot-SIZE multiplier a mode may drive, so a
	// transition can swell or collapse the dots as it passes through them
	// instead of only changing what they sample. Applied after the level ramp
	// (below) and clamped there, so a bulging dot fattens within its own cell
	// rather than bleeding into its neighbours and turning the grid to mush.
	float xfPulse = 1.0;
	// A transition may also tint its wake (xfTintAmt 0 = leave the dot colour
	// alone), so a mode can carry its own light — e.g. the phosphor green of a
	// code rain -- without permanently touching the element's "color" attribute.
	vec3 xfTint = vec3(1.0);
	float xfTintAmt = 0.0;

	if (uXfade < 1.0) {
		vec3 prev = sampleCell(uPrevTex, cellCenterPx);
		float t = uXfade;
		float m = uXfadeMode;

		if (m < 0.5) {
			// 0 THRESHOLD (default) — a hard per-cell flip, ordered by the INCOMING
			// dot's own value. The new clip's brightest cells claim their place first
			// and its shadows last, so the image assembles by its own structure:
			// highlights arrive as a sparse constellation that fills into a picture.
			// Each cell holds on the old clip until its moment, then switches — the
			// snap is the point, so this is deliberately not a soft cross-fade.
			// Ranked by dot SIZE rather than raw brightness, so under negative
			// polarity it is still the fullest dots that land first.
			float li = luma(src);
			float rank = 1.0 - mix(li, 1.0 - li, uPolarity); // 0 = fullest incoming dot
			// A hard-ish edge (0.12) rather than a soft shoulder: the flip should read
			// as a switch, not a fade. A sliver of jitter keeps cells of identical
			// value from popping as one flat sheet.
			float j = (hash(cell + 29.0) - 0.5) * 0.07;
			float k = smoothstep(rank + j, rank + j + 0.12, t * 1.12);
			src = mix(prev, src, k);
			// Brief overshoot as each cell lands, so the arrival has a tick to it.
			xfPulse = 1.0 + (k - k * k) * 1.6;
		} else {
			// 1 RAIN — Matrix code rain. Each COLUMN of dots has its own drop falling
			// down it; the clip is rewritten behind each drop as it passes, so the
			// image is literally typed down the screen in phosphor green.
			//
			// Most columns fall MORE THAN ONCE, writing new-then-old-then-new, so they
			// visibly flicker between the two clips before settling. Columns also
			// finish at staggered times, so the rain thins out and dies down rather
			// than every drop stopping at once.
			float cols = uResolution.x / uCell;
			float rows = uResolution.y / uCell;
			float col = floor(sUv.x * cols);
			float row = floor(sUv.y * rows);

			// Passes per column: 1..3, from a per-column hash.
			float passes = 1.0 + floor(hash(vec2(col, 13.0)) * 3.0);
			// Head start, as a fraction of ONE pass, so columns are out of step.
			float stagger = hash(vec2(col, 7.0)) * 0.6;

			// WHEN this column finishes, as a fraction of the transition: spread over
			// the second half and skewed (the square) so most land early and a few
			// stragglers trail, which is what makes the rain die down.
			float fin = hash(vec2(col, 19.0));
			float finish = 0.45 + 0.55 * fin * fin;

			// Travel in passes, normalized so this column completes exactly at its own
			// finish time and then HOLDS. Every column completes — none is left
			// mid-fall with the old clip still showing in its lower half.
			float local = clamp(t / finish, 0.0, 1.0);
			float travel = (local + stagger) / (1.0 + stagger) * passes;
			float pass = floor(travel);            // which pass this column is on
			float within = fract(travel);          // 0..1 progress through it

			// The drop's head, in rows, for the current pass. Runs from above the top
			// edge to past the bottom so the whole column is covered.
			float span = rows + 12.0;
			float head = within * span - 6.0;
			float d = head - row;                  // >0 once the drop has passed

			// Which clip this pass writes. The LAST pass must land on the incoming
			// clip, so alternate backwards from the end: with N passes total and some
			// complete, an even number remaining means this pass writes the new clip.
			float remaining = passes - 1.0 - pass;
			float writesNew = mod(remaining, 2.0) < 0.5 ? 1.0 : 0.0;
			// Cells the drop has passed show this pass's target; cells ahead of it show
			// whatever the previous pass left, which is the opposite clip (or, on the
			// first pass, the outgoing one).
			float behind = clamp(d * 0.6, 0.0, 1.0);
			float already = (pass < 0.5) ? 0.0 : (1.0 - writesNew);
			float k = mix(already, writesNew, behind);
			src = mix(prev, src, k);

			// The drop itself: a soft green trail ABOVE the head, fading upward. No
			// enlarged or whitened head cell — the leading edge reads as the brightest
			// point of the trail rather than a blob travelling down the column.
			float trail = (d <= 0.0) ? clamp(1.0 + d / 10.0, 0.0, 1.0) : 0.0;
			xfTint = vec3(0.35, 1.0, 0.45);
			xfTintAmt = trail * 0.85;
			src += vec3(0.10) * trail;
		}
	}

	// Brightness -> shaped value in [0,1].
	float b = luma(src);
	b = clamp((b - 0.5) * uContrast + 0.5, 0.0, 1.0);
	b = pow(b, uGamma);
	// POLARITY: positive puts the dots on the highlights (bright = big dot),
	// negative on the shadows. It says nothing about colour; that is uInk/uPaper.
	float amount = mix(b, 1.0 - b, uPolarity);

	// ASCII-ramp look: snap brightness to a few discrete steps so the grid
	// reads as stepped glyph densities rather than a smooth size gradient.
	// Level 0 is empty; the top level fills the whole cell (solid block).
	// The pre-quantization value, kept for the feather below. The ramp's whole
	// job is to snap sizes to a few rungs, so nothing downstream of it can fade
	// anything smoothly — a dissolve needs the continuous signal back.
	float raw = amount;

	if (uLevels > 1.0) {
		float step = round(amount * uLevels) / uLevels;
		amount = step;
	}

	// BLACK POINT. Below uCutoff a cell draws no dot at all — bare background,
	// not a minimum-size speck. Without it the ramp's floor is whatever the
	// quantizer's lowest non-zero rung happens to be (1/uLevels), so a merely
	// dim region still reads as an even field of small dots; the grid can never
	// go sparse. Note round() above makes the empty rung only half as wide as
	// the others, so "off" is the hardest value in the ramp to actually land on
	// — this is the lever that widens it.
	//
	// Deliberately AFTER quantization so the setting composes with "levels" as
	// "drop the bottom N rungs" rather than shifting where every rung falls,
	// and BEFORE the intro wipe so a cut-off cell stays empty throughout the
	// entrance instead of growing in and then popping out at the end.
	//
	// <= , so cutoff exactly on a rung (0.2 with levels=5) clears that rung
	// rather than leaving it a hair above the line.
	//
	// cellOn carries the verdict down to the CRT layers below, because "no dot"
	// is not the same as "nothing here" — the crosshatch keys on LOW amount and
	// so would come up to FULL strength in exactly the cells this just emptied,
	// replacing every cut dot with an engraving mark and leaving the flat field
	// the cutoff was reached for in the first place. Switching a cell off has to
	// switch off everything the cell draws.
	//
	// Gated on uCutoff > 0 so the lever is genuinely inert at its default: an
	// already-black cell keeps its hatch exactly as before, and only a cutoff
	// someone asked for takes cells all the way out.
	float cellOn = 1.0;
	if (uCutoff > 0.0 && amount <= uCutoff) {
		amount = 0.0;
		cellOn = 0.0;
	}

	// FEATHER. The cutoff on its own is a cliff, and the ramp above it cannot
	// soften one: quantization means the lowest surviving rung arrives at its
	// full size: 1/levels of the cell, all at once, along whatever contour the
	// threshold happens to trace. The field therefore ends at a hard coastline
	// however well the tone curve is set.
	//
	// So dots in a band above the cutoff scale continuously to nothing, against
	// "raw" — the un-quantized brightness — which is the only signal left that
	// still varies smoothly across that contour. The edge of the field becomes a
	// gradient of shrinking dots that dissolve into the background, and because
	// the dot mask feathers by coverage once a dot drops below a pixel, the very
	// last of it fades in alpha rather than blinking out.
	//
	// cellOn carries the same fade (not a binary any more) so every other layer
	// leaves with the dots instead of standing there once they have gone.
	if (uFeather > 0.0) {
		float fade = smoothstep(uCutoff, uCutoff + uFeather, raw);
		amount *= fade;
		cellOn = min(cellOn, fade);
	}

	// Where this dot sits on the ink ramp (uInk -> uInkHi). Taken BEFORE the
	// intro scales amount, so a dot growing in already wears its final colour.
	float inkT = clamp(amount, 0.0, 1.0);

	// INTRO WIPE, scaling "amount" -- the dot's SIZE driver -- rather than the
	// final color. That makes each dot GROW from nothing to its true size, so
	// the reveal speaks the grid's own vocabulary: the quantity that encodes
	// brightness also encodes arrival. Fading the finished image instead would
	// just be a cross-dissolve with extra steps.
	//
	// The wavefront is a moving threshold on brightness: at uIntro = t, cells
	// brighter than roughly (1 - t) have arrived and dimmer ones have not, with
	// a soft shoulder so the edge is a gradient rather than a hard cut.
	// Highlights therefore land first and the shadows fill in last.
	//
	// Deliberately AFTER the level quantization: the ramp fixes each dot's
	// TARGET size and the intro then scales continuously toward it. Quantizing
	// afterwards instead would make every dot climb the ramp's discrete steps
	// on its way in, which reads as chunky stair-stepping mid-animation.
	//
	// Gated on < 1.0 so the steady state costs nothing -- a uniform branch, so
	// every fragment takes the same path and there is no warp divergence.
	// Per-cell arrival, 0 = not yet here, 1 = fully arrived. Kept in scope past
	// this block because the CRT layers below have to honour it too.
	float arrived = 1.0;
	if (uIntro < 1.0) {
		// Rank this cell on the wavefront by its own dot size (raw: polarity
		// applied, before quantization), NOT its brightness, so the ink side of
		// the image develops first whichever polarity carries it. Plus a little
		// per-cell noise so the boundary breaks into grain instead of sweeping
		// as a visible contour through flat regions of the image.
		float rank = raw + (hash(cell) - 0.5) * uIntroJitter;
		// Widen the sweep past both ends so uIntro 0 is genuinely empty (even
		// the brightest cell is out) and 1 is genuinely complete (even the
		// darkest is in), jitter included.
		const float SHOULDER = 0.22; // softness of the arrival edge
		float front = mix(1.0 + uIntroJitter, -uIntroJitter - SHOULDER, uIntro);
		arrived = smoothstep(front, front + SHOULDER, rank);
		amount *= arrived;
	}

	// Dot silhouette. Three shapes share the same half-width (device px);
	// only the edge test differs.
	float halfCell = uCell * 0.5;
	vec2 dvec = px - cellCenterPx;                // signed offset from center
	vec2 absD = abs(dvec);                        // device px from center
	// Dot half-width (device px). xfPulse lets a transition swell/shrink dots as
	// it passes; clamped to the cell's half-diagonal so even a big pulse fills
	// its own cell at most and the grid never smears into a solid sheet.
	float halfW = amount * uDotScale * halfCell * max(xfPulse, 0.0);
	halfW = min(halfW, halfCell * 1.415);
	float circleDist = length(dvec);
	const float AA = 1.0;                         // fixed ~1px feather (device px)

	// sd is a signed distance (px, <0 inside) used by the bloom halo and
	// phosphor rim regardless of the drawn shape.
	float mask;
	float sd;
	if (uShape < 0.5) {
		// Legacy square: per-axis box (product of two 1D edges) with fwidth AA.
		// A Chebyshev max() distance is discontinuous along the cell diagonals,
		// so fwidth()-based AA spikes there and corners read as stray triangles;
		// two smooth axis edges avoid that. (The bloom/rim sd below may use the
		// box SDF safely because it feathers with a fixed AA, not fwidth.)
		vec2 aa = fwidth(absD);
		vec2 edge = 1.0 - smoothstep(halfW - aa, halfW + aa, absD);
		mask = (halfW > 0.0) ? edge.x * edge.y : 0.0;
		sd = max(absD.x, absD.y) - halfW;
	} else if (uShape < 1.5) {
		// Circle.
		sd = circleDist - halfW;
		mask = (halfW > 0.0) ? 1.0 - smoothstep(-AA, AA, sd) : 0.0;
	} else {
		// Morph: dim/small dots read as circles, bright dots pull toward a
		// rounded square (corner radius shrinks as brightness rises).
		float cornerR = min(halfW, mix(halfW * 0.9, halfW * 0.25, smoothstep(0.15, 0.7, amount)));
		vec2 qd = absD - vec2(halfW - cornerR);
		float sdRound = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - cornerR;
		float sq = smoothstep(0.15, 0.7, amount);
		sd = mix(circleDist - halfW, sdRound, sq);
		mask = (halfW > 0.0) ? 1.0 - smoothstep(-AA, AA, sd) : 0.0;
	}

	// Bloom halo + phosphor rim on the brightest dots (branch-gated: 0 cost
	// when uBloom == 0 or the cell is dim). The halo is a soft ring just
	// OUTSIDE the dot edge; the rim is a bright lip just INSIDE it — together
	// they read as glowing phosphor rather than a flat, larger dot.
	float glow = 0.0;
	float rim = 0.0;
	if (uBloom > 0.0 && amount > 0.5 && halfW > 0.0) {
		float bright = smoothstep(0.5, 1.0, amount);
		float haloW = max(2.0, halfW * 0.9);
		glow = (sd > 0.0) ? (1.0 - smoothstep(0.0, haloW, sd)) * bright * uBloom * 0.5 : 0.0;
		float rimPx = max(1.0, halfW * 0.3);
		float inner = 1.0 - smoothstep(-AA, AA, sd + rimPx);
		rim = max(mask - inner, 0.0) * bright * uBloom;
	}

	// Cross-hatch engraving in the darkest cells: a rotated dot-lattice whose
	// marks grow denser as brightness falls (branch-gated to shadow cells).
	// NB the * arrived at the end: this layer keys off LOW amount, and the intro
	// wipe drives amount toward 0 — so without it the hatch would grow STRONGER
	// the less of a cell had arrived, actively drawing the shadow texture over
	// the very cells the wipe is holding back.
	float hatch = 0.0;
	if (uCrosshatch > 0.0 && amount < 0.4 && cellOn > 0.0) {
		float shadow = smoothstep(0.4, 0.0, amount); // 1 in the darkest cells
		float spacing = uCell * 0.7;
		float ca = cos(0.4363), sa = sin(0.4363);   // ~25deg
		vec2 rp = vec2(ca * px.x - sa * px.y, sa * px.x + ca * px.y);
		vec2 hcell = floor(rp / spacing);
		vec2 hcenter = (hcell + 0.5) * spacing;
		float hd = length(rp - hcenter);
		float hr = mix(0.4, spacing * 0.18, shadow);
		hatch = (1.0 - smoothstep(hr - 0.6, hr + 0.6, hd)) * shadow * uCrosshatch * arrived * cellOn;
	}

	// --- color reveal: how much of the true video color to show here -----
	// Pointer trail: strongest near a recent sample, decaying with distance
	// (radial falloff) and sample age (1 - age). Newest sample => full color
	// (fast fade-in); older samples decay over TRAIL_MS (slow fade-out).
	// Skip the whole scan when the trail is empty (the common case — the hero
	// has no color-reveal), so those fragments don't spin the MAX_TRAIL loop.
	float trail = 0.0;
	if (uTrailCount > 0) {
		for (int i = 0; i < MAX_TRAIL; i++) {
			if (i >= uTrailCount) break;
			float d = distance(cellCenterPx, uTrail[i]);
			float falloff = 1.0 - smoothstep(0.0, uRevealRadius, d);
			trail = max(trail, falloff * (1.0 - uTrailAge[i]));
		}
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
	// Guard the ansiSnap() palette search so it only runs where a dot is
	// actually revealed — most cells have colorRestore == 0 and would just
	// discard the result, so this skips the 7-iteration loop grid-wide.
	// The ink ramp: a duotone when uInkHi differs, a flat ink when it is uInk.
	vec3 ink = mix(uInk, uInkHi, inkT);
	vec3 dot = ink;
	if (colorRestore > 0.0) {
		dot = mix(ink, ansiSnap(src), colorRestore);
	}
	// A transition's own light (the code rain's phosphor head/trail). Applied
	// after the reveal colour so it rides over everything, and only where the
	// mode asked for it — xfTintAmt is 0 for every other mode and at rest.
	if (xfTintAmt > 0.0) {
		dot = mix(dot, xfTint, clamp(xfTintAmt, 0.0, 1.0));
	}

	// Highlight lift: push the fullest dots toward uGlow so they glow. Keyed on
	// amount (the value that drives dot size, so the biggest dots glow under
	// either polarity). Attenuated by (1 - colorRestore) so a dot currently
	// showing its revealed/shimmer color keeps it instead of being washed out.
	// When bloom drives the highlight glow, fold back the standing highlight-lift
	// so the two don't double-count (bloom is the stronger, explicit version).
	float hiLift = smoothstep(HI_THRESHOLD, 1.0, amount) * HI_STRENGTH
		* (1.0 - colorRestore) * (1.0 - clamp(uBloom, 0.0, 1.0));
	dot = mix(dot, uGlow, hiLift);

	// Compose: start from the paper, engrave the shadow hatch, add the bloom
	// halo, paint the dot, then lift its phosphor rim toward the glow.
	vec3 result = uPaper;
	result = mix(result, mix(uInk, uGlow, 0.3), hatch);
	// Glow and rim move TOWARD uGlow rather than adding it. On a dark paper with
	// a white glow that is the same thing; on a light one the glow is dark, and
	// ADDING it did nothing, so bloom silently switched off on light paper.
	vec3 toGlow = uGlow - uPaper;
	result += toGlow * glow;
	result = mix(result, dot, mask);
	result += toGlow * rim * 0.6;

	fragColor = vec4(result, 1.0);
}`;
