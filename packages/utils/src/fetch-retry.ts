import { STATUS_CODES } from "node:http";
import { scheduler } from "node:timers/promises";
import { cancellationError, isAbortError } from "./abortable";

const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const RETRY_AFTER_MS_TEXT_PATTERN = /retry-after-ms\s*[:=]?\s*(\d+(?:\.\d+)?)/i;
const RETRY_AFTER_SECONDS_TEXT_PATTERN = /retry-after\s*[:=]?\s*(\d+(?:\.\d+)?)/i;

export const ANTHROPIC_RESET_HEADERS: readonly { reset: string; remaining: string }[] = [
	{ reset: "anthropic-ratelimit-unified-reset", remaining: "anthropic-ratelimit-unified-remaining" },
	{ reset: "anthropic-ratelimit-requests-reset", remaining: "anthropic-ratelimit-requests-remaining" },
	{ reset: "anthropic-ratelimit-tokens-reset", remaining: "anthropic-ratelimit-tokens-remaining" },
	{ reset: "anthropic-ratelimit-input-tokens-reset", remaining: "anthropic-ratelimit-input-tokens-remaining" },
	{ reset: "anthropic-ratelimit-output-tokens-reset", remaining: "anthropic-ratelimit-output-tokens-remaining" },
];

const ANTHROPIC_RESET_MAX_HOLD_MS = 24 * 60 * 60 * 1000;

export function anthropicResetDelayMs(headers: Headers, nowMs: number = Date.now()): number | undefined {
	let exhaustedMs: number | undefined;
	let anyMs: number | undefined;
	for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
		const raw = headers.get(reset);
		if (!raw) continue;
		const atMs = parseResetClockMs(raw.trim());
		if (atMs === undefined) continue;
		const delta = atMs - nowMs;
		if (delta <= 0 || delta > ANTHROPIC_RESET_MAX_HOLD_MS) continue;
		if (anyMs === undefined || delta < anyMs) anyMs = delta;
		if (isExhaustedBucket(headers, remaining)) {
			if (exhaustedMs === undefined || delta > exhaustedMs) exhaustedMs = delta;
		}
	}
	return exhaustedMs ?? anyMs;
}

function parseResetClockMs(value: string): number | undefined {
	if (/^\d+$/.test(value)) {
		const seconds = Number(value);
		return Number.isFinite(seconds) ? seconds * 1000 : undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function isExhaustedBucket(headers: Headers, remainingHeader: string): boolean {
	const remaining = headers.get(remainingHeader);
	if (remaining !== null && Number(remaining.trim()) === 0) return true;
	if (remainingHeader !== "anthropic-ratelimit-unified-remaining") return false;
	return headers.get("anthropic-ratelimit-unified-status")?.trim().toLowerCase() === "rejected";
}

export const RESET_EPOCH_MS_MIN = 1e12;
export const RESET_EPOCH_S_MIN = 1e9;

export function resetHeaderTargetMs(value: number): { atMs: number } | { delta: true } {
	if (value > RESET_EPOCH_MS_MIN) return { atMs: value };
	if (value > RESET_EPOCH_S_MIN) return { atMs: value * 1000 };
	return { delta: true };
}

export function extractRetryHint(source: Response | Headers | null | undefined, body?: string): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	if (headers) {
		const retryAfterMs = headers.get("retry-after-ms");
		if (retryAfterMs) {
			const ms = Number(retryAfterMs);
			if (Number.isFinite(ms) && ms >= 0) return ms;
		}
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
			const parsedDate = Date.parse(retryAfter);
			if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
		}
		const rateLimitResetMs = headers.get("x-ratelimit-reset-ms");
		if (rateLimitResetMs) {
			const value = Number(rateLimitResetMs);
			if (Number.isFinite(value) && value > 0) {
				const target = resetHeaderTargetMs(value);
				if ("delta" in target) return value; // raw value is already a delta in ms
				const delta = target.atMs - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const value = Number.parseInt(rateLimitReset, 10);
			if (Number.isFinite(value) && value > 0) {
				const target = resetHeaderTargetMs(value);
				if ("delta" in target) return value * 1000; // header's own unit is seconds
				const delta = target.atMs - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const seconds = Number(rateLimitResetAfter);
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		}
		const anthropicMs = anthropicResetDelayMs(headers);
		if (anthropicMs !== undefined) return anthropicMs;
	}

	if (!body) return undefined;
	const retryAfterMsText = RETRY_AFTER_MS_TEXT_PATTERN.exec(body);
	if (retryAfterMsText) {
		const ms = Number.parseFloat(retryAfterMsText[1]!);
		if (Number.isFinite(ms) && ms > 0) return ms;
	}
	const retryAfterSecondsText = RETRY_AFTER_SECONDS_TEXT_PATTERN.exec(body);
	if (retryAfterSecondsText) {
		const seconds = Number.parseFloat(retryAfterSecondsText[1]!);
		if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	}

	const quotaMatch = QUOTA_RESET_PATTERN.exec(body);
	if (quotaMatch) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]!);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			if (totalMs > 0) return totalMs;
		}
	}
	for (const pattern of [PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
		const match = pattern.exec(body);
		if (match?.[1]) {
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]!);
				if (unitMs !== undefined) return value * unitMs;
			}
		}
	}
	return undefined;
}

function unitToMs(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 60 * 60_000;
		default:
			return undefined;
	}
}

export interface FetchWithRetryOptions extends RequestInit {
	maxAttempts?: number;
	maxDelayMs?: number;
	defaultDelayMs?: number | readonly number[] | ((attempt: number) => number);
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	shouldRetryResponse?: (response: Response, bodyText: string, attempt: number) => boolean | Promise<boolean>;
	shouldRetryError?: (error: Error, attempt: number) => boolean | Promise<boolean>;
	timeout?: number | false;
}

export const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export async function fetchWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const {
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		maxDelayMs = DEFAULT_MAX_DELAY_MS,
		defaultDelayMs,
		prepareInit,
		shouldRetryResponse,
		shouldRetryError,
		fetch: fetchImpl = fetch,
		timeout = false,
		...baseInit
	} = options;
	const signal = baseInit.signal as AbortSignal | undefined;

	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) throw cancellationError();
		const requestUrl = typeof url === "function" ? url(attempt) : url;
		const init = prepareInit
			? mergeInit(baseInit, await prepareInit(attempt), timeout)
			: "timeout" in options
				? ({ ...baseInit, timeout } as unknown as RequestInit)
				: baseInit;

		let response: Response;
		try {
			response = await fetchImpl(requestUrl, init);
		} catch (error) {
			if (signal?.aborted) throw cancellationError();
			const wrapped = wrapNetworkError(error);
			if (http2RetryVerdict(wrapped.message) === false) throw wrapped;
			if (attempt + 1 >= maxAttempts) throw wrapped;
			if (shouldRetryError && !(await shouldRetryError(wrapped, attempt))) throw wrapped;
			await scheduler.wait(resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), { signal });
			continue;
		}

		if (response.ok) return response;
		if (attempt + 1 >= maxAttempts) return response;

		const retryBody = await response.clone().text();
		const retry = shouldRetryResponse
			? await shouldRetryResponse(response, retryBody, attempt)
			: isRetryableStatus(response.status);
		if (!retry) return response;

		const hint = extractRetryHint(response, retryBody);
		if (hint !== undefined && hint > maxDelayMs) return response;

		const delayMs = Math.min(hint ?? resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), maxDelayMs);
		await scheduler.wait(delayMs, { signal });
	}
}

function mergeInit(base: RequestInit, overlay: RequestInit, timeout: number | false): RequestInit {
	const merged = { ...base, ...overlay, timeout } as unknown as RequestInit;
	if (base.headers || overlay.headers) {
		const baseHeaders = new Headers(base.headers ?? undefined);
		const overlayHeaders = new Headers(overlay.headers ?? undefined);
		overlayHeaders.forEach((value, key) => {
			baseHeaders.set(key, value);
		});
		merged.headers = baseHeaders;
	}
	return merged;
}

function wrapNetworkError(error: unknown): Error {
	if (error instanceof Error) {
		if (isAbortError(error) || error.message === "Request was aborted") {
			return cancellationError();
		}
		if (error.message === "fetch failed" && error.cause instanceof Error) {
			return new Error(`Network error: ${error.cause.message}`);
		}
		return error;
	}
	return new Error(String(error));
}

function resolveDefaultDelay(
	option: FetchWithRetryOptions["defaultDelayMs"],
	attempt: number,
	maxDelayMs: number,
): number {
	if (option === undefined) return Math.min(500 * 2 ** attempt, maxDelayMs);
	if (typeof option === "number") return Math.min(option, maxDelayMs);
	if (typeof option === "function") return Math.min(option(attempt), maxDelayMs);
	return Math.min(option[Math.min(attempt, option.length - 1)] ?? 0, maxDelayMs);
}

export function extractHttpStatusFromError(error: unknown): number | undefined {
	return structuredStatus(error, 0) ?? messageStatus(error, 0);
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function structuredStatus(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	const rawStatus = info.status ?? info.statusCode ?? info.response?.status;

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) status = parsed;
	}
	if (status !== undefined && status >= 100 && status <= 599) return status;
	return structuredStatus(info.cause, depth + 1);
}

function messageStatus(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	return messageStatus(info.cause, depth + 1);
}

const STATUS_MESSAGE_PATTERNS = [
	/^(\d{3})\s/,
	/\bstatus(?:_code)?\s*[:=]?\s*(\d{3})\b/i,
	/\bhttp\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
] as const;

const CODE_THEN_TEXT = /(?:^|\s)(\d{3})\s+/g;

function statusFromReasonPhrase(message: string): number | undefined {
	for (const match of message.matchAll(CODE_THEN_TEXT)) {
		const code = Number(match[1]);
		const phrase = STATUS_CODES[code];
		if (phrase === undefined) continue;
		const rest = message.slice(match.index + match[0].length);
		if (!rest.toLowerCase().startsWith(phrase.toLowerCase())) continue;
		const next = rest.charAt(phrase.length);
		if (next === "" || !/[A-Za-z0-9]/.test(next)) return code;
	}
	return undefined;
}

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return statusFromReasonPhrase(message);
}

export function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return /\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message);
}

const RETRYABLE_HTTP2_ERROR_CODES: ReadonlySet<string> = new Set([
	"NGHTTP2_NO_ERROR",
	"NGHTTP2_PROTOCOL_ERROR",
	"NGHTTP2_INTERNAL_ERROR",
	"NGHTTP2_SETTINGS_TIMEOUT",
	"NGHTTP2_STREAM_CLOSED",
	"NGHTTP2_REFUSED_STREAM",
	"NGHTTP2_CONNECT_ERROR",
	"NGHTTP2_ENHANCE_YOUR_CALM",
]);

const NON_RETRYABLE_HTTP2_ERROR_CODES: ReadonlySet<string> = new Set([
	"NGHTTP2_FLOW_CONTROL_ERROR",
	"NGHTTP2_FRAME_SIZE_ERROR",
	"NGHTTP2_CANCEL",
	"NGHTTP2_COMPRESSION_ERROR",
	"NGHTTP2_INADEQUATE_SECURITY",
	"NGHTTP2_HTTP_1_1_REQUIRED",
]);

const HTTP2_ERROR_CODE_PATTERN = /\b(?:stream|session) closed with error code:?\s+(NGHTTP2_[A-Z0-9_]+)/i;

const HTTP2_GOAWAY_PATTERN = /new streams cannot be created after receiving a goaway/i;

export function http2ErrorCode(message: string): string | undefined {
	const match = HTTP2_ERROR_CODE_PATTERN.exec(message);
	return match === null ? undefined : match[1].toUpperCase();
}

export function http2RetryVerdict(message: string): boolean | undefined {
	const code = http2ErrorCode(message);
	if (code !== undefined) {
		if (RETRYABLE_HTTP2_ERROR_CODES.has(code)) return true;
		if (NON_RETRYABLE_HTTP2_ERROR_CODES.has(code)) return false;
		return undefined;
	}
	return HTTP2_GOAWAY_PATTERN.test(message) ? true : undefined;
}
