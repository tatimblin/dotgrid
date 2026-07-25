/**
 * Tiny Web Audio helper for short UI "tick" sounds. State is MODULE-LEVEL on
 * purpose: a single shared AudioContext and a URL→AudioBuffer cache, so a
 * component that connects/disconnects repeatedly (ClientRouter view transitions)
 * never re-fetches, re-decodes, or spawns extra contexts. The context is not
 * closed on teardown — one lightweight suspended context for the whole session
 * is cheaper than churning them.
 *
 * The module is deliberately dumb about mute / preferences: callers decide
 * whether to play. Every function is a no-op (never throws) when Web Audio is
 * unavailable or the buffer isn't loaded yet.
 */

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<void>>();

/** Lazily create (once) the shared AudioContext. Returns null if unsupported. */
function getCtx(): AudioContext | null {
	if (ctx) return ctx;
	const AC =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AC) return null;
	try {
		ctx = new AC();
	} catch {
		ctx = null;
	}
	return ctx;
}

/**
 * Fetch + decode `url` into the shared buffer cache. Idempotent and safe to call
 * on every connect: an in-flight or completed load short-circuits. Silent on
 * failure (missing file, decode error, no Web Audio).
 */
export function loadTick(url: string): Promise<void> {
	if (buffers.has(url)) return Promise.resolve();
	const inflight = loading.get(url);
	if (inflight) return inflight;

	const audio = getCtx();
	if (!audio) return Promise.resolve();

	const p = fetch(url)
		.then((r) => r.arrayBuffer())
		.then((buf) => audio.decodeAudioData(buf))
		.then((decoded) => {
			buffers.set(url, decoded);
		})
		.catch(() => {
			/* missing/undecodable asset — stay silent */
		})
		.finally(() => {
			loading.delete(url);
		});
	loading.set(url, p);
	return p;
}

/**
 * Resume the context. Browsers create it suspended until a user gesture; call
 * this from within a user-driven handler (click/keydown/pointer) so the first
 * tick can sound. No-op if already running or unsupported.
 */
export function resumeTick(): void {
	const audio = getCtx();
	if (audio && audio.state === "suspended") audio.resume().catch(() => {});
}

/**
 * Play the cached tick for `url` at `gain` (0–1). A fresh source per call, so
 * rapid triggers (drag-scrub) overlap cleanly. No-op if the buffer isn't loaded
 * or the context isn't running.
 */
export function playTick(url: string, gain = 0.4): void {
	const audio = ctx;
	const buffer = buffers.get(url);
	if (!audio || !buffer || audio.state !== "running") return;
	try {
		const src = audio.createBufferSource();
		src.buffer = buffer;
		const g = audio.createGain();
		g.gain.value = gain;
		src.connect(g).connect(audio.destination);
		src.start();
	} catch {
		/* never let audio break the UI */
	}
}
