/**
 * Status-line view-model: the single line of session state a renderer keeps
 * visible. Every field is already reduced to what is displayed — no model
 * objects, no provider handles, no timers.
 */

/** What the session is doing right now. */
export type SessionActivity = "idle" | "thinking" | "streaming" | "tool-running" | "compacting" | "waiting-approval";

/** Context-window occupancy, as measured for this session. */
export interface ContextGauge {
	/** Tokens currently in the window. */
	used: number;
	/** Window size the session is measured against. */
	total: number;
	/** True when `total` came from the provider rather than the catalog. */
	providerReported: boolean;
}

/** Cumulative spend for the session. */
export interface SessionCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalUsd: number;
}

/** One transient notice pinned to the status line. */
export interface StatusNotice {
	level: "info" | "warning" | "error";
	text: string;
}

export interface StatusLineState {
	activity: SessionActivity;
	/** Model identity as displayed. */
	model: string;
	/** Reasoning effort as displayed, absent when the model has none. */
	thinkingLevel?: string;
	context: ContextGauge;
	cost: SessionCost;
	/** Working directory, already shortened for presentation. */
	workingDirectory: string;
	/** Branch name when the working directory is a git checkout. */
	gitBranch?: string;
	/** Elapsed wall-clock milliseconds of the current activity; 0 while idle. */
	elapsedMs: number;
	/** Queued messages waiting for the current turn to finish. */
	queuedMessages: number;
	notice?: StatusNotice;
}
