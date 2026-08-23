/**
 * The classifier: what a failure IS, read once off the whole cause chain.
 *
 * Three files, three jobs. `flag.ts` is the vocabulary — one bit per failure kind and the
 * primitives that read a set of them. `domains/` holds one file per failure family: the rules that
 * recognise it and what each stage does about it. `registry.ts` assembles the domains in the order
 * that decides which family speaks when a failure belongs to several. This file is the walk: it
 * takes an arbitrary thrown value, unwraps its cause chain, asks the registry's identity and signal
 * rules about each link, and returns the flags they set between them.
 *
 * The accessors at the bottom are the public way to ask a yes/no question about a failure. They all
 * go through {@link classify}, which is the point: a call site that re-runs a regex of its own is a
 * second opinion, and the second opinion is always the one that disagrees.
 */
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";
import type { Api, AssistantMessage } from "../types";
import { STREAM_ENVELOPE_ERROR_PREFIX } from "./classes";
import { withoutStackTrace } from "./domains/account";
import { http2Verdict, isCopilotModelNotSupported, STREAM_BEFORE_MESSAGE_START_PATTERN } from "./domains/network";
import { matchesOverflowText } from "./domains/request";
import type { Signal } from "./domains/types";
import { create, Flag, is, KIND_MASK, statusFromId } from "./flag";
import { classifyIdentity, classifySignal } from "./registry";

export { isDefinitiveOAuthFailure } from "./domains/account";
export {
	isStreamReadErrorText,
	STREAM_READ_ERROR_PATTERN,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./domains/network";
export type { ClassificationRule, ClassRule, ErrorDomain, Recovery, RecoveryStage, Signal } from "./domains/types";
export * from "./flag";
export {
	CLASS_RULES,
	CLASSIFICATION_RULES,
	classifyIdentity,
	classifySignal,
	domainOf,
	ERROR_DOMAINS,
	REPLAY_SAFE_MASK,
	RETRY_VETO_MASK,
	recover,
	retriable,
	TURN_RETRIABLE_MASK,
} from "./registry";

/**
 * Local llama.cpp / Ollama deterministic tool-call argument JSON parse failure.
 *
 * The server answers 500, which reads as transient, but the same prompt produces the same
 * malformed output every time, so an agent-level retry loops until the budget is gone.
 */
export const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

const STATUS_MESSAGE_PATTERNS = [
	/\bstatus(?:_code)?[:=]\s*(\d{3})\b/i,
	/\bstatus\s+(\d{3})\b/i,
	/\bHTTP\s+(\d{3})\b/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/(?:^|\s)(\d{3})\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
] as const;

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

/** The machine-readable code a provider sent, from `code` or the SDK's nested `error.code`. */
function providerCode(link: unknown): string | undefined {
	if (link === null || typeof link !== "object") return undefined;
	const info = link as { code?: unknown; error?: { code?: unknown } | null };
	if (typeof info.code === "string") return info.code;
	const nested = info.error?.code;
	return typeof nested === "string" ? nested : undefined;
}

function classifyText(
	errorMessage: string | undefined,
	errorStatus: number | undefined,
	api?: Api,
	code?: string,
): number {
	let kinds = 0;
	if (errorMessage || code !== undefined) {
		const text = withoutStackTrace(errorMessage ?? "");
		const signal: Signal = {
			text,
			status: errorStatus ?? status({ message: errorMessage ?? "" }),
			api,
			http2: http2Verdict(text),
			code,
		};
		kinds = classifySignal(signal);
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) return create(Flag.AuthFailed);
	return fallbackStatus ?? 0;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	let framingViolation = false;
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

		kinds |= classifyIdentity(link);

		// A framing violation is the peer's protocol breach, and it decides transience for
		// the whole chain: whatever a wrapper's sentence says, and whatever else the chain
		// mentions, the stream ended because the peer would not delimit its frame and the
		// next attempt reaches the same peer. Its own prose is kept out of the text rules
		// as well — "a line arrived with no line feed" names no transport and carries no
		// status, yet an earlier wording matched TRANSIENT_TRANSPORT_PATTERN's /terminated/
		// through the word "unterminated" and came back retryable.
		//
		// A named HTTP/2 refusal is the OTHER structural refusal and works differently on
		// purpose: it sets Flag.TransportRefused and leaves the description alone, because a
		// deadline that cancels its own stream still has to say it timed out. See flag.ts.
		const isFramingViolation =
			typeof link === "object" && (link as { name?: unknown }).name === STREAM_FRAME_LIMIT_ERROR_NAME;
		if (isFramingViolation) framingViolation = true;

		let linkMessage: string | undefined;
		if (isFramingViolation) {
			linkMessage = undefined;
		} else if (link instanceof Error) {
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

		const textId = classifyText(linkMessage, status(link), api, providerCode(link));
		kinds |= textId & KIND_MASK;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	// Cleared after the walk, not skipped during it: a wrapper's own prose is classified
	// before the cause carrying the breach is even reached.
	if (framingViolation) kinds &= ~Flag.Transient;

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
 * GitHub Copilot 400 `model_not_supported` routing flap — transient.
 *
 * It had its own copy of the rule, reading `code` and the SDK's nested `error.code` and nothing
 * else, while the classifier read the body text and nothing else. `Signal.code` carries the field
 * into the rules, so the rule is stated once in the network family and this is one reader of it: the
 * Copilot ladder needs the answer on its own to pick a backoff, which is why the accessor stays.
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (status(error) !== 400) return false;
	const message = error instanceof Error ? error.message : "";
	return isCopilotModelNotSupported({ text: withoutStackTrace(message), code: providerCode(error) });
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

/**
 * A stream that ended before it said anything at all.
 *
 * This is the envelope shape of "nothing arrived", and it belongs to the same
 * class as a first-event stall rather than to the class of failures a server
 * answered with. That distinction is what the declared first-event budget is
 * allowed to end: another attempt against an endpoint that returned an empty
 * body cannot produce an event sooner than this one did, while a 429 the server
 * DID answer with keeps its own retry entitlement.
 */
export function isEmptyStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) &&
		STREAM_BEFORE_MESSAGE_START_PATTERN.test(error.message)
	);
}
