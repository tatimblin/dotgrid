# dotgrid

Two framework-free custom elements that render video as a halftone dot grid.

| Package | Element | What it does |
|---|---|---|
| [`@tristimb/dotted-grid`](packages/dotted-grid) | `<dotted-grid>` | Plays a video through a WebGL2 fragment shader. Each grid cell draws one dot sized by the brightness under it. No dependencies. |
| [`@tristimb/video-carousel`](packages/video-carousel) | `<video-carousel>` | Autoplays a list of clips through one `<dotted-grid>`. A date ruler beside it works as a scrubber (drag, click or arrow keys). |

They come from [tristantimblin.dev](https://tristantimblin.dev), where they draw the hero and the footer carousel.

## Install

The packages ship as tarballs on GitHub Releases, not on the npm registry:

```sh
bun add https://github.com/tatimblin/dotgrid/releases/download/v0.1.0/tristimb-dotted-grid-0.1.0.tgz
bun add https://github.com/tatimblin/dotgrid/releases/download/v0.1.0/tristimb-video-carousel-0.1.0.tgz
```

npm, pnpm and yarn accept the same URLs.

Each package exports built ES modules with type declarations, plus a stylesheet:

```ts
import "@tristimb/dotted-grid";            // registers <dotted-grid>
import "@tristimb/dotted-grid/styles.css";
import "@tristimb/video-carousel";         // registers <video-carousel>
import "@tristimb/video-carousel/styles.css";

import { DottedGridElement, resolveTone, TONE_DEFAULTS } from "@tristimb/dotted-grid";
```

Importing a package defines its element once, unless an element with that name is already registered. The stylesheets set the element's box and hide the source `<video>`, so load them too.

## `<dotted-grid>`

```html
<dotted-grid src="/videos/clip.mp4" src-webm="/videos/clip.webm" cell-size="6"></dotted-grid>
```

### Tone: attribute, then CSS variable, then default

Each setting that controls how the grid looks is read from three places. The first one found wins:

1. the element's attribute: `gamma="0.4"`
2. a CSS custom property named `--dg-` plus the attribute name: `--dg-gamma: 0.4`
3. the built-in default

You theme the grid with the CSS variables. Scope a preset to a theme and the element re-resolves it when the theme changes. It watches `class`, `data-theme` and `style` on `<html>` and repaints only if a value it uses has changed.

```css
[data-theme="light"] .hero dotted-grid { --dg-gamma: 0.4; --dg-dot-shape: circle; --dg-bloom: 0; }
[data-theme="dark"]  .hero dotted-grid { --dg-gamma: 0.55; --dg-bloom: 0.5; }
```

**An attribute always beats its variable.** A tone attribute left on the element pins that setting in every theme, and the preset for it does nothing. Put structural attributes (`src`, `cell-size`, `max-dpr`, `intro`) in markup and tone in CSS. A value that doesn't parse falls through to the next source.

| Attribute / `--dg-*` | Default | Meaning |
|---|---|---|
| `ink` | `--color-fg` | Dot colour. |
| `ink-hi` | = `ink` | The fullest dot's colour. Dots blend from `ink` to `ink-hi` with their size (a duotone). |
| `paper` | `--color-bg` | Backdrop colour. |
| `glow` | `auto` | The colour that highlights, bloom and hatch lean toward. `auto` is black on a light paper and white on a dark one. |
| `polarity` | `positive` | `positive` puts dots on the highlights; `negative` puts them on the shadows. |
| `dot-shape` | `morph` | `square`, `circle` or `morph` (small dots are round, the fullest are rounded squares). |
| `dot-scale` | `1` | Largest dot's half-width as a fraction of the half-cell. At 1 the brightest level fills its cell. |
| `levels` | `5` | Number of brightness steps. `1` or `0` gives a continuous ramp. |
| `gamma` | `0.8` | Luminance exponent. |
| `contrast` | `1.1` | Luminance contrast around 0.5. |
| `cutoff` | `0` | 0..1 black point. Cells at or below it draw nothing, including hatch. |
| `feather` | `0` | 0..1 band above `cutoff` where dots shrink to nothing instead of stopping at a hard edge. |
| `denoise` | `0` | 0..1. Averages each cell's footprint (5 taps) instead of point-sampling it, which hides codec noise. |
| `bloom` | `0.55` | 0..1 glow and phosphor rim on the brightest dots. |
| `crosshatch` | `0.35` | 0..1 engraved hatch marks in the darkest cells. |

`ink` and `paper` fall back to `--color-fg` and `--color-bg`, then to light grey on black.

### Other attributes (no CSS variable)

| Attribute | Meaning |
|---|---|
| `src` | Video URL (H.264 MP4). Required. |
| `src-webm` | Optional WebM (AV1/VP9), preferred over `src` where the browser plays it. |
| `cell-size` | Grid cell size in CSS px. Default 6. |
| `max-dpr` | Cap on the drawing buffer's device-pixel ratio. Default 2. Fill cost is per pixel, so give full-bleed grids `max-dpr="1"`. Keep it an integer. |
| `paused` | Freezes the animation. |
| `rate` | Playback speed multiplier, clamped to 0.0625..16. |
| `color-reveal` | Pointer-trail radius in CSS px. Dots inside it show the video's true colour. Empty means 80. |
| `shimmer` | Percent of dots that flash their true colour now and then. Empty means 8. |
| `reveal-boost` | 0..1. How far a revealed colour snaps to a vivid ANSI palette. Default 0.3. |
| `no-loop` | Plays once and dispatches a bubbling `dotted-grid:ended` event on the last frame. |
| `intro` | Develops the picture in once on arrival, fullest dots first. Empty means 2600 ms; a number sets the duration. |
| `intro-delay` | Milliseconds to hold the grid empty before the intro. Default 500. |
| `intro-jitter` | Grain in the intro's wavefront. Default 0.16. |
| `xfade` | Blends clip changes (a `src` swap) per cell instead of cutting. Empty means 1600 ms. |
| `xfade-mode` | `threshold` (default) or `rain`. |
| `xfade-live` | Keeps both clips playing through the blend. |

The CSS variable `--dotted-grid-height` sets the element's height (default `100vh`).

Events: `dotted-grid:ready` fires after the first real draw (the element also gets `data-ready`), and `dotted-grid:ended` fires with `no-loop`. Methods: `refreshTone()`, `replay()`, `cutNext()`.

Under `prefers-reduced-motion` the colour reveal, shimmer, intro and cross-fade are off.

## `<video-carousel>`

The clip list is authored in light DOM, so the dates and captions are readable before JavaScript runs. There's one ruler button per clip, a stage holding a `<dotted-grid data-vc-grid>`, and a caption:

```html
<video-carousel class="vc">
  <div class="vc__main">
    <div class="vc__ruler" role="group" data-vc-ruler aria-label="Select clip by date">
      <button type="button" class="vc__tick vc__tick--major" data-index="0"
        data-src="/a.mp4" data-src-webm="/a.webm"
        data-desc="Title" data-loc="Place" data-date="April 2024" data-alt="…"></button>
      <!-- one per clip, oldest first -->
    </div>
    <figure class="vc__stage" data-vc-stage>
      <dotted-grid class="vc__grid" data-vc-grid src="/a.mp4" src-webm="/a.webm" no-loop></dotted-grid>
      <figcaption class="vc__caption">
        <span class="vc__cap-line"><span class="vc__cap-run vc__cap-run--title"><span data-vc-desc>Title</span></span></span>
        <span class="vc__cap-line"><span class="vc__cap-run vc__cap-run--meta"><span data-vc-loc>Place</span></span></span>
      </figcaption>
    </figure>
  </div>
</video-carousel>
```

`<video-carousel>` doesn't import `<dotted-grid>`. It drives the one in its markup, so install and import both. Give the grid `no-loop` so the carousel advances when a clip ends.

Attributes: `ruler-side` (`left` | `right`), `orientation` (`vertical` | `horizontal`; unset flips to horizontal at 640px and below), `fill`, `scene`, `caption-overlay`, `ruler-baseline` (`top` | `bottom`), and `tick-src` (URL of a tick sound; unset means silent; muted while `localStorage.sound === "off"`, re-read on a `soundchange` event).

Geometry knobs are `--vc-*` custom properties on `:root`; see [`styles.css`](packages/video-carousel/src/styles.css). The carousel publishes `video-carousel:ready` and `video-carousel:metrics` events.

## Develop

```sh
bun install
bun run test        # bun unit tests: tone resolution, shader-source hazards
bun run typecheck
bun run build       # packages/*/dist: index.js, *.d.ts, styles.css
bun run demo        # Vite demo at demo/ (run build first; it imports dist/ like a consumer)
```

To work on a consumer at the same time, `bun link` each package, or point the consumer at `file:../dotgrid/packages/dotted-grid`.

## Release

There's no npm publish. Each version is a GitHub Release with the two `npm pack` tarballs attached.

1. Bump `version` in both `packages/*/package.json`.
2. `bun run test && bun run pack` builds (each package's `prepack` runs `build`) and writes `release/tristimb-*-<version>.tgz`.
3. Commit, then tag and release:
   ```sh
   git tag v<version> && git push origin main v<version>
   gh release create v<version> release/*.tgz --title v<version> --notes "…"
   ```
4. In the consumer, point the dependency at the new asset URL:
   `https://github.com/tatimblin/dotgrid/releases/download/v<version>/tristimb-dotted-grid-<version>.tgz`.

## License

MIT
