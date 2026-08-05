/**
 * How a retry is described to the user.
 *
 * Retries were previously almost invisible. A transient spinner said
 * `Retrying (1/10) in 5s…` and was disposed the moment the retry resolved, so a
 * turn that quietly burned four attempts and forty seconds left no trace and no
 * reason. From the outside that is indistinguishable from the tool simply being
 * slow, which is exactly how it was reported.
 *
 * Two things fix that, and both live here so they are worded once and can be
 * tested without a terminal: the live line says WHY it is retrying, and a
 * durable summary says what the retries cost once they are over.
 */
import * as AIError from "@veyyon/ai/error";

/**
 * Plain-language names for the error classes worth showing mid-retry.
 *
 * `AIError.stringify` already produces stable identifiers, but they are written
 * for logs (`stale-responses-item`, `provider-finish-error`). A status line is
 * read by someone deciding whether their tool is broken, so it gets prose.
 */
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

/**
 * A stalled provider stream, which the flag taxonomy does not single out.
 *
 * `AIError`'s timeout pattern matches `stream stall` on a word boundary, but the
 * message we emit says "stalled", so a stall classifies as generic transient and
 * would be shown as "provider hiccup". That is the one reason most worth naming
 * exactly: a stall means the provider went quiet and we gave up waiting, which
 * is a completely different thing for a user to act on than a rate limit or a
 * blip, and it is the failure that prompted this whole surface.
 */
const STALL_PATTERN = /stream stall(?:ed)?|stalled while waiting/i;

/**
 * A short reason for a retry, preferring the classified error kind over the raw
 * provider text.
 *
 * The raw message is the fallback rather than the first choice because provider
 * error strings are long, contain request ids and occasionally embed a JSON
 * body; a classified flag is one or two words and is already what the retry
 * logic itself branched on, so it cannot disagree with the decision it explains.
 */
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
	// blank runs into a single-line status.
	const collapsed = trimmed.replace(/\s+/g, " ");
	if (collapsed.length <= MAX_REASON_WIDTH) return collapsed;
	return `${collapsed.slice(0, MAX_REASON_WIDTH - 1)}…`;
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

export interface RetryLineInput {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorId?: number;
	errorMessage?: string;
	/** Why this attempt budget applies, e.g. `cursor provider default`. */
	policySource?: string;
}

/**
 * The live line shown while waiting out a retry backoff.
 *
 * The reason is the point of the change: `Retrying (1/10) in 5s…` tells the user
 * nothing they can act on, while `timed out` immediately distinguishes a stalled
 * provider from a rate limit. The policy source is appended only when a
 * non-global policy set the budget, so a limit the operator never configured is
 * traceable instead of looking arbitrary.
 */
export function formatRetryLine(input: RetryLineInput): string {
	const seconds = Math.max(0, Math.round(input.delayMs / 1000));
	const parts = [`Retrying (${input.attempt}/${input.maxAttempts}) in ${seconds}s`];
	const reason = retryReason(input.errorId, input.errorMessage);
	if (reason) parts.push(reason);
	if (input.policySource) parts.push(input.policySource);
	return parts.join(" · ");
}

export interface RetryTrace {
	attempts: number;
	totalDelayMs: number;
	reason?: string;
}

/**
 * The durable one-line summary left behind after a turn recovered through
 * retries.
 *
 * This is the piece that was missing entirely. Without it a recovered turn looks
 * identical to a slow one, so the user has no way to attribute the wait, which
 * is precisely the confusion that produced the "everything is slow and broken"
 * report. Emitted only when a retry actually happened, so a clean turn stays
 * silent.
 */
export function formatRetrySummary(trace: RetryTrace): string | undefined {
	if (trace.attempts <= 0) return undefined;
	const attempts = trace.attempts === 1 ? "1 retry" : `${trace.attempts} retries`;
	const cost = trace.totalDelayMs > 0 ? ` (${formatRetryDuration(trace.totalDelayMs)} waiting)` : "";
	const reason = trace.reason ? ` · ${trace.reason}` : "";
	return `Recovered after ${attempts}${cost}${reason}`;
}
