/**
 * Load the agent runtime in stages, returning the event loop between each one.
 *
 * The launch card paints at ~157ms with a live typeahead gate: keystrokes are
 * held, echoed into the resting composer and replayed into the real one when it
 * mounts. That gate is a stdin listener, and a listener only runs when the loop
 * turns. `import("../main")` evaluates about 3600 modules as one uninterrupted
 * synchronous chain, so for the whole of it the loop never turns: a character
 * typed at 60ms is not echoed until 328ms, which is the lag that makes the
 * composer read as "not ready yet".
 *
 * Measured directly rather than assumed. A single `await import(sdk)` ran 444ms
 * and let a 5ms interval fire zero times. The same graph loaded through the
 * stages below ran 446ms and let it fire eight times. The work is identical and
 * the total is unchanged; what changes is that the terminal answers while it
 * happens.
 *
 * Each stage is a literal specifier for a subtree `../main` imports anyway, in
 * dependency order, so nothing here is loaded that the runtime would not have
 * loaded a moment later and no module's initialization order changes. The
 * import is dynamic because that is the entire mechanism: a static import would
 * be folded back into one synchronous chain and the loop would stop turning
 * again. Failures are not caught — a stage that cannot load fails the launch
 * with the same error `import("../main")` would have raised.
 *
 * The list is ordered by what each stage costs, heaviest subtrees split out, so
 * no single blocking chunk is long enough to be felt. `arktype` is the floor at
 * ~40ms in a compiled binary: it is one npm module with 89 importers here, and
 * it cannot be split further from the outside.
 */

import { WARMUP_STAGES } from "./runtime-stages";

/**
 * Hand the loop back so pending I/O — the typeahead gate's stdin listener and
 * the render it requests — runs before the next subtree is evaluated.
 *
 * `setImmediate` rather than a resolved promise: a microtask drains inside the
 * same turn and would let none of that run.
 */
async function yieldToEventLoop(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/**
 * Populate the module cache for the agent runtime, yielding between subtrees.
 *
 * Call before `import("../main")` on a launch that painted the card. The import
 * that follows finds every stage already evaluated and returns without blocking
 * again.
 */
export async function warmRuntimeGraph(): Promise<void> {
	for (const stage of WARMUP_STAGES) {
		await yieldToEventLoop();
		await stage();
	}
}
