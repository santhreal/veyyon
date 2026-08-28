/** How a retry is described to the user. Retries were previously almost invisible. A transient spinner said */
import * as AIError from "@veyyon/ai/error";
import { previewLine } from "../tools/render-utils";

/** Plain-language names for the error classes worth showing mid-retry. `AIError.stringify` already produces stable identifiers, but they are written */
const REASON_LABELS: readonly [AIError.Flag, string][] = [
	[AIError.Flag.UsageLimit, "usage limit"],
	[AIError.Flag.Timeout, "timed out"],
	[AIError.Flag.ThinkingLoop, "thinking loop"],
	[AIError.Flag.ContentBlocked, "content blocked"],
	[AIError.Flag.ContextOverflow, "context overflow"],
	[AIError.Flag.AuthFailed, "auth failed"],
	[AIError.Flag.MalformedFunctionCall, "malformed tool call"],
	[AIError.Flag.StaleResponsesItem, "stale response item"],
	[AIError.Flag.ProviderFinishError, "provider error"],
	// Last: the catch-all class. Anything above is a more specific description
	// of the same failure and should win when both flags are set.
	[AIError.Flag.Transient, "provider hiccup"],
];

/** Longest reason rendered inline before it is elided. Keeps the line inside a narrow pane. */
const MAX_REASON_WIDTH = 32;

/** A stalled provider stream, which the flag taxonomy does not single out. `AIError`'s timeout pattern matches `stream stall` on a word boundary, but the */
const STALL_PATTERN = /stream stall(?:ed)?|stalled while waiting/i;

/** A short reason for a retry, preferring the classified error kind over the raw provider text. */
export function retryReason(errorId: number | undefined, errorMessage: string | undefined): string | undefined {
	if (errorMessage && STALL_PATTERN.test(errorMessage)) return "stream stalled";
	for (const [flag, label] of REASON_LABELS) {
		if (AIError.is(errorId, flag)) return label;
	}
	const status = errorId !== undefined ? AIError.stringify(errorId) : undefined;
	if (status?.startsWith("status:")) return `HTTP ${status.slice("status:".length)}`;

	const trimmed = errorMessage?.trim().split("\n")[0]?.trim();
	if (!trimmed) return undefined;
	// Collapse internal whitespace so a wrapped provider message cannot inject
	// blank runs into a single-line status, and cap by display width so a CJK or
	// emoji message cannot overrun the row it is drawn into.
	return previewLine(trimmed, MAX_REASON_WIDTH);
}

/** Render a millisecond duration the way a waiting human would say it. */
export function formatRetryDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Which recovery is waiting. A retry re-sends the turn; a continuation sends the turn already in context because the batch cannot be resent. They share this */
export type RetryRecoveryMode = "continue" | "retry";

export interface RetryLineInput {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorId?: number;
	errorMessage?: string;
	/** Why this attempt budget applies, e.g. `cursor provider default`. */
	policySource?: string;
	mode?: RetryRecoveryMode;
}

/** The live line shown while waiting out a retry backoff. The reason is the point of the change: `Retrying (1/10) in 5s…` tells the user */
export function formatRetryLine(input: RetryLineInput): string {
	const seconds = Math.max(0, Math.round(input.delayMs / 1000));
	const verb = input.mode === "continue" ? "Continuing" : "Retrying";
	const parts = [`${verb} (${input.attempt}/${input.maxAttempts}) in ${seconds}s`];
	const reason = retryReason(input.errorId, input.errorMessage);
	if (reason) parts.push(reason);
	if (input.policySource) parts.push(input.policySource);
	return parts.join(" · ");
}

export interface RetryTrace {
	attempts: number;
	totalDelayMs: number;
	reason?: string;
	mode?: RetryRecoveryMode;
}

/** The durable one-line summary left behind after a turn recovered through retries. */
export function formatRetrySummary(trace: RetryTrace): string | undefined {
	if (trace.attempts <= 0) return undefined;
	const noun = trace.mode === "continue" ? "continuation" : "retry";
	const attempts = trace.attempts === 1 ? `1 ${noun}` : `${trace.attempts} ${noun}s`;
	const cost = trace.totalDelayMs > 0 ? ` (${formatRetryDuration(trace.totalDelayMs)} waiting)` : "";
	const reason = trace.reason ? ` · ${trace.reason}` : "";
	return `Recovered after ${attempts}${cost}${reason}`;
}
