import { readSseJson, type SseEventObserver } from "@veyyon/utils/stream";
import * as AIError from "../error";
import { OpenAIHttpError } from "../error";

export { OpenAIHttpError };

import type { FetchImpl } from "../types";
import { captureHttpErrorResponse } from "./http-inspector";
import { fetchProviderWithRetry } from "./provider-fetch";

const DEFAULT_MAX_ATTEMPTS = 6;

const MAX_DETAIL_CHARS = 4096;

export interface OpenAIStreamRequestInit {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	signal: AbortSignal;
	fetch?: FetchImpl;
	maxRetryDelayMs?: number;
	onSseEvent?: SseEventObserver;
}

export interface OpenAIStreamHandle<TEvent> {
	events: AsyncGenerator<TEvent>;
	response: Response;
	requestId: string | null;
}

export async function postOpenAIStream<TEvent>(init: OpenAIStreamRequestInit): Promise<OpenAIStreamHandle<TEvent>> {
	const response = await fetchProviderWithRetry(init.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...init.headers },
		body: JSON.stringify(init.body),
		signal: init.signal,
		fetch: init.fetch,
		prepareInit: init.prepareInit,
		maxAttempts: DEFAULT_MAX_ATTEMPTS,
		maxDelayMs: init.maxRetryDelayMs,
		timeout: false,
	});
	if (!response.ok) {
		throw await captureOpenAIHttpError(response);
	}
	if (!response.body) {
		throw new AIError.ProviderResponseError(`OpenAI stream response has no body (status ${response.status})`, {
			kind: "empty-body",
		});
	}
	return {
		events: readSseJson<TEvent>(response.body, init.signal, init.onSseEvent),
		response,
		requestId: response.headers.get("x-request-id"),
	};
}

export async function captureOpenAIHttpError(response: Response): Promise<AIError.OpenAIHttpError> {
	const captured = await captureHttpErrorResponse(response);
	const { detail, code } = OpenAIHttpError.parseEnvelope(captured.bodyJson, captured.bodyText);
	const message = detail
		? `${response.status} ${detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail}`
		: `${response.status} status code (no body)`;
	return new AIError.OpenAIHttpError(message, captured, code);
}
