/**
 * Loading the agent runtime must leave the event loop free to answer the keyboard.
 *
 * WHY THIS SUITE EXISTS. The launch card paints at ~157ms with a typeahead gate
 * that echoes keystrokes into the resting composer. The gate is a stdin
 * listener, so it only runs when the loop turns, and `import("../main")`
 * evaluates ~3600 modules as one synchronous chain that never turns it. A
 * character typed at 180ms was drawn at 379ms: measured on a compiled binary,
 * the median echo latency was 198ms. Staging the graph behind macrotask yields
 * took the same measurement to 6ms.
 *
 * THE CLASS, not the incident. Two independent ways to lose it, and each is
 * silent — startup still works, it just stops answering:
 *
 *   1. The yield goes away. A refactor that awaits the stages directly, or
 *      swaps `setImmediate` for a resolved promise, drains as microtasks inside
 *      one loop turn and starves stdin exactly as before.
 *   2. A stage stops resolving. The specifiers are strings; a module that moves
 *      or is renamed turns its stage into a subtree that is no longer warmed,
 *      and the cost silently returns to the blocking import that follows.
 *
 * Both are asserted below against the real list, swept at run time rather than
 * restated, so a stage added or moved is covered without editing this file.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It says nothing about how LONG any one stage
 * blocks: a single stage heavy enough to be felt still passes here, because the
 * loop does turn around it. That is a measurement on a compiled binary, not a
 * unit test. It also cannot prove the list covers the runtime's heaviest
 * subtrees — only that every stage named is real.
 */
import { describe, expect, test } from "bun:test";
import { WARMUP_STAGES } from "@veyyon/coding-agent/cli/runtime-stages";
import { warmRuntimeGraph } from "@veyyon/coding-agent/cli/runtime-warmup";

describe("the staged runtime warmup", () => {
	/**
	 * The loop must turn between stages even when every stage resolves at once.
	 *
	 * A first warmup loads real modules, and an uncached `import()` settles on
	 * the macrotask queue by itself, so it turns the loop whether or not the
	 * yield is there. The second warmup is the honest test: every stage is
	 * cached and resolves as a microtask, so the only thing that can still turn
	 * the loop is the yield. A self-requeueing macrotask counts the turns, which
	 * interleave one for one with the stages.
	 */
	test("turns the loop once per stage even when every stage is already loaded", async () => {
		await warmRuntimeGraph();

		let turns = 0;
		let counting = true;
		const count = (): void => {
			if (!counting) return;
			turns++;
			setImmediate(count);
		};
		setImmediate(count);

		await warmRuntimeGraph();
		counting = false;

		expect(turns).toBeGreaterThanOrEqual(WARMUP_STAGES.length - 1);
	});

	/**
	 * Every stage is a literal specifier into a subtree that `main` imports
	 * anyway. A stage that no longer resolves is a subtree that stopped being
	 * warmed, which is a silent startup regression rather than a failure.
	 */
	test("names only subtrees that still exist", async () => {
		const broken: number[] = [];
		for (const [index, stage] of WARMUP_STAGES.entries()) {
			try {
				await stage();
			} catch {
				broken.push(index);
			}
		}

		expect(broken).toEqual([]);
	});

	/** An empty list is a warmup that warms nothing and passes every other check. */
	test("carries stages at all", () => {
		expect(WARMUP_STAGES.length).toBeGreaterThan(10);
	});
});
