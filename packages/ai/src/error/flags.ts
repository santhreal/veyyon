import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";
import type { Api, AssistantMessage } from "../types";
import { STREAM_ENVELOPE_ERROR_PREFIX } from "./classes";
import { withoutStackTrace } from "./domains/account";
import {
	http2Verdict,
	isCopilotModelNotSupported,
	STREAM_BEFORE_MESSAGE_START_PATTERN,
	STREAM_EVENT_ORDER_PATTERN,
	STREAM_PARSE_TRUNCATION_PATTERN,
} from "./domains/network";
import { matchesOverflowText } from "./domains/request";
import type { Signal } from "./domains/types";
import { create, Flag, is, KIND_MASK, statusFromId } from "./flag";
import { classifyIdentity, classifySignal } from "./registry";

export { isDefinitiveOAuthFailure } from "./domains/account";
export {
	DEAD_SOCKET_ERRNOS,
	DEAD_SOCKET_PATTERN,
	DEAD_SOCKET_PHRASE_SOURCES,
	isStreamReadErrorText,
	isTransientErrorText,
	namesDeadSocket,
	STREAM_READ_ERROR_PATTERN,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./domains/network";
export { matchesCompiledGrammarTooLargeText, matchesStrictToolsRejectionText } from "./domains/request";
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
	vetoesRetry,
} from "./registry";

export const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

export function status(error: unknown): number | undefined {
	return extractHttpStatusFromError(error);
}

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
	trace?: string[],
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
		kinds = classifySignal(signal, trace);
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) {
		trace?.push("status-401-403");
		return create(Flag.AuthFailed);
	}
	return fallbackStatus ?? 0;
}

function classifyBareStatus(bare: number | undefined, api?: Api, trace?: string[]): number {
	if (bare === undefined) return 0;
	return classifySignal({ text: "", status: bare, api, http2: undefined, code: undefined }, trace);
}

function clearDeterministicTransient(
	kinds: number,
	latches: { framingViolation: boolean; llamaCppToolCallParse: boolean },
	trace?: string[],
): number {
	let cleared = kinds;
	if (latches.framingViolation) {
		trace?.push("framing-violation-clears-transient");
		cleared &= ~Flag.Transient;
	}
	if (latches.llamaCppToolCallParse) {
		trace?.push("llama-cpp-tool-call-parse-clears-transient");
		cleared &= ~Flag.Transient;
	}
	return cleared;
}

export function classify(error: unknown, api?: Api, trace?: string[]): number {
	let kinds = 0;
	let framingViolation = false;
	let llamaCppToolCallParse = false;
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

		kinds |= classifyIdentity(link, trace);

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

		if (linkMessage && LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(linkMessage)) llamaCppToolCallParse = true;

		const textId = classifyText(linkMessage, status(link), api, providerCode(link), trace);
		kinds |= textId & KIND_MASK;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	kinds = clearDeterministicTransient(kinds, { framingViolation, llamaCppToolCallParse }, trace);
	if (kinds === 0 && !carriesText(error)) kinds = classifyBareStatus(status(error), api, trace);

	return kinds !== 0 ? create(kinds) : (status(error) ?? 0);
}

export interface Explanation {
	readonly id: number;
	readonly rules: readonly string[];
}

export function explain(error: unknown, api?: Api): Explanation {
	const trace: string[] = [];
	const id = classify(error, api, trace);
	return { id, rules: Array.from(new Set(trace)) };
}

function carriesText(error: unknown): boolean {
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link === "string") return link.length > 0;
		if (typeof link !== "object") return false;
		if (seen.has(link)) return false;
		seen.add(link);
		const message = (link as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return true;
		link = "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}
	return false;
}

export function isUsageLimit(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.UsageLimit);
}

export function isGrammarError(error: unknown): boolean {
	return is(classify(error), Flag.Grammar);
}

export function isFastModeUnsupported(error: unknown): boolean {
	return is(classify(error), Flag.FastModeUnsupported);
}

export function isCopilotTransientModelError(error: unknown): boolean {
	if (status(error) !== 400) return false;
	const message = error instanceof Error ? error.message : "";
	return isCopilotModelNotSupported({ text: withoutStackTrace(message), code: providerCode(error) });
}

export function classifyMessage(
	message: {
		api?: Api;
		errorId?: number;
		errorMessage?: string;
		errorStatus?: number;
	},
	trace?: string[],
): number {
	const existingId = message.errorId;
	const currentStatus = message.errorStatus ?? statusFromId(existingId);
	const textId = classifyText(message.errorMessage, currentStatus, message.api, undefined, trace);

	let kinds = ((existingId ?? 0) | textId) & KIND_MASK;
	kinds = clearDeterministicTransient(
		kinds,
		{
			framingViolation: false,
			llamaCppToolCallParse: Boolean(
				message.errorMessage && LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message.errorMessage),
			),
		},
		trace,
	);
	if (kinds === 0 && !message.errorMessage) kinds = classifyBareStatus(currentStatus, message.api, trace);
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

export function isTransientStreamParseError(error: unknown): boolean {
	return error instanceof Error && STREAM_PARSE_TRUNCATION_PATTERN.test(error.message);
}

export function isStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) || STREAM_EVENT_ORDER_PATTERN.test(error.message))
	);
}

export function isEmptyStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) &&
		STREAM_BEFORE_MESSAGE_START_PATTERN.test(error.message)
	);
}
