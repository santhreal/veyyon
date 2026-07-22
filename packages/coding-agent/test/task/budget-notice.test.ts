import { describe, expect, it } from "bun:test";
import { buildBudgetNotice } from "@veyyon/coding-agent/task/executor";

/**
 * buildBudgetNotice is the wrap-up message a subagent receives when it crosses its soft request budget.
 * The number it quotes as the force-stop point must stay in lockstep with the executor's actual stop
 * logic: the run is stopped when `progress.requests >= softRequestBudget * 1.5` (executor.ts, the
 * `stopThreshold` comparison). Because request counts are integers and the threshold can be fractional
 * (an odd budget times 1.5), the message uses `Math.ceil(budget * 1.5)` — the FIRST integer request
 * count that satisfies the `>=` comparison. If the message and the comparison ever drift (one using
 * ceil, the other floor, or a different multiplier), the agent would be told the wrong deadline and
 * either wind down too early or be surprised by an earlier-than-stated stop. These tests pin the
 * message text and, most importantly, that the quoted threshold is exactly the crossing point of
 * `budget * 1.5`.
 */
describe("buildBudgetNotice", () => {
	/** Pull the "At N requests" force-stop count back out of the human-readable notice. */
	function statedStopThreshold(notice: string): number {
		const match = notice.match(/At (\d+) requests the run is force-stopped/);
		if (!match) throw new Error(`notice did not state a force-stop threshold: ${notice}`);
		return Number(match[1]);
	}

	it("reports the current request count and the soft budget verbatim", () => {
		const notice = buildBudgetNotice(205, 200);
		expect(notice).toContain("You have used 205 requests");
		expect(notice).toContain("soft budget: 200");
	});

	it("quotes the exact integer crossing point of budget*1.5 for an even budget", () => {
		// 200 * 1.5 = 300 exactly, so the run stops at the 300th request.
		expect(statedStopThreshold(buildBudgetNotice(200, 200))).toBe(300);
	});

	it("rounds a fractional threshold up to the first integer that trips the >= comparison", () => {
		// 201 * 1.5 = 301.5; the first integer request count with requests >= 301.5 is 302.
		expect(statedStopThreshold(buildBudgetNotice(205, 201))).toBe(302);
	});

	it("keeps the stated threshold as the minimal integer >= budget*1.5 across a range of budgets", () => {
		// This is the invariant the executor's `progress.requests >= budget * 1.5` relies on: the number
		// in the notice must be the smallest integer that satisfies the comparison, so one less than it
		// would NOT yet trip the stop.
		for (const budget of [1, 2, 3, 99, 100, 101, 200, 201, 333]) {
			const stated = statedStopThreshold(buildBudgetNotice(0, budget));
			const exact = budget * 1.5;
			expect(stated).toBeGreaterThanOrEqual(exact);
			expect(stated - 1).toBeLessThan(exact);
		}
	});
});
