import { scheduler } from "node:timers/promises";
import * as AIError from "../error";
import { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError } from "../error";

export { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError };

import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { DEFAULT_MAX_DELAY_MS } from "@veyyon/utils/fetch-retry";
import type { FetchImpl } from "../types";
import type { MessageCreateParamsStreaming } from "./anthropic-wire";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;

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

function createAbortError(): Error {
	return new AIError.RequestAbortError("Request was aborted.");
}

const ANTHROPIC_RESPONSE_RETRY_POLICY: AIError.ResponseRetryPolicy = { api: "anthropic", alsoRetry: [409] };

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

function hasHeaderCaseInsensitive(headers: Record<string, string>, lowerName: string): boolean {
	for (const key in headers) {
		if (key.toLowerCase() === lowerName) return true;
	}
	return false;
}

export class AnthropicApiRequest {
	#start: () => Promise<Response>;
	#response: Promise<Response> | undefined;

	constructor(start: () => Promise<Response>) {
		this.#start = start;
	}

	asResponse(): Promise<Response> {
		this.#response ??= this.#start();
		return this.#response;
	}
}

export class AnthropicMessages {
	#client: AnthropicMessagesClient;
	#path: string;

	constructor(client: AnthropicMessagesClient, path: string) {
		this.#client = client;
		this.#path = path;
	}

	create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return this.#client.request(this.#path, params, options);
	}
}

export interface AnthropicMessagesClientLike {
	messages: { create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): unknown };
	beta?: { messages: { create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): unknown } };
}

export class AnthropicMessagesClient implements AnthropicMessagesClientLike {
	readonly messages: AnthropicMessages;
	readonly beta: { readonly messages: AnthropicMessages };
	#options: AnthropicClientOptions;

	constructor(options: AnthropicClientOptions) {
		this.#options = options;
		this.messages = new AnthropicMessages(this, "/v1/messages");
		this.beta = { messages: new AnthropicMessages(this, "/v1/messages?beta=true") };
	}

	request(path: string, params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return new AnthropicApiRequest(() => this.#send(path, params, options));
	}

	#buildHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
		const opts = this.#options;
		const defaults = opts.defaultHeaders ?? {};
		const headers: Record<string, string> = {};
		if (opts.apiKey != null && !hasHeaderCaseInsensitive(defaults, "x-api-key")) {
			headers["X-Api-Key"] = opts.apiKey;
		}
		if (opts.authToken != null && !hasHeaderCaseInsensitive(defaults, "authorization")) {
			headers.Authorization = `Bearer ${opts.authToken}`;
		}
		Object.assign(headers, defaults);
		Object.assign(headers, requestHeaders);
		return headers;
	}

	async #send(
		path: string,
		params: MessageCreateParamsStreaming,
		options?: AnthropicRequestOptions,
	): Promise<Response> {
		const opts = this.#options;
		const fetchFn: FetchImpl = opts.fetch ?? fetch;
		const callerSignal = options?.signal;
		const timeoutMs = options?.timeout ?? opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxRetries = Math.max(0, options?.maxRetries ?? opts.maxRetries ?? DEFAULT_MAX_RETRIES);
		const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS;
		const url = `${opts.baseURL ?? ANTHROPIC_API_ENDPOINT}${path}`;
		const headers = this.#buildHeaders(options?.headers);
		const body = JSON.stringify(params);

		for (let attempt = 0; ; attempt++) {
			if (callerSignal?.aborted) throw createAbortError();

			let response: Response;
			try {
				response = await this.#fetchOnce(fetchFn, url, headers, body, timeoutMs, callerSignal);
			} catch (error) {
				if (callerSignal?.aborted) throw createAbortError();
				if (attempt < maxRetries) {
					await this.#backoff(attempt, undefined, callerSignal);
					continue;
				}
				if (error instanceof AIError.AnthropicConnectionTimeoutError) throw error;
				throw new AIError.AnthropicConnectionError(error);
			}

			if (response.ok) return response;

			if (
				attempt < maxRetries &&
				(await AIError.retryResponseAfterReading(response, ANTHROPIC_RESPONSE_RETRY_POLICY))
			) {
				// A hint longer than the caller will wait is an answer, not a delay:
				// the wait was taken verbatim, so a `retry-after` measured in hours
				// held the request for hours with nothing armed to interrupt it.
				// Surfacing the refusal is what `fetchWithRetry` does with the same
				// header, and the status is what tells the operator to wait.
				const hintedMs = retryDelayFromHeaders(response.headers);
				if (hintedMs === undefined || hintedMs <= maxRetryDelayMs) {
					// that refuses to cancel -- usually because it already ended -- changes nothing about it.
					await response.body?.cancel().catch(() => {});
					await this.#backoff(attempt, response.headers, callerSignal);
					continue;
				}
			}
			throw await AIError.AnthropicApiError.fromResponse(response);
		}
	}

	async #fetchOnce(
		fetchFn: FetchImpl,
		url: string,
		headers: Record<string, string>,
		body: string,
		timeoutMs: number,
		callerSignal: AbortSignal | undefined,
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await fetchFn(url, {
				...(this.#options.fetchOptions ?? {}),
				method: "POST",
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut && !callerSignal?.aborted) throw new AIError.AnthropicConnectionTimeoutError();
			throw error;
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		}
	}

	async #backoff(
		attempt: number,
		responseHeaders: Headers | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const delayMs = retryDelayFromHeaders(responseHeaders) ?? calculateAnthropicRetryDelayMs(attempt);
		try {
			await scheduler.wait(delayMs, { signal });
		} catch {
			throw createAbortError();
		}
	}
}
