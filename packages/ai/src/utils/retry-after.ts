import { resetHeaderTargetMs } from "@veyyon/utils/fetch-retry";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

const RETRY_AFTER_HINT = "retry-after-ms=";

export function formatErrorMessageWithRetryAfter(error: unknown, headers?: HeadersLike): string {
	let message: string;
	if (error instanceof Error) {
		message = error.message;
	} else {
		try {
			message = JSON.stringify(error) ?? String(error);
		} catch {
			try {
				message = String(error);
			} catch {
				message = "Unknown error";
			}
		}
	}
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

	try {
		const retryAfterMs = parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms"));
		const retryAfter = parseRetryAfterHeader(getHeaderValue(headers, "retry-after"));
		const resetMs = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms");
		const resetSeconds = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s");

		const candidates = [retryAfterMs, retryAfter, resetMs, resetSeconds].filter(
			(value): value is number => value !== undefined,
		);
		if (candidates.length === 0) return undefined;
		return Math.max(...candidates);
	} catch {
		// Header bags are provider-controlled and occasionally Proxy-backed. A
		// malformed bag must not replace the request error we are formatting.
		return undefined;
	}
}

export function getHeadersFromError(error: unknown): HeadersLike {
	const seen = new Set<object>();
	let current = error;
	while (current !== null && typeof current === "object") {
		if (seen.has(current)) return undefined;
		seen.add(current);
		try {
			const direct = ("headers" in current ? extractHeaders(current.headers) : undefined) ?? responseHeaders(current);
			if (direct) return direct;
			current = "cause" in current ? current.cause : undefined;
		} catch {
			// Exotic errors can expose throwing getters or Proxy traps. Header
			// discovery is advisory and must never mask the original failure.
			return undefined;
		}
	}
	return undefined;
}

function responseHeaders(value: object): HeadersLike {
	if (!("response" in value)) return undefined;
	const response = value.response;
	if (response === null || typeof response !== "object" || !("headers" in response)) return undefined;
	return extractHeaders(response.headers);
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (!isHeaderRecord(value)) return undefined;
	return value;
}

function isHeaderRecord(value: unknown): value is Record<string, string | undefined> {
	if (value === null || typeof value !== "object") return false;
	return Object.values(value).every(entry => entry === undefined || typeof entry === "string");
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
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	return Math.ceil(ms);
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric < 0) return undefined;
		return Math.ceil(numeric * 1000);
	}

	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		return Math.max(0, Math.ceil(dateMs - Date.now()));
	}

	return undefined;
}

function parseResetHeader(value: string | undefined, unit: "ms" | "s"): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return undefined;

	const target = resetHeaderTargetMs(numeric);
	if ("delta" in target) {
		// Not a timestamp: the raw value is a wait in the header's own unit.
		return Math.ceil(unit === "ms" ? numeric : numeric * 1000);
	}
	return Math.max(0, Math.ceil(target.atMs - Date.now()));
}
