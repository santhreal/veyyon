import * as fs from "node:fs";

/**
 * Streaming startup markers, enabled by `VEYYON_DEBUG_STARTUP`.
 *
 * Unlike the `VEYYON_TIMING` tree, which prints once startup has finished, these
 * write one synchronous stderr line as each phase begins and ends, so a hard hang
 * still shows the last phase that started. `fs.writeSync(2)` is deliberate: it
 * cannot be reordered or buffered past a synchronous block of the event loop
 * (`dlopen`, sync fs on a dead mount, `spawnSync`), which is exactly the situation
 * these markers exist to diagnose.
 *
 * This is its own module, importing nothing but `node:fs`, because the CLI
 * bootstrap needs the marker while staying out of the winston-backed logger's
 * import graph: `veyyon --version` must not load a logging stack. `logger.ts` and
 * `cli.ts` each had their own copy for that reason, one of them documenting the
 * other. A module with a single node builtin as its dependency satisfies both the
 * import-graph constraint and having one definition.
 */
export function startupMarker(text: string): void {
	if (!process.env.VEYYON_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}
