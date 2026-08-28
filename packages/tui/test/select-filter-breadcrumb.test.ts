import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "@veyyon/tui";
import { currentLoopPhase, popLoopPhase, takeLoopPhaseProfile } from "@veyyon/utils"

/**
 * Contract: the SelectList fuzzy filter — a synchronous, potentially expensive
 * pass over a large list — is wrapped in a `ui.select-filter` loop-phase
 * breadcrumb so the event-loop watchdog can attribute a filter stall to it.
 *
 * The LoopWatchdog unit tests cover the watchdog/recent-slot mechanism in
 * isolation; this guards the actual call site. Removing the
 * `pushLoopPhase("ui.select-filter")` around the filter would leave a real stall
 * logged as "unknown" while every watchdog unit test still passed — and this
 * case would fail.
 *
 * The phase stack is a process-global, and any suite that renders a frame banks
 * `ui.render` cost into it. Drain it (and the consume-on-read accounting) around
 * each case, BEFORE as well as after: a leftover from another file in the same
 * process would otherwise outweigh this filter's microseconds and win the read.
 */
function drainLoopPhases(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeLoopPhaseProfile();
}

beforeEach(drainLoopPhases);
afterEach(drainLoopPhases);

describe("SelectList fuzzy-filter loop-phase breadcrumb", () => {
	it("wraps the fuzzy filter in a ui.select-filter breadcrumb the watchdog can read", () => {
		const items: SelectItem[] = [
			{ value: "alpha", label: "Alpha" },
			{ value: "beta", label: "Beta" },
			{ value: "gamma", label: "Gamma" },
		];
		const list = new SelectList(items, 2, {} as unknown as SelectListTheme);

		list.setFilter("al");

		// The breadcrumb is pushed and popped synchronously around the filter, so by
		// the time setFilter returns the stack is balanced — but the consume-on-read
		// recent slot still surfaces the phase, which is exactly what lets a
		// synchronous filter stall be attributed instead of logged as "unknown".
		expect(currentLoopPhase()).toBeUndefined();
		expect(takeLoopPhaseProfile().phase).toBe("ui.select-filter");
	});

	it("does not breadcrumb an empty/whitespace filter (no fuzzy work to attribute)", () => {
		const list = new SelectList([{ value: "x", label: "X" }], 2, {} as unknown as SelectListTheme);

		list.setFilter("   ");

		expect(takeLoopPhaseProfile().phase).toBeUndefined();
	});
});
