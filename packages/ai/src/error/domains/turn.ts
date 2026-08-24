/**
 * The turn families: the turn itself ended badly, or ended on purpose.
 *
 * A malformed tool call, a stream that stopped with `finish_reason: error`, a server-side item that
 * is gone, a repetition loop the detector caught: none is fixed by a socket or a credential, and all
 * are fixed by sending the turn again, which is what makes them the turn-retriable set. `tool-call`
 * is the one family safe to replay after the failed turn already emitted a call, because the call
 * never parsed and there is nothing to duplicate.
 *
 * `content` and `interrupt` are not faults at all. A content filter is a verdict on the request, and
 * it vetoes a retry for the WHOLE failure however the rest of it classified — a filter whose body
 * also carried a 503 used to come back retryable through the transport wording. An interrupt is
 * somebody asking the turn to stop.
 */
import { isAbortError } from "@veyyon/utils/abortable";
import { Flag } from "../flag";
import type { ErrorDomain } from "./types";

const MALFORMED_FUNCTION_CALL_PATTERN = /\bmalformed.?function.?call\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const STALE_RESPONSE_ITEM_PATTERNS = [/\bItem with id ['"][^'"]+['"] not found\.?/i, /previous[ _]?response/i] as const;
const STALE_RESPONSE_ITEM_DETAIL_PATTERN = /not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i;

export function isStaleResponsesText(text: string): boolean {
	return (
		STALE_RESPONSE_ITEM_PATTERNS[0].test(text) ||
		(STALE_RESPONSE_ITEM_PATTERNS[1].test(text) && STALE_RESPONSE_ITEM_DETAIL_PATTERN.test(text))
	);
}

export const toolCallDomain: ErrorDomain = {
	id: "tool-call",
	why: "The model emitted a tool call the provider could not parse, so nothing ran and the turn can be sent again.",
	recovers: [Flag.MalformedFunctionCall],
	replaySafe: true,
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "retry" },
	},
	rules: [
		{
			flags: Flag.MalformedFunctionCall,
			name: "malformed-function-call",
			why: "Google returns MALFORMED_FUNCTION_CALL as a finish reason wrapped into prose; the call never parsed, so there is nothing to duplicate and the turn is safe to retry.",
			text: text => MALFORMED_FUNCTION_CALL_PATTERN.test(text),
		},
	],
};

export const streamDomain: ErrorDomain = {
	id: "stream",
	why: "The stream ended without saying what failed, or referred to server-side state that is gone.",
	recovers: [Flag.ProviderFinishError, Flag.StaleResponsesItem],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "retry" },
	},
	rules: [
		{
			flags: Flag.ProviderFinishError,
			name: "provider-finish-error",
			why: "A stream that finished with reason 'error' and no status: the provider ended the turn without saying what failed.",
			text: text => PROVIDER_FINISH_ERROR_PATTERN.test(text),
		},
		{
			flags: Flag.StaleResponsesItem,
			name: "stale-responses-item",
			why: "Only the Responses APIs carry server-side conversation items, so only they can be told an item is gone; the same sentence from another api means something else.",
			structural: signal => signal.api === "openai-responses" || signal.api === "openai-codex-responses",
			text: isStaleResponsesText,
		},
	],
};

export const thinkingLoopDomain: ErrorDomain = {
	id: "thinking-loop",
	why: "The repetition detector stopped a turn that was producing the same thinking over and over.",
	recovers: [Flag.ThinkingLoop],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "retry" },
	},
};

const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;

export const contentDomain: ErrorDomain = {
	id: "content",
	why: "A content filter answered the request. The provider decided, and the same request gets the same answer.",
	recovers: [Flag.ContentBlocked],
	vetoesRetry: true,
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "surface" },
	},
	rules: [
		{
			flags: Flag.ContentBlocked,
			name: "content-filter",
			why: "A content filter is a verdict on the request, not a fault: it is the one kind that must never be retried.",
			text: text => CONTENT_FILTER_PATTERN.test(text),
		},
	],
};

export const interruptDomain: ErrorDomain = {
	id: "interrupt",
	why: "The turn ended because the operator or an internal step asked it to, so there is nothing to recover.",
	recovers: [Flag.Abort, Flag.UserInterrupt, Flag.SilentAbort],
	vetoesRetry: true,
	recovery: {
		transport: { action: "abort" },
		credential: { action: "abort" },
		turn: { action: "abort" },
	},
	classes: [
		{
			name: "abort-by-error-name",
			why: "A cancellation states itself in its name, and the name is the only thing every layer that mints one agrees on: a DOM `AbortError` from a fetch, `RequestAbortError` from a provider, `ToolAbortError` from the tool loop. Without this rule the flag reached the id only from the classes that attach it themselves, so a cancellation that arrived from the platform carried no flag and was read as an unclassified failure — and the provider ladder retried it, because the only thing left to read was the word `aborted` in its own sentence.",
			matches: link => isAbortError(link),
			flags: () => Flag.Abort,
		},
	],
};
