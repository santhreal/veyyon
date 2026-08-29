import * as AIError from "@veyyon/ai/error";
import { previewLine } from "../tools/render-utils";

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
	[AIError.Flag.Transient, "provider hiccup"],
];

const MAX_REASON_WIDTH = 32;

const STALL_PATTERN = /stream stall(?:ed)?|stalled while waiting/i;

export function retryReason(errorId: number | undefined, errorMessage: string | undefined): string | undefined {
	if (errorMessage && STALL_PATTERN.test(errorMessage)) return "stream stalled";
	for (const [flag, label] of REASON_LABELS) {
		if (AIError.is(errorId, flag)) return label;
	}
	const status = errorId !== undefined ? AIError.stringify(errorId) : undefined;
	if (status?.startsWith("status:")) return `HTTP ${status.slice("status:".length)}`;

	const trimmed = errorMessage?.trim().split("\n")[0]?.trim();
	if (!trimmed) return undefined;
	return previewLine(trimmed, MAX_REASON_WIDTH);
}

function formatRetryDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export type RetryRecoveryMode = "continue" | "retry";

export interface RetryLineInput {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorId?: number;
	errorMessage?: string;
	policySource?: string;
	mode?: RetryRecoveryMode;
}

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

export function formatRetrySummary(trace: RetryTrace): string | undefined {
	if (trace.attempts <= 0) return undefined;
	const noun = trace.mode === "continue" ? "continuation" : "retry";
	const attempts = trace.attempts === 1 ? `1 ${noun}` : `${trace.attempts} ${noun}s`;
	const cost = trace.totalDelayMs > 0 ? ` (${formatRetryDuration(trace.totalDelayMs)} waiting)` : "";
	const reason = trace.reason ? ` · ${trace.reason}` : "";
	return `Recovered after ${attempts}${cost}${reason}`;
}
