import { defineConfig } from "vite";

// `base` is relative so the built demo works from any path (GitHub Pages
// serves it under /dotgrid/). The demo imports the packages' built dist/,
// exactly as a consumer does, so run `bun run build` at the root first.
export default defineConfig({
	base: "./",
});
