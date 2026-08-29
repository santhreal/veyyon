import * as AIError from "../error";
import type { FetchImpl } from "../types";

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_RETRIES = 2;
export const INITIAL_RETRY_DELAY_S = 0.5;
export const MAX_RETRY_DELAY_S = 8;

export interface AnthropicRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
}

export type AnthropicFetchOptions = RequestInit & {
	tls?: {
		rejectUnauthorized?: boolean;
		serverName?: string;
		ciphers?: string;
		ca?: string | string[];
		cert?: string;
		key?: string;
	};
	timeout?: number | false;
};

export interface AnthropicClientOptions {
	apiKey?: string | null;
	authToken?: string | null;
	baseURL?: string | null;
	maxRetries?: number;
	timeout?: number;
	defaultHeaders?: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
}

export function createAbortError(): Error {
	return new AIError.RequestAbortError("Request was aborted.");
}

export const ANTHROPIC_RESPONSE_RETRY_POLICY: AIError.ResponseRetryPolicy = { api: "anthropic", alsoRetry: [409] };

export function retryDelayFromHeaders(headers: Headers | undefined): number | undefined {
	if (!headers) return undefined;
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const ms = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(ms) && ms >= 0) return ms;
	}
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const dateMs = Date.parse(retryAfter) - Date.now();
		if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
	}
	return undefined;
}

export function calculateAnthropicRetryDelayMs(attempt: number): number {
	const sleepSeconds = Math.min(INITIAL_RETRY_DELAY_S * 2 ** attempt, MAX_RETRY_DELAY_S);
	const jitter = 1 - Math.random() * 0.25;
	return sleepSeconds * jitter * 1000;
}

export function hasHeaderCaseInsensitive(headers: Record<string, string>, lowerName: string): boolean {
	for (const key in headers) {
		if (key.toLowerCase() === lowerName) return true;
	}
	return false;
}
