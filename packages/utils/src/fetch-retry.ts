import { scheduler } from "node:timers/promises";
import { isAbortError } from "./abortable";

// "reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// JSON field: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// "try again in 250ms" / "try again in 12s" / "try again in 12sec" /
// "try again in 5 min" / "try again in ~158 min." / "try again in 2h" /
// "try again in 90 minutes" / "try again in 1 hour"
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
/**
 * `retry-after-ms=62000` / `retry-after-ms: 62000`. This is the spelling this
 * codebase's OWN formatter appends to a provider error message when the
 * response carried a `retry-after` header, and until it was listed here the
 * text-only callers of {@link extractRetryHint} — the auth gateway passes
 * `extractRetryHint(undefined, message)` with no headers left to read — could
 * not see the very hint we had just written for them, and fell back to a flat
 * default block that returned an exhausted account to the pool early.
 */
const RETRY_AFTER_MS_TEXT_PATTERN = /retry-after-ms\s*[:=]?\s*(\d+(?:\.\d+)?)/i;
/**
 * `retry-after: 60` / `retry-after 60`, in seconds. Providers that answer over
 * a transport with no headers (Connect trailers, some proxies) write the value
 * into the prose instead. The `-ms` spelling is matched first, and cannot match
 * here: `-` is neither a separator nor a digit.
 */
const RETRY_AFTER_SECONDS_TEXT_PATTERN = /retry-after\s*[:=]?\s*(\d+(?:\.\d+)?)/i;

/**
 * Anthropic's per-bucket rate-limit reset clocks, each an RFC 3339 timestamp
 * (`anthropic-ratelimit-unified-reset` may also arrive as epoch seconds).
 *
 * Anthropic omits `retry-after` on a meaningful share of its 429s, and those
 * responses still say exactly when the exhausted bucket refills. Without these
 * the caller has no stated window at all and falls back to a sub-10s
 * exponential backoff against a limit measured in minutes, which is the
 * immediate-repeat signature that dominates the error telemetry.
 *
 * Each entry names the reset clock and the sibling header that says whether
 * THAT bucket is the exhausted one, so a 60-second request bucket is not
 * mistaken for a multi-hour unified window or the other way round.
 */
export const ANTHROPIC_RESET_HEADERS: readonly { reset: string; remaining: string }[] = [
	{ reset: "anthropic-ratelimit-unified-reset", remaining: "anthropic-ratelimit-unified-remaining" },
	{ reset: "anthropic-ratelimit-requests-reset", remaining: "anthropic-ratelimit-requests-remaining" },
	{ reset: "anthropic-ratelimit-tokens-reset", remaining: "anthropic-ratelimit-tokens-remaining" },
	{ reset: "anthropic-ratelimit-input-tokens-reset", remaining: "anthropic-ratelimit-input-tokens-remaining" },
	{ reset: "anthropic-ratelimit-output-tokens-reset", remaining: "anthropic-ratelimit-output-tokens-remaining" },
];

/**
 * Upper bound on a window derived from {@link ANTHROPIC_RESET_HEADERS}. A reset
 * clock is provider-controlled data, and a skewed or malformed one must not be
 * able to translate into an unbounded stand-down. Anything past this is treated
 * as absent, so the caller keeps its own backoff instead of inheriting garbage.
 */
const ANTHROPIC_RESET_MAX_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The delay implied by Anthropic's rate-limit reset clocks, or `undefined` when
 * none are present, parseable, and in the future.
 *
 * Buckets whose `-remaining` sibling reads `0` are the ones that actually
 * rejected the request, so when any of those is present the LONGEST of them
 * wins: retrying while the bucket that failed is still empty fails again. With
 * no `-remaining` evidence at all we cannot tell which bucket rejected, so the
 * SHORTEST reset wins — under-waiting costs one more retry, while over-waiting
 * on a guess strands the caller behind a window that may not even apply.
 */
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

/** An RFC 3339 timestamp, or a bare Unix epoch in seconds. */
function parseResetClockMs(value: string): number | undefined {
	if (/^\d+$/.test(value)) {
		const seconds = Number(value);
		return Number.isFinite(seconds) ? seconds * 1000 : undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Whether the bucket behind `remainingHeader` is the one that rejected. The
 * unified bucket also reports a `-status`, and `rejected` is the direct
 * statement of the same fact.
 */
function isExhaustedBucket(headers: Headers, remainingHeader: string): boolean {
	const remaining = headers.get(remainingHeader);
	if (remaining !== null && Number(remaining.trim()) === 0) return true;
	if (remainingHeader !== "anthropic-ratelimit-unified-remaining") return false;
	return headers.get("anthropic-ratelimit-unified-status")?.trim().toLowerCase() === "rejected";
}

/**
 * A rate-limit `reset` header value at or above this is a Unix epoch already in
 * milliseconds (present-day ms epochs are ~1.7e12), never a wait delta.
 */
export const RESET_EPOCH_MS_MIN = 1e12;
/**
 * A `reset` value at or above this (but below {@link RESET_EPOCH_MS_MIN}) is a
 * Unix epoch in seconds (present-day second epochs are ~1.7e9); anything below
 * is a plain delta in the header's own unit.
 */
export const RESET_EPOCH_S_MIN = 1e9;

/**
 * Disambiguate the three shapes a single rate-limit `reset` numeric field
 * conflates (a Unix epoch in ms, a Unix epoch in seconds, or a plain wait
 * delta) by magnitude, since a present-day epoch dwarfs any sane delta.
 * Returns the absolute target instant in ms for the two epoch shapes, or
 * `{ delta: true }` so the caller applies the header's own unit to the raw
 * value. Owns the epoch/delta thresholds for every `reset`-header parser.
 */
export function resetHeaderTargetMs(value: number): { atMs: number } | { delta: true } {
	if (value > RESET_EPOCH_MS_MIN) return { atMs: value };
	if (value > RESET_EPOCH_S_MIN) return { atMs: value * 1000 };
	return { delta: true };
}

/**
 * Server-suggested retry delay extraction. Merges the patterns historically used
 * by the OpenAI Codex and Google Gemini retry helpers.
 *
 * Header sources (checked in order):
 *  - `retry-after-ms` (milliseconds)
 *  - `Retry-After` (numeric seconds, or HTTP date)
 *  - `x-ratelimit-reset-ms` (delta ms, or Unix epoch ms/s for large values)
 *  - `x-ratelimit-reset` (Unix epoch seconds)
 *  - `x-ratelimit-reset-after` (seconds)
 *  - `anthropic-ratelimit-*-reset` (see {@link anthropicResetDelayMs})
 *
 * Body patterns:
 *  - `retry-after-ms=62000` / `retry-after-ms: 62000` (milliseconds)
 *  - `retry-after: 60` / `retry-after 60` (seconds)
 *  - `Your quota will reset after 18h31m10s` / `10m15s` / `39s`
 *  - `Please retry in 250ms` / `Please retry in 12s`
 *  - `"retryDelay": "34.074824224s"` (JSON error detail field)
 *  - `try again in 250ms` / `try again in 12s` / `try again in 5 min` / `try again in ~158 min`
 *
 * Returns `undefined` if no signal is found.
 */
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
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delta = resetSeconds * 1000 - Date.now();
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
	/** Total fetch attempts (initial + retries). Default `5`. */
	maxAttempts?: number;
	/**
	 * Per-delay cap. Server-provided `Retry-After` hints exceeding this return
	 * the current response immediately — caller deals with the `!response.ok`.
	 * Default `60_000`.
	 */
	maxDelayMs?: number;
	/**
	 * Fallback delay schedule when no server hint is present. Number, array
	 * (indexed by attempt, clamped to last), or function. Default exponential
	 * `500ms * 2 ** attempt` capped at `maxDelayMs`.
	 */
	defaultDelayMs?: number | readonly number[] | ((attempt: number) => number);
	/**
	 * Optional per-attempt overlay merged into the base `RequestInit` each try.
	 * Headers from the overlay shallow-merge over the base. Useful for auth
	 * token refresh or user-agent rotation.
	 */
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	/**
	 * Optional `fetch` implementation override. Defaults to `globalThis.fetch`.
	 * Useful for routing requests through a proxy, instrumented transport, or
	 * mock during tests.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/**
	 * Optional retry gate for HTTP responses whose status is retryable. Receives a
	 * cloned body string so callers can fail fast on deterministic provider
	 * failures that happen to use a 5xx status.
	 */
	shouldRetryResponse?: (response: Response, bodyText: string, attempt: number) => boolean | Promise<boolean>;
	/**
	 * Bun extension forwarded verbatim to the underlying `fetch` call. `false`
	 * disables Bun's native ~300s pre-response timeout (callers that own a
	 * configurable first-event/idle watchdog or an external `AbortSignal`
	 * supply this so the runtime ceiling cannot pre-empt them); a positive
	 * number sets a custom ceiling in ms. Bare browser/Node fetch ignores it.
	 */
	timeout?: number | false;
}

const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Fetch with bounded retries and sensible defaults. Retries on any
 * `isRetryableStatus` (5xx, 408, 429) and on transient network errors. Server
 * `Retry-After`/quota hints are honoured up to `maxDelayMs`; a hint that exceeds
 * the cap returns the current response so the caller can fail fast. Aborts on
 * `init.signal` propagate as `"Request was aborted"`.
 *
 * The caller is responsible for inspecting `!response.ok` once the call returns.
 */
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
		fetch: fetchImpl = fetch,
		timeout = false,
		...baseInit
	} = options;
	const signal = baseInit.signal as AbortSignal | undefined;

	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted");
		const requestUrl = typeof url === "function" ? url(attempt) : url;
		// `timeout` is destructured out of `baseInit`, so forward it to the underlying
		// fetch on the no-`prepareInit` path too. Without this, callers that pass
		// `timeout: false` (every streaming provider, to disable Bun's native ~300s
		// fetch ceiling in favor of their own first-event/idle watchdog) had it
		// silently dropped, so long-running streams were killed at ~300s (issue #602).
		// Only forward when the caller actually set `timeout`, so callers that never
		// set it keep Bun's default ceiling.
		const init = prepareInit
			? mergeInit(baseInit, await prepareInit(attempt), timeout)
			: "timeout" in options
				? ({ ...baseInit, timeout } as unknown as RequestInit)
				: baseInit;

		let response: Response;
		try {
			response = await fetchImpl(requestUrl, init);
		} catch (error) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const wrapped = wrapNetworkError(error);
			// A named HTTP/2 code this module has already ruled deterministic
			// (`NON_RETRYABLE_HTTP2_ERROR_CODES`) fails the same way on every replay,
			// and each replay re-sends the whole request body. `NGHTTP2_CANCEL` is the
			// expensive one: it is usually our own abort arriving through a per-attempt
			// signal the loop cannot see on `signal`, so the request was re-sent in
			// full four more times to reach the same answer.
			if (http2RetryVerdict(wrapped.message) === false) throw wrapped;
			if (attempt + 1 >= maxAttempts) throw wrapped;
			await scheduler.wait(resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), { signal });
			continue;
		}

		if (!isRetryableStatus(response.status)) return response;
		if (attempt + 1 >= maxAttempts) return response;

		const retryBody = await response.clone().text();
		if (shouldRetryResponse && !(await shouldRetryResponse(response, retryBody, attempt))) return response;

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
			return new Error("Request was aborted");
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

/**
 * Inspect an arbitrary error value (or its `cause` chain, up to depth 2) for an
 * HTTP status code. Reads `status`, `statusCode`, and `response.status` fields,
 * coerces string values, and falls back to scanning the error message for
 * common patterns like `Error: 401`, `error (429)`, or `HTTP 503`.
 */
export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
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

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	if (info.cause) return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	return undefined;
}

const STATUS_MESSAGE_PATTERNS = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
] as const;

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

/**
 * `true` if the given HTTP status code is one we treat as transient: 408
 * (Request Timeout), 429 (Too Many Requests), or any 5xx (server error).
 */
export function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * `true` if the message describes an unexpected socket closure — Bun and some
 * proxies surface these for any HTTP/2 stream reset.
 */
export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return /\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message);
}

/**
 * HTTP/2 error codes (RFC 7540 section 7) whose meaning is "the transport or
 * the peer failed", not "the request you sent is wrong". A fresh stream, and in
 * most cases a fresh connection, has a real chance of succeeding.
 *
 * Two of these carry their own argument:
 *
 * - `REFUSED_STREAM` is the only code the RFC gives a normative replay
 *   guarantee. Section 8.1.4 says the stream closed "prior to any processing
 *   having occurred" and that the request "can be safely retried".
 * - `NO_ERROR` on a stream that was still in flight is a graceful GOAWAY, which
 *   is what a peer rolling out a deploy looks like from here. It is the most
 *   common real-world member of this set.
 *
 * `PROTOCOL_ERROR` is the loosest inclusion: it can in principle mean our own
 * framing is wrong, in which case a replay reproduces it. In practice it is an
 * intermediary hiccup, and the bounded attempt count caps the cost of being
 * wrong about it.
 */
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

/**
 * HTTP/2 error codes where the next attempt fails the same way, so retrying
 * only hides the real answer behind a loop.
 *
 * `CANCEL` is the one to be careful about: it usually means our own side
 * aborted the stream, and retrying a user-initiated cancel is a bug, not a
 * recovery. `FLOW_CONTROL_ERROR`, `FRAME_SIZE_ERROR` and `COMPRESSION_ERROR`
 * are protocol defects a replay reproduces. `INADEQUATE_SECURITY` and
 * `HTTP_1_1_REQUIRED` are configuration answers: the fix is a different TLS
 * profile or a protocol downgrade, never another identical attempt.
 */
const NON_RETRYABLE_HTTP2_ERROR_CODES: ReadonlySet<string> = new Set([
	"NGHTTP2_FLOW_CONTROL_ERROR",
	"NGHTTP2_FRAME_SIZE_ERROR",
	"NGHTTP2_CANCEL",
	"NGHTTP2_COMPRESSION_ERROR",
	"NGHTTP2_INADEQUATE_SECURITY",
	"NGHTTP2_HTTP_1_1_REQUIRED",
]);

/**
 * Node spells an HTTP/2 failure as `Stream closed with error code
 * NGHTTP2_INTERNAL_ERROR` (`ERR_HTTP2_STREAM_ERROR`) or `Session closed with
 * error code ...` (`ERR_HTTP2_SESSION_ERROR`). The optional colon absorbs
 * wrappers that reformat the code onto the phrase.
 */
const HTTP2_ERROR_CODE_PATTERN = /\b(?:stream|session) closed with error code:?\s+(NGHTTP2_[A-Z0-9_]+)/i;

/**
 * `New streams cannot be created after receiving a GOAWAY`
 * (`ERR_HTTP2_GOAWAY_SESSION`). The stream never existed, so nothing was
 * processed and a replay on a new connection is unambiguously safe.
 */
const HTTP2_GOAWAY_PATTERN = /new streams cannot be created after receiving a goaway/i;

/** The `NGHTTP2_*` code named by a Node HTTP/2 stream or session error message. */
export function http2ErrorCode(message: string): string | undefined {
	const match = HTTP2_ERROR_CODE_PATTERN.exec(message);
	return match === null ? undefined : match[1].toUpperCase();
}

/**
 * Retry verdict for an HTTP/2 transport failure, or `undefined` when the
 * message names no code we recognise.
 *
 * A named code is a definite statement about whether another attempt can
 * differ, so callers should let it win over generic wording heuristics: those
 * read `NGHTTP2_INTERNAL_ERROR` as the phrase "internal error" they happen to
 * know and would just as happily read a transient-sounding wrapper around
 * `NGHTTP2_CANCEL`. An unknown code returns `undefined` rather than a guess, so
 * a future code still reaches the existing heuristics.
 */
export function http2RetryVerdict(message: string): boolean | undefined {
	const code = http2ErrorCode(message);
	if (code !== undefined) {
		if (RETRYABLE_HTTP2_ERROR_CODES.has(code)) return true;
		if (NON_RETRYABLE_HTTP2_ERROR_CODES.has(code)) return false;
		return undefined;
	}
	return HTTP2_GOAWAY_PATTERN.test(message) ? true : undefined;
}

const TRANSIENT_MESSAGE_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|network error|stream stall|other side closed|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;

const VALIDATION_MESSAGE_PATTERN =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/**
 * Identify errors that should be retried: aborts/timeouts in the error name or
 * message, retryable HTTP statuses (see `isRetryableStatus`), unexpected socket
 * closes, and the standard transient phrases. 4xx statuses other than 408/429
 * and validation-shaped messages short-circuit to `false`.
 *
 * A named HTTP/2 error code (see {@link http2RetryVerdict}) answers first,
 * because it is a fact about the transport rather than an inference from
 * wording.
 */
export function isRetryableError(error: unknown): boolean {
	const info = error as { message?: string; name?: string } | null;
	const message = info?.message ?? "";
	const http2Verdict = http2RetryVerdict(message);
	if (http2Verdict !== undefined) return http2Verdict;
	if (isAbortError(error) || /timeout|timed out|aborted/i.test(message)) return true;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		if (isRetryableStatus(status)) return true;
		if (status >= 400 && status < 500) return false;
	}

	if (VALIDATION_MESSAGE_PATTERN.test(message)) return false;
	return isUnexpectedSocketCloseMessage(message) || TRANSIENT_MESSAGE_PATTERN.test(message);
}
