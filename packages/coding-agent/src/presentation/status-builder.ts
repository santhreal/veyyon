/**
 * Session state to `StatusLineState`.
 *
 * A pure reduction over an explicit input struct rather than over the session
 * object: the caller reads the fields it already has, and this decides what the
 * status line says about them. That keeps the mapping testable without
 * constructing a session, and keeps the session free of presentation rules.
 */

import type {
	ContextGauge,
	SessionActivity,
	SessionCost,
	StatusLineState,
	StatusNotice,
} from "@veyyon/wire/presentation";

/** What the status line is built from. */
export interface StatusInput {
	/** True while a turn is in flight. */
	streaming: boolean;
	/** True while the model is producing reasoning and no text yet. */
	thinking: boolean;
	/** Tool calls currently executing. */
	runningToolCalls: number;
	/** True while a compaction pass holds the turn. */
	compacting: boolean;
	/** True while a tool call waits for the operator. */
	awaitingApproval: boolean;
	model: string;
	thinkingLevel?: string;
	usedTokens: number;
	contextWindow: number;
	/** True when `contextWindow` came from the provider rather than the catalog. */
	contextWindowFromProvider: boolean;
	cost: SessionCost;
	workingDirectory: string;
	gitBranch?: string;
	/** Milliseconds the current activity has been running; 0 while idle. */
	elapsedMs: number;
	queuedMessages: number;
	notice?: StatusNotice;
}

/**
 * Which activity the status line reports.
 *
 * Ordered by what the operator most needs to know: an approval prompt blocks
 * everything and is reported even mid-stream, then a compaction that has taken
 * the turn, then a running tool, then the stream itself. Reporting "streaming"
 * while a tool call waits for an answer is what makes an operator sit and watch
 * a session that is waiting on them.
 */
export function resolveActivity(input: StatusInput): SessionActivity {
	if (input.awaitingApproval) return "waiting-approval";
	if (input.compacting) return "compacting";
	if (input.runningToolCalls > 0) return "tool-running";
	if (input.thinking) return "thinking";
	if (input.streaming) return "streaming";
	return "idle";
}

/**
 * Context occupancy. A non-positive window would make every consumer divide by
 * zero, so it is clamped to 1 and the used count is clamped into the window:
 * a gauge that reads over 100% is a measurement bug reported as a UI bug.
 */
export function resolveContextGauge(input: StatusInput): ContextGauge {
	const total = Math.max(1, Math.trunc(input.contextWindow));
	const used = Math.min(total, Math.max(0, Math.trunc(input.usedTokens)));
	return { used, total, providerReported: input.contextWindowFromProvider };
}

export function toStatusLineState(input: StatusInput): StatusLineState {
	const activity = resolveActivity(input);
	const state: StatusLineState = {
		activity,
		model: input.model,
		context: resolveContextGauge(input),
		cost: input.cost,
		workingDirectory: input.workingDirectory,
		// An idle session is not "0ms into an activity"; it is in none.
		elapsedMs: activity === "idle" ? 0 : Math.max(0, Math.trunc(input.elapsedMs)),
		queuedMessages: Math.max(0, Math.trunc(input.queuedMessages)),
	};
	if (input.thinkingLevel !== undefined) state.thinkingLevel = input.thinkingLevel;
	if (input.gitBranch !== undefined) state.gitBranch = input.gitBranch;
	if (input.notice !== undefined) state.notice = input.notice;
	return state;
}

/** A zeroed cost, for a session that has spent nothing yet. */
export function emptyCost(): SessionCost {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalUsd: 0 };
}
