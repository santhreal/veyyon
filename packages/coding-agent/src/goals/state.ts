import type { UsageStatistics } from "@veyyon/kernel/session/session-entries";

/**
 * Every status a goal can hold, as a value, so a surface that renders the status can be swept over
 * the whole set rather than over the members someone remembered. {@link GoalStatus} is derived from
 * this tuple and has no other spelling, so a new status lands in every sweep that reads it.
 */
export const GOAL_STATUSES = ["active", "paused", "budget-limited", "complete", "dropped"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	/** Completed agent turns accounted to this goal — the goal's step count. */
	turnsCompleted: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
/**
 * Why a turn was aborted, as far as an active goal is concerned. `interrupted` is the operator
 * stopping the work and pauses the goal; `internal` is machinery that stops a turn to do its own
 * job (compaction, a model switch, branching) and leaves the goal driving. One owner for the
 * vocabulary, so a new reason has to be classified at every seam that reads it.
 */
export type GoalAbortReason = "interrupted" | "internal";
