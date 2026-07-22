import { describe, expect, it } from "bun:test";
import { runEvalBudget } from "@veyyon/coding-agent/eval/budget-bridge";
import type { Goal, GoalModeState } from "@veyyon/coding-agent/goals/state";
import type { UsageStatistics } from "@veyyon/coding-agent/session/session-entries";
import type { ToolSession } from "@veyyon/coding-agent/tools";

/**
 * runEvalBudget is the host-side handler for the eval `budget` helper; kernel code
 * reads .total/.spent/.hard off it to decide whether an agent() call may proceed. It
 * had no test. The precedence is load-bearing: a per-turn `+Nk` directive wins over
 * an active Goal Mode budget, which wins over "no ceiling"; and even with no ceiling,
 * `spent` must still reflect this turn's output. A silent reordering here would let a
 * cell overspend a hard turn budget or misreport remaining tokens. These pin every
 * precedence branch and the hard/soft and spent-fallback edges.
 */

function goal(over: Partial<Goal>): Goal {
	return {
		id: "g1",
		objective: "o",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turnsCompleted: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

function usage(output: number): UsageStatistics {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function session(over: {
	turn?: { total: number | null; spent: number; hard: boolean };
	goalState?: GoalModeState;
	usageOutput?: number;
}): ToolSession {
	return {
		getTurnBudget: over.turn !== undefined ? () => over.turn : undefined,
		getGoalModeState: over.goalState !== undefined ? () => over.goalState : undefined,
		getUsageStatistics: over.usageOutput !== undefined ? () => usage(over.usageOutput as number) : undefined,
	} as unknown as ToolSession;
}

describe("runEvalBudget precedence", () => {
	it("uses a per-turn budget directive when it carries a ceiling", async () => {
		const result = await runEvalBudget(undefined, {
			session: session({ turn: { total: 1000, spent: 200, hard: true } }),
		});
		expect(result).toEqual({ total: 1000, spent: 200, hard: true });
	});

	it("prefers an active per-turn ceiling over a simultaneously-active Goal Mode budget", async () => {
		// Both a +Nk turn directive and an active Goal Mode budget are present; the turn
		// directive must win so a cell cannot overspend the tighter per-turn ceiling.
		const result = await runEvalBudget(undefined, {
			session: session({
				turn: { total: 200_000, spent: 5_000, hard: true },
				goalState: { enabled: true, mode: "active", goal: goal({ tokenBudget: 100_000, tokensUsed: 4_200 }) },
			}),
		});
		expect(result).toEqual({ total: 200_000, spent: 5_000, hard: true });
	});

	it("propagates hard:false for an advisory turn budget that still carries a ceiling", async () => {
		// A ceiling with hard:false is advisory: the total is reported so callers can show
		// remaining tokens, but hard must stay false so the run is not force-stopped at it.
		const result = await runEvalBudget(undefined, {
			session: session({ turn: { total: 50_000, spent: 1_000, hard: false } }),
		});
		expect(result).toEqual({ total: 50_000, spent: 1_000, hard: false });
	});

	it("falls through to Goal Mode when the turn budget has no ceiling", async () => {
		const result = await runEvalBudget(undefined, {
			session: session({
				turn: { total: null, spent: 50, hard: false },
				goalState: { enabled: true, mode: "active", goal: goal({ tokenBudget: 5000, tokensUsed: 100 }) },
			}),
		});
		expect(result).toEqual({ total: 5000, spent: 100, hard: true });
	});

	it("reports a Goal Mode budget as soft when the goal has no tokenBudget", async () => {
		const result = await runEvalBudget(undefined, {
			session: session({
				goalState: { enabled: true, mode: "active", goal: goal({ tokensUsed: 100 }) },
			}),
		});
		expect(result).toEqual({ total: null, spent: 100, hard: false });
	});

	it("ignores a disabled Goal Mode and reports no ceiling", async () => {
		const result = await runEvalBudget(undefined, {
			session: session({
				goalState: { enabled: false, mode: "active", goal: goal({ tokenBudget: 5000, tokensUsed: 9 }) },
				usageOutput: 42,
			}),
		});
		expect(result).toEqual({ total: null, spent: 42, hard: false });
	});
});

describe("runEvalBudget spent fallback", () => {
	it("uses this turn's spend when there is no ceiling but a turn budget exists", async () => {
		const result = await runEvalBudget(undefined, {
			session: session({ turn: { total: null, spent: 77, hard: false }, usageOutput: 999 }),
		});
		expect(result).toEqual({ total: null, spent: 77, hard: false });
	});

	it("falls back to usage-statistics output when there is no turn budget or goal", async () => {
		const result = await runEvalBudget(undefined, { session: session({ usageOutput: 300 }) });
		expect(result).toEqual({ total: null, spent: 300, hard: false });
	});

	it("reports zero spent when nothing is available", async () => {
		const result = await runEvalBudget(undefined, { session: session({}) });
		expect(result).toEqual({ total: null, spent: 0, hard: false });
	});
});
