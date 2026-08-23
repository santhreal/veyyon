/**
 * The request families: we sent something this endpoint will not take.
 *
 * `overflow` is too many tokens, `grammar` is strict tools it cannot compile, `fast-mode` is a
 * parameter or an entitlement it does not have. No stage below the turn can act on any of them: a
 * socket retry sends the same bytes and a different credential has the same window. The turn either
 * shrinks the request or drops the capability the provider named.
 *
 * `provider-http` sits here too and recovers nothing. It reads the status and the error code a
 * provider sent — facts, not wording — and hands the flags to the families that own them, which is
 * why it cannot live inside any one of them.
 */
import { ProviderHttpError } from "../classes";
import { Flag } from "../flag";
import type { ErrorDomain } from "./types";

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

export function matchesOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some(p => p.test(text)) || OVERFLOW_NO_BODY_PATTERN.test(text);
}

export const overflowDomain: ErrorDomain = {
	id: "overflow",
	why: "The prompt was larger than the window the model declared, so it has to get smaller before it is sent again.",
	recovers: [Flag.ContextOverflow],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "compact" },
	},
	rules: [
		{
			flags: Flag.ContextOverflow,
			why: "Every provider says 'too long' in its own words and none of them says it with a status: 413 and 400 both carry it, and a bare '400 (no body)' carries nothing else at all.",
			text: matchesOverflowText,
		},
	],
};

// Anthropic strict-tool grammar too large / schema too complex (400 invalid_request_error).
// Feature-gated deployments (Azure Foundry, Baseten, …) reject `strict: true` tools outright when
// the hosted model lacks structured outputs, e.g. "structured_outputs not supported" — without an
// invalid_request_error wrapper.
const GRAMMAR_TOO_LARGE_PATTERN = /compiled grammar/i;
const GRAMMAR_TOO_LARGE_DETAIL_PATTERN = /too large/i;
const SCHEMA_TOO_COMPLEX_PATTERN = /schema/i;
const SCHEMA_TOO_COMPLEX_DETAIL_PATTERN = /too complex/i;
const SCHEMA_COMPILE_PATTERN = /compil/i;
const INVALID_REQUEST_PATTERN = /invalid_request_error/i;
const STRUCTURED_OUTPUTS_PATTERN = /structured[_ -]?outputs?/i;
const FEATURE_NOT_SUPPORTED_PATTERN = /not (?:supported|available|enabled)|unsupported|does(?: not|n'?t) support/i;
// Anthropic fast-mode unsupported: 400 rejecting `speed`, or 429 rate_limit_error because the
// account lacks the extra-usage entitlement fast mode requires.
const FAST_MODE_SPEED_PARAM_PATTERN = /\bspeed\b/i;
const FAST_MODE_NOT_SUPPORTED_PATTERN = /not support/i;
const FAST_MODE_RATE_LIMIT_PATTERN = /rate_limit_error/i;
const FAST_MODE_ENTITLEMENT_PATTERN = /fast mode/i;

// The phrasings an endpoint uses to reject strict tools without calling it an invalid request:
// a wire-format complaint, a `strict` value it will not mix, a tool schema it cannot take. These
// arrived from the OpenAI paths, which asked this same question with a vocabulary of their own and a
// second status; the answer is the same wherever it is asked, so the words live here.
const STRICT_TOOLS_REJECTION_PATTERNS = [
	/wrong_api_format/i,
	/mixed values for 'strict'/i,
	/tools?\b.*\bstrict\b|\bstrict\b.*\btools?\b/i,
	/tool parameters? schema/i,
	/invalid schema for function/i,
] as const;

/**
 * The narrow case: a compiled grammar the endpoint will not accept at the size we sent it.
 *
 * Named separately because a caller acts on it differently — the capability is dropped for the rest
 * of the session rather than for one attempt — not because it is a different vocabulary.
 */
export function matchesCompiledGrammarTooLargeText(message: string): boolean {
	return (
		INVALID_REQUEST_PATTERN.test(message) &&
		GRAMMAR_TOO_LARGE_PATTERN.test(message) &&
		GRAMMAR_TOO_LARGE_DETAIL_PATTERN.test(message)
	);
}

/** The body of a strict-tool rejection, in every shape a provider sends it. */
export function matchesStrictToolsRejectionText(message: string): boolean {
	if (STRUCTURED_OUTPUTS_PATTERN.test(message) && FEATURE_NOT_SUPPORTED_PATTERN.test(message)) return true;
	if (STRICT_TOOLS_REJECTION_PATTERNS.some(pattern => pattern.test(message))) return true;
	if (!INVALID_REQUEST_PATTERN.test(message)) return false;
	if (matchesCompiledGrammarTooLargeText(message)) return true;
	return (
		SCHEMA_TOO_COMPLEX_PATTERN.test(message) &&
		SCHEMA_TOO_COMPLEX_DETAIL_PATTERN.test(message) &&
		SCHEMA_COMPILE_PATTERN.test(message)
	);
}

/** The 400 body: the request named `speed` and the model answered that it does not support it. */
export function matchesFastModeRejectedParameterText(message: string): boolean {
	return (
		INVALID_REQUEST_PATTERN.test(message) &&
		FAST_MODE_SPEED_PARAM_PATTERN.test(message) &&
		FAST_MODE_NOT_SUPPORTED_PATTERN.test(message)
	);
}

/** The 429 body: a rate-limit error naming fast mode, which is an entitlement wall, not a throttle. */
export function matchesFastModeEntitlementText(message: string): boolean {
	return FAST_MODE_RATE_LIMIT_PATTERN.test(message) && FAST_MODE_ENTITLEMENT_PATTERN.test(message);
}

export const grammarDomain: ErrorDomain = {
	id: "grammar",
	why: "The endpoint rejected the request for carrying strict tools it cannot compile or does not implement.",
	recovers: [Flag.Grammar],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "degrade", capability: "strict-tools" },
	},
	rules: [
		{
			flags: Flag.Grammar,
			why: "A 400 or 422 rejecting strict tools: grammar too large, schema too complex, a tool schema it cannot take, or structured outputs the endpoint does not have. The turn retries without strict tools and the session remembers the downgrade. 422 counts because the OpenAI-compatible endpoints that answer with it reject the same request for the same reason.",
			structural: signal => signal.status === 400 || signal.status === 422,
			text: matchesStrictToolsRejectionText,
		},
	],
};

export const fastModeDomain: ErrorDomain = {
	id: "fast-mode",
	why: "The model or the account does not have fast mode, so the request goes out without the `speed` parameter.",
	recovers: [Flag.FastModeUnsupported],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "surface" },
		turn: { action: "degrade", capability: "fast-mode" },
	},
	rules: [
		{
			flags: Flag.FastModeUnsupported,
			why: "Anthropic rejects the `speed` parameter with a 400 when the model does not have fast mode; retrying it without the parameter is the recovery, so it is not a throttle.",
			structural: signal => signal.status === 400,
			text: matchesFastModeRejectedParameterText,
		},
		{
			flags: Flag.FastModeUnsupported,
			why: "The same wall arrives as a 429 when the account lacks the extra-usage entitlement fast mode requires. Classified as a throttle it was retried against a limit no wait can clear.",
			structural: signal => signal.status === 429,
			text: matchesFastModeEntitlementText,
		},
	],
};

/**
 * The flags a provider's own status and error code state, with no prose read at all.
 *
 * A 429 is a throttle by default and a quota wall when the code says so, which is why the quota
 * check runs first and the 429 branch defers to it: the same status means "wait" for one account and
 * "this account is finished" for another, and only the code separates them.
 */
function providerHttpFlags(link: ProviderHttpError): number {
	let flags = 0;
	const { status, code } = link;
	if (code === "usage_limit_reached" || code === "insufficient_quota") flags |= Flag.UsageLimit;
	if (code === "overloaded_error" || code === "rate_limit_error") flags |= Flag.Transient;
	if (status === 401 || status === 403) {
		flags |= Flag.AuthFailed;
	} else if (status === 429) {
		if ((flags & Flag.UsageLimit) === 0) flags |= Flag.Transient;
	} else if (status >= 500) {
		flags |= Flag.Transient;
	}
	return flags;
}

export const providerHttpDomain: ErrorDomain = {
	id: "provider-http",
	why: "A provider that states a status and an error code has already classified its own failure; this reads it instead of guessing from the sentence.",
	recovers: [],
	classes: [
		{
			why: "The status and code a provider sent are facts. A 401 is auth, a coded 429 is a spent quota, a bare 429 is a throttle, a 5xx is transport.",
			matches: link => link instanceof ProviderHttpError,
			flags: link => providerHttpFlags(link as ProviderHttpError),
		},
	],
};
