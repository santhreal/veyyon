/**
 * The network families: what the socket did, and what the clock did.
 *
 * `transport` is a fault the next attempt can differ on — a socket that closed, an HTTP/2 stream the
 * peer reset, an errno, a gateway page, a provider that said "overloaded". `refusal` is the same
 * subject with the opposite answer: the peer NAMED a code whose meaning is that a replay reproduces
 * it. `timeout` is neither, because a context that timed out once times out again on the same model,
 * so the turn moves to another one rather than re-sending.
 *
 * The three live together because they partition the same prose between them and read each other's
 * conditions to do it: the transport rule of last resort must not fire on a timeout, and the timeout
 * rules must know whether an HTTP/2 code was named. Splitting them made those two files import each
 * other, which is the same thing with an extra edge.
 */
import { http2RetryVerdict, isUnexpectedSocketCloseMessage } from "@veyyon/utils/fetch-retry";
import { isStreamFrameLimitError } from "@veyyon/utils/stream-frame-limit";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	CodexProviderStreamError,
	CodexWebSocketTransportError,
} from "../classes";
import { Flag } from "../flag";
import type { ErrorDomain } from "./types";

const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;

/** The sole owner of the timeout wording; `domains/transport.ts` reads it to keep its own rule off timeouts. */
export function isTimeoutText(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

export const timeoutDomain: ErrorDomain = {
	id: "timeout",
	why: "The provider was still holding the request open when the deadline passed.",
	recovers: [Flag.Timeout],
	recovery: {
		transport: { action: "retry" },
		credential: { action: "retry" },
		turn: { action: "switch-model" },
	},
	classes: [
		{
			why: "An Anthropic connection timeout states both facts in its type: it timed out, and the socket fault behind it is repeatable.",
			matches: link => link instanceof AnthropicConnectionTimeoutError,
			flags: () => Flag.Timeout | Flag.Transient,
		},
	],
	rules: [
		{
			flags: Flag.Timeout,
			why: "The HTTP/2 verdict owns transience and nothing else. Flag.Timeout authorizes no retry on its own; it tells the candidate loops the fault was a timeout, which is what makes auto-compaction move to the next model instead of re-sending a full context to the one that just timed out.",
			structural: signal => signal.http2 !== undefined,
			text: isTimeoutText,
		},
		{
			flags: Flag.Transient | Flag.Timeout,
			why: "A timeout with no HTTP/2 code is transient and a timeout: the next attempt can differ, and the caller needs to know which fault it was.",
			structural: signal => signal.http2 === undefined,
			text: isTimeoutText,
		},
	],
};

export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
/** `before message_start`: the stream ended before the provider opened the message. */
export const STREAM_BEFORE_MESSAGE_START_PATTERN = /before message_start/i;
/**
 * The stream-corruption vocabulary: a response that arrived in pieces the reader cannot assemble.
 *
 * `STREAM_PARSE_TRUNCATION_PATTERN` is a body that stopped mid-JSON, `STREAM_EVENT_ORDER_PATTERN` an
 * envelope whose events arrived out of order, and `STREAM_CORRUPTION_EXTRA_PATTERN` the three
 * transport phrasings neither of those nor {@link TRANSIENT_TRANSPORT_PATTERN} covers: a TLS record
 * the peer corrupted, an HTTP/2 stream error the peer reported, and the upstream code `1302`. All of
 * it lived in `isProviderRetryableError` as a prose block the provider ladder read and no other
 * reader had, so a truncated stream from an Anthropic-compatible proxy was retried by that ladder
 * and came back to the turn as an unclassified failure. The words are unchanged; the owner is.
 *
 * `1302` is word-bounded for the reason the status numbers are (see {@link
 * TRANSIENT_TRANSPORT_PATTERN}): provider errors carry model ids, request ids and token counts, and
 * a bare four digits matches any of them.
 */
export const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
/** `stream event order`: the envelope's events did not arrive in the order the protocol states. */
export const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;
const STREAM_CORRUPTION_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|(?<![\w-])1302(?![\w-])/i;

/** Whether a message describes a stream whose bytes did not survive the transport. */
export function isStreamCorruptionText(text: string): boolean {
	return (
		STREAM_PARSE_TRUNCATION_PATTERN.test(text) ||
		STREAM_EVENT_ORDER_PATTERN.test(text) ||
		STREAM_CORRUPTION_EXTRA_PATTERN.test(text)
	);
}

// Copilot routing flap: HTTP 400 `model_not_supported` (structural code on the
// error, also surfaced in text). Treated as transient — a retry usually lands
// on a backend that has the model.
const COPILOT_MODEL_NOT_SUPPORTED_CODE = "model_not_supported";
const COPILOT_MODEL_NOT_SUPPORTED_PATTERN = /model_not_supported/i;

/**
 * THE STATUS NUMBERS ARE WORD-BOUNDED, and they used to be bare.
 *
 * A bare `/429|500|502|503|504/` matches those three digits anywhere in a string, and provider
 * errors are full of digits that are not statuses: model ids (`gemini-2.5-pro-preview-05-06`),
 * request ids, token counts, timestamps. `claude-3-5-sonnet-20240502` contains `502`. Every failure
 * whose text happened to carry one of those runs classified as transient and was retried to the end
 * of its budget, including dead credentials and permanent 400s.
 *
 * `(?<![\w-])…(?![\w-])` requires the number to stand alone: not adjacent to a letter, digit,
 * underscore or hyphen. `503 Service Unavailable` still matches; `20240502` does not.
 *
 * `unable to connect` ARRIVED FROM THE SECOND CLASSIFICATION HOME. `@veyyon/utils/fetch-retry` kept
 * its own transient vocabulary and `isProviderRetryableError` consulted it as a last resort, so a
 * provider that could not be reached at all was retried by the utils pattern while carrying no flag
 * of its own — the session layer reads flags, so it saw an unclassified failure. It is the one
 * phrase that list had and this one did not; the rest of it was already here, word for word.
 */
export const TRANSIENT_TRANSPORT_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|temporar(?:y|ily)|processing your request|(?<![\w-])(?:429|500|502|503|504)(?![\w-])|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable to connect|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|malformed.?function.?call|(?<![\w-])(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN)(?![\w-])/i;

export function isStreamReadErrorText(text: string): boolean {
	return STREAM_READ_ERROR_PATTERN.test(text);
}

export function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		(TRANSIENT_ENVELOPE_PATTERN.test(text) && STREAM_BEFORE_MESSAGE_START_PATTERN.test(text)) ||
		TRANSIENT_TRANSPORT_PATTERN.test(text)
	);
}

/** The RFC 7540 §7 verdict for a message naming an HTTP/2 error code, `undefined` when it names none. */
export function http2Verdict(text: string): boolean | undefined {
	return http2RetryVerdict(text);
}

/**
 * The Copilot routing flap, whichever way the provider states it.
 *
 * The code arrives in a `code` field, in the SDK's nested `error.code`, and inside the body text,
 * and the three used to be read by two different owners: the text spelling was a rule here and the
 * field was a separate exported predicate the Copilot ladder called. A 400 whose message said `x`
 * and whose code said `model_not_supported` was therefore retried by that ladder and refused by
 * everything that reads flags. `Signal.code` closed the gap, and this is the only reader of either.
 */
export function isCopilotModelNotSupported(signal: { text: string; code: string | undefined }): boolean {
	return signal.code === COPILOT_MODEL_NOT_SUPPORTED_CODE || COPILOT_MODEL_NOT_SUPPORTED_PATTERN.test(signal.text);
}

export const transportDomain: ErrorDomain = {
	id: "transport",
	why: "The network did not deliver a well-formed answer, so the next attempt can differ.",
	recovers: [Flag.Transient],
	recovery: {
		transport: { action: "retry" },
		credential: { action: "retry" },
		turn: { action: "retry" },
	},
	classes: [
		{
			why: "An Anthropic connection fault states its own transience in its type. The timeout subclass is excluded because it is its own family and carries a second flag.",
			matches: link =>
				link instanceof AnthropicConnectionError && !(link instanceof AnthropicConnectionTimeoutError),
			flags: () => Flag.Transient,
		},
		{
			why: "A Codex websocket transport error is a dead socket, whatever sentence the wrapper around it composed.",
			matches: link => link instanceof CodexWebSocketTransportError,
			flags: () => Flag.Transient,
		},
		{
			why: "A Codex stream error carries the provider's own retryable verdict; reading it beats re-deriving one from its message.",
			matches: link => link instanceof CodexProviderStreamError && link.retryable,
			flags: () => Flag.Transient,
		},
	],
	rules: [
		{
			flags: Flag.Transient,
			why: "A named HTTP/2 error code is a fact about the transport, so it decides transience on its own and no wording heuristic is consulted: the heuristics matched NGHTTP2_INTERNAL_ERROR only for containing 'internal error', and would have promoted a wrapper around NGHTTP2_CANCEL — our own abort — back into the retry loop.",
			structural: signal => signal.http2 === true,
		},
		{
			flags: Flag.Transient,
			why: "The transport vocabulary of last resort: a socket that closed, a gateway page, an errno. It reads prose because a dead socket arrives as a rejection with no status, and its status numbers are word-bounded for the same reason (see TRANSIENT_TRANSPORT_PATTERN).",
			structural: signal => signal.http2 === undefined,
			text: text => !isTimeoutText(text) && isTransientErrorText(text),
		},
		{
			flags: Flag.Transient,
			why: "A stream whose bytes did not survive the transport: a body that stopped mid-JSON, an envelope whose events arrived out of order, a corrupted TLS record, a peer-reported HTTP/2 stream error. Read here rather than at the provider ladder, which held these words alone: the same truncated proxy response was retried there and reached the turn carrying no flag at all.",
			structural: signal => signal.http2 === undefined,
			text: isStreamCorruptionText,
		},
		{
			flags: Flag.Transient,
			why: "Copilot's per-client routing flap: a 400 model_not_supported for a model the account has, where a retry usually lands on a backend that serves it. The code counts wherever the provider put it — a `code` field, the SDK's nested `error.code`, or the body text — because reading only the text made this rule disagree with the Copilot ladder, which read only the field.",
			structural: signal => signal.status === 400 && isCopilotModelNotSupported(signal),
		},
	],
};

/**
 * The refusal family: a transport failure whose next identical attempt fails the same way.
 *
 * Two kinds of evidence say that, and both are structural. The peer NAMED an HTTP/2 code the RFC
 * says a replay reproduces, or the peer never delimited a frame it was still sending — a framing
 * violation reaches the same peer with the same behavior, so a retry is a second helping of it.
 *
 * Separate from `transport` because it is the same subject with the opposite answer, and separate
 * from a wording because a code is a fact. It vetoes a retry for the whole failure and is ordered
 * ahead of `transport` in the registry, so a wrapper that composed "connection error, please retry"
 * around `NGHTTP2_CANCEL` still reads as transient — the description is the wrapper's to write — and
 * is still not retried by anyone. Before this existed, the classifier refused a cancel and then the
 * provider predicate's prose fallback retried it anyway through the words "timed out".
 */
export const refusalDomain: ErrorDomain = {
	id: "refusal",
	why: "The peer named an HTTP/2 code, or never delimited a frame, so the next identical attempt fails the same way.",
	recovers: [Flag.TransportRefused],
	vetoesRetry: true,
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "surface" },
	},
	classes: [
		{
			why: "A framing violation is the peer's own protocol breach: it sent bytes its protocol says must be delimited and never delimited them. The flag was previously nowhere — the classifier cleared `Flag.Transient` for the chain and stopped there, so the veto readers had nothing to read and the provider ladder needed a hand-written check of its own, which a timeout-worded wrapper around the breach still got past.",
			matches: link => isStreamFrameLimitError(link),
			flags: () => Flag.TransportRefused,
		},
	],
	rules: [
		{
			flags: Flag.TransportRefused,
			why: "A named HTTP/2 error code in the non-retryable set is the peer's own statement that a replay reproduces it; `NGHTTP2_CANCEL` is our own abort, and retrying a cancel is a bug rather than a recovery.",
			structural: signal => signal.http2 === false,
		},
	],
};
