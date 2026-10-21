// The packages register their custom elements on import; their stylesheets
// carry the layout (the element's box, the hidden <video>, the carousel ruler).
import "@tristimb/dotted-grid";
import "@tristimb/dotted-grid/styles.css";
import "@tristimb/video-carousel";
import "@tristimb/video-carousel/styles.css";

// Theme flip: <dotted-grid> watches <html>'s data-theme / class / style and
// re-resolves its --dg-* variables, so nothing else is needed here.
const html = document.documentElement;
document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
	html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
});

// Knobs: each control writes the attribute it names on the tuned grid.
const tuned = document.querySelector("[data-tuned]");
for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
	"[data-knobs] [data-attr]"
)) {
	input.addEventListener("input", () => {
		tuned?.setAttribute(input.dataset.attr!, input.value);
	});
}
