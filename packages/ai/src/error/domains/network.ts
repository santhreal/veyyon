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

function isTimeoutText(text: string): boolean {
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
			name: "anthropic-connection-timeout",
			why: "An Anthropic connection timeout states both facts in its type: it timed out, and the socket fault behind it is repeatable.",
			matches: link => link instanceof AnthropicConnectionTimeoutError,
			flags: () => Flag.Timeout | Flag.Transient,
		},
	],
	rules: [
		{
			flags: Flag.Timeout,
			name: "timeout-with-http2-verdict",
			why: "The HTTP/2 verdict owns transience and nothing else. Flag.Timeout authorizes no retry on its own; it tells the candidate loops the fault was a timeout, which is what makes auto-compaction move to the next model instead of re-sending a full context to the one that just timed out.",
			structural: signal => signal.http2 !== undefined,
			text: isTimeoutText,
		},
		{
			flags: Flag.Transient | Flag.Timeout,
			name: "timeout-without-http2-verdict",
			why: "A timeout with no HTTP/2 code is transient and a timeout: the next attempt can differ, and the caller needs to know which fault it was.",
			structural: signal => signal.http2 === undefined,
			text: isTimeoutText,
		},
	],
};

export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
export const STREAM_BEFORE_MESSAGE_START_PATTERN = /before message_start/i;
export const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
export const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;
const STREAM_CORRUPTION_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|(?<![\w-])1302(?![\w-])/i;
export const STREAM_NO_TERMINAL_REASON_PATTERN =
	/\b(?:closed|ended|stopped|terminated|finished)\b[^.]{0,48}?\b(?:before|without)\b[^.]{0,32}?(?:terminal\s+)?(?:finish[_\s]reason|terminal\s+event)|\breturned an empty response\b/i;

function isStreamCorruptionText(text: string): boolean {
	return (
		STREAM_PARSE_TRUNCATION_PATTERN.test(text) ||
		STREAM_EVENT_ORDER_PATTERN.test(text) ||
		STREAM_CORRUPTION_EXTRA_PATTERN.test(text) ||
		STREAM_NO_TERMINAL_REASON_PATTERN.test(text)
	);
}

const COPILOT_MODEL_NOT_SUPPORTED_CODE = "model_not_supported";
const COPILOT_MODEL_NOT_SUPPORTED_PATTERN = /model_not_supported/i;

export const DEAD_SOCKET_ERRNOS = [
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EPIPE",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EAI_AGAIN",
] as const;

export const DEAD_SOCKET_PHRASE_SOURCES = [
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"unable to connect",
	"fetch failed",
] as const;

const DEAD_SOCKET_SOURCE = `${DEAD_SOCKET_PHRASE_SOURCES.join("|")}|(?<![\\w-])(?:${DEAD_SOCKET_ERRNOS.join("|")})(?![\\w-])`;

export const DEAD_SOCKET_PATTERN = new RegExp(DEAD_SOCKET_SOURCE, "i");

export function namesDeadSocket(text: string): boolean {
	return DEAD_SOCKET_PATTERN.test(text);
}

export const TRANSIENT_TRANSPORT_PATTERN = new RegExp(
	String.raw`overloaded|provider.?returned.?error|rate.?limit|too many requests|temporar(?:y|ily)|processing your request|(?<![\w-])(?:429|500|502|503|504)(?![\w-])|service.?unavailable|server.?error|internal.?error|retry your request|other side closed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|websocket closed|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|malformed.?function.?call|` +
		DEAD_SOCKET_SOURCE,
	"i",
);

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

export function http2Verdict(text: string): boolean | undefined {
	return http2RetryVerdict(text);
}

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
			name: "anthropic-connection-error",
			why: "An Anthropic connection fault states its own transience in its type. The timeout subclass is excluded because it is its own family and carries a second flag.",
			matches: link =>
				link instanceof AnthropicConnectionError && !(link instanceof AnthropicConnectionTimeoutError),
			flags: () => Flag.Transient,
		},
		{
			name: "codex-websocket-transport",
			why: "A Codex websocket transport error is a dead socket, whatever sentence the wrapper around it composed.",
			matches: link => link instanceof CodexWebSocketTransportError,
			flags: () => Flag.Transient,
		},
		{
			name: "codex-retryable-stream",
			why: "A Codex stream error carries the provider's own retryable verdict; reading it beats re-deriving one from its message.",
			matches: link => link instanceof CodexProviderStreamError && link.retryable,
			flags: () => Flag.Transient,
		},
	],
	rules: [
		{
			flags: Flag.Transient,
			name: "named-http2-retryable-code",
			why: "A named HTTP/2 error code is a fact about the transport, so it decides transience on its own and no wording heuristic is consulted: the heuristics matched NGHTTP2_INTERNAL_ERROR only for containing 'internal error', and would have promoted a wrapper around NGHTTP2_CANCEL — our own abort — back into the retry loop.",
			structural: signal => signal.http2 === true,
		},
		{
			flags: Flag.Transient,
			name: "transport-vocabulary",
			why: "The transport vocabulary of last resort: a socket that closed, a gateway page, an errno. It reads prose because a dead socket arrives as a rejection with no status, and its status numbers are word-bounded for the same reason (see TRANSIENT_TRANSPORT_PATTERN).",
			structural: signal => signal.http2 === undefined,
			text: text => !isTimeoutText(text) && isTransientErrorText(text),
		},
		{
			flags: Flag.Transient,
			name: "stream-corruption",
			why: "A stream whose bytes did not survive the transport: a body that stopped mid-JSON, an envelope whose events arrived out of order, a corrupted TLS record, a peer-reported HTTP/2 stream error. Read here rather than at the provider ladder, which held these words alone: the same truncated proxy response was retried there and reached the turn carrying no flag at all.",
			structural: signal => signal.http2 === undefined,
			text: isStreamCorruptionText,
		},
		{
			flags: Flag.Transient,
			name: "copilot-model-not-supported-flap",
			why: "Copilot's per-client routing flap: a 400 model_not_supported for a model the account has, where a retry usually lands on a backend that serves it. The code counts wherever the provider put it — a `code` field, the SDK's nested `error.code`, or the body text — because reading only the text made this rule disagree with the Copilot ladder, which read only the field.",
			structural: signal => signal.status === 400 && isCopilotModelNotSupported(signal),
		},
	],
};

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
			name: "stream-frame-limit-breach",
			why: "A framing violation is the peer's own protocol breach: it sent bytes its protocol says must be delimited and never delimited them. The flag was previously nowhere — the classifier cleared `Flag.Transient` for the chain and stopped there, so the veto readers had nothing to read and the provider ladder needed a hand-written check of its own, which a timeout-worded wrapper around the breach still got past.",
			matches: link => isStreamFrameLimitError(link),
			flags: () => Flag.TransportRefused,
		},
	],
	rules: [
		{
			flags: Flag.TransportRefused,
			name: "named-http2-refused-code",
			why: "A named HTTP/2 error code in the non-retryable set is the peer's own statement that a replay reproduces it; `NGHTTP2_CANCEL` is our own abort, and retrying a cancel is a bug rather than a recovery.",
			structural: signal => signal.http2 === false,
		},
	],
};
