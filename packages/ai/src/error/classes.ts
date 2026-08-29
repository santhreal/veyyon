import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import type { ProviderHttpErrorOptions } from "./classes-helpers";

import { STREAM_ENVELOPE_ERROR_PREFIX } from "./classes-helpers";
import { readProviderErrorBody } from "./error-body";

export { STREAM_ENVELOPE_ERROR_PREFIX };

export class ProviderHttpError extends Error {
	readonly status: number;
	readonly headers: Headers | undefined;
	readonly code: string | undefined;

	constructor(message: string, status: number, options?: ProviderHttpErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderHttpError";
		this.status = status;
		this.headers = options?.headers;
		this.code = options?.code;
	}
}

export class OpenAIHttpError extends ProviderHttpError {
	readonly captured: CapturedHttpErrorResponse;

	constructor(message: string, captured: CapturedHttpErrorResponse, code?: string, cause?: unknown) {
		super(message, captured.status, { headers: captured.headers, code, cause });
		this.name = "OpenAIHttpError";
		this.captured = captured;
	}

	static parseEnvelope(
		bodyJson: unknown,
		bodyText: string | undefined,
	): { detail: string | undefined; code: string | undefined } {
		if (typeof bodyJson === "object" && bodyJson !== null) {
			const envelope = bodyJson as { error?: unknown; message?: unknown };
			const error = envelope.error;
			if (typeof error === "object" && error !== null) {
				const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
				return {
					detail: typeof message === "string" && message.length > 0 ? message : bodyText,
					code: typeof code === "string" ? code : typeof type === "string" ? type : undefined,
				};
			}
			if (typeof error === "string" && error.length > 0) {
				return { detail: error, code: undefined };
			}
			if (typeof envelope.message === "string" && envelope.message.length > 0) {
				return { detail: envelope.message, code: undefined };
			}
		}
		return { detail: bodyText, code: undefined };
	}
}

export class AnthropicApiError extends ProviderHttpError {
	declare readonly headers: Headers;
	readonly requestId: string | null;

	constructor(status: number, message: string, headers: Headers) {
		super(message, status, { headers });
		this.name = "AnthropicApiError";
		this.requestId = headers.get("request-id");
	}

	static async fromResponse(response: Response): Promise<AnthropicApiError> {
		const body = await readProviderErrorBody(response);
		const detail = body.text.trim().length === 0 ? "status code (no body)" : body.detail;
		return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers);
	}
}

export class AnthropicConnectionError extends Error {
	constructor(cause: unknown) {
		super("Connection error.", { cause });
		this.name = "AnthropicConnectionError";
	}
}

export class AnthropicConnectionTimeoutError extends Error {
	constructor() {
		super("Request timed out.");
		this.name = "AnthropicConnectionTimeoutError";
	}
}

export class AnthropicStreamEnvelopeError extends Error {
	constructor(detail: string) {
		super(`${STREAM_ENVELOPE_ERROR_PREFIX} ${detail}`);
		this.name = "AnthropicStreamEnvelopeError";
	}
}

export class BedrockApiError extends ProviderHttpError {
	override readonly name = "BedrockApiError";
}

export class GeminiCliApiError extends ProviderHttpError {
	override readonly name = "GeminiCliApiError";
}

export class GoogleApiError extends ProviderHttpError {
	override readonly name = "GoogleApiError";
}

export class OllamaApiError extends ProviderHttpError {
	override readonly name = "OllamaApiError";
}

export class AuthGatewayError extends ProviderHttpError {
	constructor(message: string, status: number, headers?: Headers, code?: string) {
		super(message, status, { headers, code });
		this.name = "AuthGatewayError";
	}
}

export const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string) {
		super(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${detail}`);
		this.name = "CodexWebSocketTransportError";
	}
}

export class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

export class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code: string | undefined;

	constructor(message: string, options: { retryable: boolean; code?: string; cause?: unknown }) {
		super(message, { cause: options.cause });
		this.name = "CodexProviderStreamError";
		this.retryable = options.retryable;
		this.code = options.code;
	}
}

export class AuthBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "AuthBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

export class AuthBrokerStreamUnsupportedError extends AuthBrokerError {
	constructor(message = "Auth broker does not support /v1/snapshot/stream") {
		super(message, { status: 404 });
		this.name = "AuthBrokerStreamUnsupportedError";
	}
}
