import { http2RetryVerdict, isUnexpectedSocketCloseMessage } from "@veyyon/utils/fetch-retry";
import type { Api, AssistantMessage } from "../types";
import { AwsCredentialsError } from "./aws";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	ProviderHttpError,
	STREAM_ENVELOPE_ERROR_PREFIX,
} from "./classes";
import { isOpaqueStatusBody, matchesUsageLimitText, parseRateLimitReason } from "./rate-limit";

export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	ContentBlocked: 0x0000_8000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,
	/** Strict-tool rejection (400): grammar too large, schema too complex, or structured outputs unsupported by the model/endpoint. */
	Grammar: 0x1000_0000,
	/** Anthropic model/account does not support fast mode / the `speed` parameter. */
	FastModeUnsupported: 0x2000_0000,
	/** OAuth refresh failed definitively — the stored grant is dead, re-login required. */
	OAuthExpiry: 0x4000_0000,
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

const KIND_MASK =
	Flag.ThinkingLoop |
	Flag.Transient |
	Flag.Timeout |
	Flag.UsageLimit |
	Flag.StaleResponsesItem |
	Flag.MalformedFunctionCall |
	Flag.ProviderFinishError |
	Flag.ContentBlocked |
	Flag.ContextOverflow |
	Flag.AuthFailed |
	Flag.SilentAbort |
	Flag.UserInterrupt |
	Flag.Abort |
	Flag.Grammar |
	Flag.FastModeUnsupported |
	Flag.OAuthExpiry;

const RETRIABLE_KINDS =
	Flag.Transient | Flag.UsageLimit | Flag.ThinkingLoop | Flag.StaleResponsesItem | Flag.ProviderFinishError;

const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/requested tokens?.*exceed.*context (window|length|size)/i, // llama.cpp / OpenAI-compatible local servers
	/context (window|length|size).*(exceeded|overflow|too small)/i, // Generic local server variants
	/(prompt|input).*(too long|too large).*(context|n_ctx)/i, // llama.cpp phrasing variants
	/requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i, // llama.cpp n_ctx variants
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/request_too_large/i, // Anthropic 413 (request body too large)
	/request exceeds the maximum size/i, // Anthropic 413 variant
	/payload too large/i, // Generic HTTP 413 variant
	/entity too large/i, // Generic HTTP 413 variant
	/\b413\b.*\b(request|payload|entity)\b.*\btoo large\b/i, // "413 Request Entity Too Large" variants
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt filled the context window/i, // Ollama OpenAI-compatible empty length completion
];

const OVERFLOW_NO_BODY_PATTERN = /\b4(00|13)\s*(status code)?\s*\(no body\)/i;
const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
const TRANSIENT_ENVELOPE_BEFORE_START_PATTERN = /before message_start/i;
export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
/**
 * THE STATUS NUMBERS ARE WORD-BOUNDED, and they used to be bare.
 *
 * `429|500|502|503|504` with nothing around them matches those digits ANYWHERE in the message, so
 * this classified as a transient transport failure any error whose text merely contained them:
 * `invalid_argument: bad tool schema (trace ID: aaa503bbb)` was retried as a server fault, and so
 * was `model 500m-params is not supported`. Devin puts a hex trace ID in every message it sends,
 * which is how this surfaced, but the reach is every provider and every message with a digit run in
 * it: a token count, a timestamp, a request id.
 *
 * It fails in the expensive direction. A permanent failure classified transient is retried through
 * the whole budget with backoff before the operator is told anything, and for a rate limit that
 * means burning real quota on a request that cannot succeed.
 *
 * THE GUARD IS `[\w-]`, NOT `\b`, and the hyphen is the whole reason. `\b` alone still matched
 * `gpt-504-turbo` and every other hyphenated identifier, because a hyphen is a non-word character
 * and therefore a word boundary; the model-name case is exactly where this class of false positive
 * lives. Excluding a neighbouring hyphen as well as a neighbouring word character narrows nothing
 * real, since every genuine rendering has whitespace, punctuation that is not a hyphen, or a string
 * edge beside the number: `503`, `HTTP 503`, `status: 503`, `(503)`, `upstream/502`, `503.`
 */
export const TRANSIENT_TRANSPORT_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|(?<![\w-])(?:429|500|502|503|504)(?![\w-])|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;
const MALFORMED_FUNCTION_CALL_PATTERN = /\bmalformed.?function.?call\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;
const STALE_RESPONSE_ITEM_PATTERNS = [/\bItem with id ['"][^'"]+['"] not found\.?/i, /previous[ _]?response/i] as const;
const STALE_RESPONSE_ITEM_DETAIL_PATTERN = /not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i;
/**
 * Local llama.cpp / Ollama deterministic tool-call argument JSON parse failure.
 * The model emitted invalid JSON in a tool call and the server returned HTTP 500
 * with this exact text — replaying the same prompt yields the same malformed
 * output, so callers strip {@link Flag.Transient} when this matches.
 */
export const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

// Copilot routing flap: HTTP 400 `model_not_supported` (structural code on the
// error, also surfaced in text). Treated as transient — a retry usually lands
// on a backend that has the model.
const COPILOT_MODEL_NOT_SUPPORTED_PATTERN = /model_not_supported/i;
// Anthropic strict-tool grammar too large / schema too complex (400 invalid_request_error).
// Feature-gated deployments (Azure Foundry, Baseten, …) reject `strict: true`
// tools outright when the hosted model lacks structured outputs, e.g.
// "structured_outputs not supported" — without an invalid_request_error wrapper.
const GRAMMAR_TOO_LARGE_PATTERN = /compiled grammar/i;
const GRAMMAR_TOO_LARGE_DETAIL_PATTERN = /too large/i;
const SCHEMA_TOO_COMPLEX_PATTERN = /schema/i;
const SCHEMA_TOO_COMPLEX_DETAIL_PATTERN = /too complex/i;
const SCHEMA_COMPILE_PATTERN = /compil/i;
const INVALID_REQUEST_PATTERN = /invalid_request_error/i;
const STRUCTURED_OUTPUTS_PATTERN = /structured[_ -]?outputs?/i;
const FEATURE_NOT_SUPPORTED_PATTERN = /not (?:supported|available|enabled)|unsupported|does(?: not|n'?t) support/i;
// Anthropic fast-mode unsupported: 400 rejecting `speed`, or 429 rate_limit_error
// because the account lacks the extra-usage entitlement fast mode requires.
const FAST_MODE_SPEED_PARAM_PATTERN = /\bspeed\b/i;
const FAST_MODE_NOT_SUPPORTED_PATTERN = /not support/i;
const FAST_MODE_RATE_LIMIT_PATTERN = /rate_limit_error/i;
const FAST_MODE_ENTITLEMENT_PATTERN = /fast mode/i;
// Definitive OAuth refresh failure — the stored grant/client is dead.
//
// Two spellings, because providers use both. The first alternation is the
// machine-readable RFC 6749 §5.2 error codes, which is what a well-formed token
// endpoint returns. The second is the same conditions written as PROSE, which
// several providers return instead of, or alongside, the code: Kimi answers a
// dead grant with `400 "The provided authorization grant is invalid"`. That
// carries no code and is not a 401, so before the prose form was recognised
// every dead Kimi grant classified as transient, and the credential was blocked
// for five minutes and retried forever instead of being disabled once with a
// re-login prompt.
//
// The prose form is deliberately narrow: an invalidity word has to sit next to
// the thing that is invalid (`grant` or `refresh token`), in either order and
// with at most a short run of words between. A bare "invalid" or "expired"
// anywhere in a message is not enough, because a wrong "yes" here disables a
// working account (see {@link isOAuthExpiry}). The transient guard still runs
// first and still wins, so a 429 or a 5xx page repeating this prose stays
// transient.
const OAUTH_DEFINITIVE_FAILURE_PATTERN = new RegExp(
	[
		String.raw`invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired`,
		String.raw`(?:authorization\s+)?grant(?:\s+\w+){0,3}\s+(?:is\s+|was\s+|has\s+been\s+)?(?:invalid|expired|revoked)`,
		String.raw`refresh[\s_]?token(?:\s+\w+){0,3}\s+(?:is\s+|was\s+|has\s+been\s+)?(?:invalid|expired|revoked|not found)`,
		String.raw`(?:invalid|expired|revoked)\s+(?:\w+\s+){0,2}(?:authorization\s+)?(?:grant|refresh[\s_]?token)`,
	].join("|"),
	"i",
);
const OAUTH_TRANSIENT_FAILURE_PATTERN =
	/timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

function matchesStrictToolsRejection(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (STRUCTURED_OUTPUTS_PATTERN.test(message) && FEATURE_NOT_SUPPORTED_PATTERN.test(message)) return true;
	if (!INVALID_REQUEST_PATTERN.test(message)) return false;
	const grammarTooLarge = GRAMMAR_TOO_LARGE_PATTERN.test(message) && GRAMMAR_TOO_LARGE_DETAIL_PATTERN.test(message);
	const schemaTooComplex =
		SCHEMA_TOO_COMPLEX_PATTERN.test(message) &&
		SCHEMA_TOO_COMPLEX_DETAIL_PATTERN.test(message) &&
		SCHEMA_COMPILE_PATTERN.test(message);
	return grammarTooLarge || schemaTooComplex;
}

function matchesFastModeUnsupported(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400 && errorStatus !== 429) return false;
	if (
		errorStatus === 400 &&
		INVALID_REQUEST_PATTERN.test(message) &&
		FAST_MODE_SPEED_PARAM_PATTERN.test(message) &&
		FAST_MODE_NOT_SUPPORTED_PATTERN.test(message)
	) {
		return true;
	}
	return (
		errorStatus === 429 && FAST_MODE_RATE_LIMIT_PATTERN.test(message) && FAST_MODE_ENTITLEMENT_PATTERN.test(message)
	);
}

/**
 * Strip an appended stack trace from an error string before classifying it.
 *
 * Callers reach the classifier with `String(error)`, and this codebase's errors
 * embed their cause chain AND their stack, so the string that arrives is not a
 * message: it carries source paths and frame names. Matching failure keywords
 * against that is matching against the names of our own files.
 *
 * It was not theoretical. A real dead grant
 * (`400 {"error":"invalid_grant","error_description":"Refresh token not found
 * or invalid"}`) arrived with `at async withScopedTimeoutSignal
 * (…/utils/src/scoped-timeout.ts:53:16)` in its stack, and `scoped-timeout`
 * matches the transient pattern's `timeout`. Every OAuth failure refreshed
 * through that helper carried the word, so the transient guard was reading a
 * frame name rather than anything the provider said.
 *
 * The old ordering hid it, because the definitive check returned before the
 * transient guard was ever consulted. Making the guard authoritative surfaced
 * it immediately, which is the useful kind of regression: the guard was always
 * wrong, it just never got to be wrong about anything that mattered.
 */
function withoutStackTrace(errorMessage: string): string {
	const stackMarker = errorMessage.indexOf("stack=");
	const withoutAppendedStack = stackMarker === -1 ? errorMessage : errorMessage.slice(0, stackMarker);
	return withoutAppendedStack
		.split("\n")
		.filter(line => !/^\s+at\s/.test(line))
		.join("\n");
}

/**
 * Whether an OAuth refresh error message means the grant is definitively dead.
 *
 * Saying yes DISABLES the credential, which forces the user through a re-login,
 * so the two answers are not symmetric. A wrong "yes" destroys a working account
 * over a blip; a wrong "no" costs one more retry. Anything ambiguous therefore
 * resolves to no.
 *
 * That is why the transient check comes FIRST and applies to every message, not
 * just to a bare 401. A message can carry both signals: a gateway 502 whose body
 * echoes a `WWW-Authenticate: Bearer error="invalid_token"` header, a 429 whose
 * payload repeats the request it throttled, a 5xx error page containing the word
 * "revoked". Those used to disable the credential outright, because a definitive
 * token matched and returned before the transient guard was ever consulted, and
 * the guard was only ever reached on the 401 branch. A throttled auth endpoint
 * could permanently tear down a healthy account.
 */
export function isOAuthExpiry(errorMessage: string): boolean {
	const diagnostic = withoutStackTrace(errorMessage);
	if (OAUTH_TRANSIENT_FAILURE_PATTERN.test(diagnostic)) return false;
	if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(diagnostic)) return true;
	return OAUTH_HTTP_AUTH_PATTERN.test(diagnostic);
}

const ERROR_KIND_LABELS: readonly [Flag, string][] = [
	[Flag.ThinkingLoop, "thinking-loop"],
	[Flag.Transient, "transient"],
	[Flag.Timeout, "timeout"],
	[Flag.UsageLimit, "usage-limit"],
	[Flag.StaleResponsesItem, "stale-responses-item"],
	[Flag.MalformedFunctionCall, "malformed-function-call"],
	[Flag.ProviderFinishError, "provider-finish-error"],
	[Flag.ContentBlocked, "content-blocked"],
	[Flag.ContextOverflow, "context-overflow"],
	[Flag.AuthFailed, "auth-failed"],
	[Flag.SilentAbort, "silent-abort"],
	[Flag.UserInterrupt, "user-interrupt"],
	[Flag.Abort, "abort"],
];

const STATUS_MESSAGE_PATTERNS = [
	/\bstatus(?:_code)?[:=]\s*(\d{3})\b/i,
	/\bstatus\s+(\d{3})\b/i,
	/\bHTTP\s+(\d{3})\b/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/(?:^|\s)(\d{3})\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
] as const;

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

/**
 * Whether a failed turn is worth another attempt.
 *
 * `replayUnsafe` means the failed assistant message already carried a tool
 * call, so the tool may have run and replaying would duplicate its effect. That
 * is a separate question from whether the failure was transient, and it wins:
 * a transport fault says the next attempt could differ, never that repeating
 * the turn is safe. HTTP/2 stream resets are classified transient for exactly
 * that reason and deliberately get no bypass here, because a reset that arrives
 * after the stream delivered a tool call is precisely the case the guard
 * exists for. `MalformedFunctionCall` is the one exception: the call was never
 * well-formed enough to execute, so there is nothing to duplicate.
 */
export function retriable(id: number | undefined, opts?: { replayUnsafe?: boolean }): boolean {
	if (is(id, Flag.ContentBlocked)) return false;
	if (is(id, Flag.MalformedFunctionCall)) return true;
	if (opts?.replayUnsafe) return false;
	return ((id ?? 0) & RETRIABLE_KINDS) !== 0;
}

function isClassified(id: number | undefined): boolean {
	return ((id ?? 0) & Flag.Class) !== 0;
}

function statusFromId(id: number | undefined): number | undefined {
	return id && !isClassified(id) ? id : undefined;
}

export function status(error: unknown): number | undefined {
	return statusInternal(error, 0);
}

function statusInternal(error: unknown, depth: number): number | undefined {
	if (depth > 2 || error === undefined || error === null) return undefined;
	if (typeof error === "object") {
		const errObj = error as Record<string, unknown>;

		if (typeof errObj.status === "number" && errObj.status >= 100 && errObj.status <= 599) {
			return errObj.status;
		}
		if (typeof errObj.statusCode === "number" && errObj.statusCode >= 100 && errObj.statusCode <= 599) {
			return errObj.statusCode;
		}
		if (typeof errObj.response === "object" && errObj.response !== null) {
			const resp = errObj.response as Record<string, unknown>;
			if (typeof resp.status === "number" && resp.status >= 100 && resp.status <= 599) {
				return resp.status;
			}
		}

		if ("cause" in errObj) {
			const nested = statusInternal(errObj.cause, depth + 1);
			if (nested !== undefined) return nested;
		}
	}

	if (error instanceof Error || (typeof error === "object" && error !== null && "message" in error)) {
		const message = (error as { message: string }).message;
		if (typeof message === "string") {
			for (const pattern of STATUS_MESSAGE_PATTERNS) {
				const match = pattern.exec(message);
				if (match) {
					const code = parseInt(match[1], 10);
					if (code >= 100 && code <= 599) return code;
				}
			}
		}
	}
	return undefined;
}

export function isStreamReadErrorText(text: string): boolean {
	return STREAM_READ_ERROR_PATTERN.test(text);
}

function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		(TRANSIENT_ENVELOPE_PATTERN.test(text) && TRANSIENT_ENVELOPE_BEFORE_START_PATTERN.test(text)) ||
		TRANSIENT_TRANSPORT_PATTERN.test(text)
	);
}

function isTimeoutText(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

function isAuthFailureText(text: string): boolean {
	return AUTH_FAILURE_PATTERN.test(text);
}

function isStaleResponsesText(text: string): boolean {
	return (
		STALE_RESPONSE_ITEM_PATTERNS[0].test(text) ||
		(STALE_RESPONSE_ITEM_PATTERNS[1].test(text) && STALE_RESPONSE_ITEM_DETAIL_PATTERN.test(text))
	);
}

function isMalformedFunctionCallText(text: string): boolean {
	return MALFORMED_FUNCTION_CALL_PATTERN.test(text);
}

function isProviderFinishErrorText(text: string): boolean {
	return PROVIDER_FINISH_ERROR_PATTERN.test(text);
}

function isContentBlockedText(text: string): boolean {
	return CONTENT_FILTER_PATTERN.test(text);
}

function matchesOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some(p => p.test(text)) || OVERFLOW_NO_BODY_PATTERN.test(text);
}

function classifyText(errorMessage: string | undefined, errorStatus: number | undefined, api?: Api): number {
	let kinds = 0;
	if (errorMessage) {
		if (matchesOverflowText(errorMessage)) kinds |= Flag.ContextOverflow;
		if (isMalformedFunctionCallText(errorMessage)) kinds |= Flag.MalformedFunctionCall;
		if (isProviderFinishErrorText(errorMessage)) kinds |= Flag.ProviderFinishError;
		if (isContentBlockedText(errorMessage)) kinds |= Flag.ContentBlocked;
		if (isAuthFailureText(errorMessage)) kinds |= Flag.AuthFailed;

		const statusClean = errorStatus ? errorStatus : (status({ message: errorMessage }) ?? undefined);
		const cleanMessage = errorMessage;
		const isOpaque = isOpaqueStatusBody(cleanMessage);

		const isLimitStatus = statusClean === 429;
		if (
			matchesUsageLimitText(cleanMessage) ||
			(isLimitStatus && (isOpaque || parseRateLimitReason(cleanMessage) === "QUOTA_EXHAUSTED"))
		) {
			kinds |= Flag.UsageLimit;
		}

		// A named HTTP/2 error code (RFC 7540 section 7) is a fact about the
		// transport, so it decides transience on its own and the wording heuristics
		// below never see the message. They cannot read these codes: they matched
		// `NGHTTP2_INTERNAL_ERROR` only because it contains the phrase "internal
		// error", and they would just as happily promote a wrapper around
		// `NGHTTP2_CANCEL` -- our own abort -- back into the retry loop.
		const http2Verdict = http2RetryVerdict(errorMessage);
		if (http2Verdict !== undefined) {
			if (http2Verdict) kinds |= Flag.Transient;
			// The verdict owns TRANSIENCE and nothing else. Flag.Timeout is not in
			// RETRIABLE_KINDS, so it authorizes no retry on its own; it tells the
			// candidate loops the fault was a timeout, which is what makes
			// auto-compaction move to the next model instead of re-sending a full
			// context to the one that just timed out. Suppressing it alongside
			// transience threw that signal away for every wrapper whose prose named
			// a timeout around an HTTP/2 code.
			if (isTimeoutText(errorMessage)) kinds |= Flag.Timeout;
			// The verdict owns TRANSIENCE and nothing else. Flag.Timeout is not in
			// RETRIABLE_KINDS, so it authorizes no retry on its own; it tells the
			// candidate loops the fault was a timeout, which is what makes
			// auto-compaction move to the next model instead of re-sending a full
			// context to the one that just timed out. Suppressing it alongside
			// transience threw that signal away for every wrapper whose prose named
			// a timeout around an HTTP/2 code.
		} else if (isTimeoutText(errorMessage)) kinds |= Flag.Transient | Flag.Timeout;
		else if (isTransientErrorText(errorMessage)) kinds |= Flag.Transient;
		if ((api === "openai-responses" || api === "openai-codex-responses") && isStaleResponsesText(errorMessage)) {
			kinds |= Flag.StaleResponsesItem;
		}

		// Copilot per-client routing flap is transient.
		if (statusClean === 400 && COPILOT_MODEL_NOT_SUPPORTED_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		if (matchesStrictToolsRejection(cleanMessage, statusClean)) kinds |= Flag.Grammar;
		if (matchesFastModeUnsupported(cleanMessage, statusClean)) kinds |= Flag.FastModeUnsupported;
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) return create(Flag.AuthFailed);
	return fallbackStatus ?? 0;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);

			if ("errorId" in link && typeof (link as { errorId: unknown }).errorId === "number") {
				kinds |= (link as { errorId: number }).errorId & KIND_MASK;
			}
		}

		if (link instanceof AwsCredentialsError) {
			kinds |= Flag.AuthFailed;
		} else if (link instanceof AnthropicConnectionTimeoutError) {
			kinds |= Flag.Timeout | Flag.Transient;
		} else if (link instanceof AnthropicConnectionError) {
			kinds |= Flag.Transient;
		} else if (
			typeof link === "object" &&
			"name" in link &&
			(link as { name: string }).name === "CodexWebSocketTransportError"
		) {
			kinds |= Flag.Transient;
		} else if (
			link instanceof Error &&
			link.name === "CodexProviderStreamError" &&
			"retryable" in link &&
			(link as { retryable: unknown }).retryable === true
		) {
			kinds |= Flag.Transient;
		} else if (link instanceof ProviderHttpError) {
			let linkKinds = 0;
			const { status: codeStatus, code } = link;
			if (code === "usage_limit_reached" || code === "insufficient_quota") {
				linkKinds |= Flag.UsageLimit;
			}
			if (code === "overloaded_error" || code === "rate_limit_error") {
				linkKinds |= Flag.Transient;
			}
			if (codeStatus === 401 || codeStatus === 403) {
				linkKinds |= Flag.AuthFailed;
			} else if (codeStatus === 429) {
				if ((linkKinds & Flag.UsageLimit) === 0) {
					linkKinds |= Flag.Transient;
				}
			} else if (codeStatus >= 500) {
				linkKinds |= Flag.Transient;
			}
			kinds |= linkKinds;
		}

		let linkMessage: string | undefined;
		if (link instanceof Error) {
			linkMessage = link.message;
		} else if (typeof link === "string") {
			linkMessage = link;
		} else if (
			typeof link === "object" &&
			"message" in link &&
			typeof (link as { message: unknown }).message === "string"
		) {
			linkMessage = (link as { message: string }).message;
		}

		const textId = classifyText(linkMessage, status(link), api);
		kinds |= textId & KIND_MASK;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	return kinds !== 0 ? create(kinds) : (status(error) ?? 0);
}

/**
 * Whether an error (or message string) classifies as an account usage/quota
 * limit — the persistent, credential-rotation-worthy kind. This is the public
 * accessor for {@link Flag.UsageLimit}; prefer it over re-running message
 * regexes at call sites.
 */
export function isUsageLimit(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.UsageLimit);
}

/**
 * Strict-tool rejection: grammar too large, schema too complex, or structured
 * outputs unsupported by the model/endpoint.
 * Accessor for {@link Flag.Grammar}.
 */
export function isGrammarError(error: unknown): boolean {
	return is(classify(error), Flag.Grammar);
}

/**
 * Anthropic model/account does not support fast mode / the `speed` parameter.
 * Accessor for {@link Flag.FastModeUnsupported}.
 */
export function isFastModeUnsupported(error: unknown): boolean {
	return is(classify(error), Flag.FastModeUnsupported);
}

/**
 * GitHub Copilot 400 `model_not_supported` routing flap — transient. Reads the
 * structural `code` (and falls back to {@link Flag.Transient} text classification).
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (status(error) === 400 && error && typeof error === "object") {
		const info = error as { code?: unknown; error?: { code?: unknown } | null };
		const code = typeof info.code === "string" ? info.code : info.error?.code;
		if (code === "model_not_supported") return true;
	}
	return false;
}

export function classifyMessage(message: {
	api?: Api;
	errorId?: number;
	errorMessage?: string;
	errorStatus?: number;
}): number {
	const existingId = message.errorId;
	const currentStatus = message.errorStatus ?? statusFromId(existingId);
	const textId = classifyText(message.errorMessage, currentStatus, message.api);

	let kinds = ((existingId ?? 0) | textId) & KIND_MASK;
	if (message.errorMessage && LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message.errorMessage)) {
		// Deterministic local-model tool-call JSON parse failure: HTTP 500 is misleading
		// because the same prompt reproduces the same malformed output, so the agent-level
		// auto-retry would loop. Strip Transient so the recovery message surfaces immediately.
		kinds &= ~Flag.Transient;
	}
	const id = kinds !== 0 ? create(kinds) : (statusFromId(textId) ?? statusFromId(existingId) ?? currentStatus ?? 0);

	message.errorId = id;
	return id;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (is(message.errorId, Flag.ContextOverflow)) return true;
	if (contextWindow) {
		const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (inputTokens > contextWindow) return true;
	}
	return message.stopReason === "error" && !!message.errorMessage && matchesOverflowText(message.errorMessage);
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}

const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;

/** Transient stream corruption where the response was truncated mid-JSON. */
export function isTransientStreamParseError(error: unknown): boolean {
	return error instanceof Error && STREAM_PARSE_TRUNCATION_PATTERN.test(error.message);
}

/** Any malformed stream-envelope error (prefix-tagged or out-of-order events). */
export function isStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) || STREAM_EVENT_ORDER_PATTERN.test(error.message))
	);
}

/** Stream-envelope errors safe to retry against the provider (event ordering only). */
export function isRetryableStreamEnvelopeError(error: unknown): boolean {
	return error instanceof Error && STREAM_EVENT_ORDER_PATTERN.test(error.message);
}
