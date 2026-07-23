import { resetHeaderTargetMs } from "@veyyon/utils";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

const RETRY_AFTER_HINT = "retry-after-ms=";

export function formatErrorMessageWithRetryAfter(error: unknown, headers?: HeadersLike): string {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	if (message.includes(RETRY_AFTER_HINT)) {
		return message;
	}

	const retryAfterMs = getRetryAfterMsFromHeaders(headers ?? getHeadersFromError(error));
	if (retryAfterMs === undefined) {
		return message;
	}

	return `${message} ${RETRY_AFTER_HINT}${retryAfterMs}`;
}

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;

	const retryAfterMs = parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms"));
	const retryAfter = parseRetryAfterHeader(getHeaderValue(headers, "retry-after"));
	const resetMs = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms");
	const resetSeconds = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s");

	const candidates = [retryAfterMs, retryAfter, resetMs, resetSeconds].filter(
		(value): value is number => value !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
}

export function getHeadersFromError(error: unknown): HeadersLike {
	if (!error || typeof error !== "object") return undefined;
	const record = error as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
	const direct = extractHeaders(record.headers) ?? extractHeaders(record.response?.headers);
	if (direct) return direct;
	if (record.cause) return getHeadersFromError(record.cause);
	return undefined;
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (typeof value === "object") return value as Record<string, string | undefined>;
	return undefined;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
	if (headers instanceof Headers) {
		const value = headers.get(name);
		return value ?? undefined;
	}

	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** `retry-after-ms` (Anthropic-style): a plain millisecond delta. */
function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Number(value.trim());
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.ceil(ms);
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric <= 0) return undefined;
		return Math.ceil(numeric * 1000);
	}

	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		const delay = dateMs - Date.now();
		return delay > 0 ? Math.ceil(delay) : undefined;
	}

	return undefined;
}

function parseResetHeader(value: string | undefined, unit: "ms" | "s"): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;

	const target = resetHeaderTargetMs(numeric);
	if ("delta" in target) {
		// Not a timestamp: the raw value is a wait in the header's own unit.
		return Math.ceil(unit === "ms" ? numeric : numeric * 1000);
	}
	const delta = target.atMs - Date.now();
	if (delta <= 0) return undefined;
	return Math.ceil(delta);
}
