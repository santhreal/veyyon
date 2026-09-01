import { describe, expect, it } from "bun:test";
import {
	AnthropicApiError,
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	AnthropicStreamEnvelopeError,
	AuthBrokerError,
	AuthBrokerStreamUnsupportedError,
	AuthGatewayError,
	BedrockApiError,
	CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX,
	CodexProviderStreamError,
	CodexWebSocketTransportError,
	CodexWhitespaceToolCallLoopError,
	GeminiCliApiError,
	GoogleApiError,
	OllamaApiError,
	OpenAIHttpError,
	ProviderHttpError,
	STREAM_ENVELOPE_ERROR_PREFIX,
} from "../src/error/classes";
import type { CapturedHttpErrorResponse } from "../src/utils/http-inspector";

describe("ProviderHttpError", () => {
	it("sets name, status, message", () => {
		const err = new ProviderHttpError("msg", 500);
		expect(err.name).toBe("ProviderHttpError");
		expect(err.status).toBe(500);
		expect(err.message).toBe("msg");
	});
	it("defaults headers and code to undefined", () => {
		const err = new ProviderHttpError("msg", 500);
		expect(err.headers).toBeUndefined();
		expect(err.code).toBeUndefined();
	});
	it("accepts headers and code", () => {
		const h = new Headers({ "x-foo": "bar" });
		const err = new ProviderHttpError("msg", 500, { headers: h, code: "ERR" });
		expect(err.headers).toBe(h);
		expect(err.code).toBe("ERR");
	});
	it("attaches cause when provided", () => {
		const cause = new Error("root");
		const err = new ProviderHttpError("msg", 500, { cause });
		expect(err.cause).toBe(cause);
	});
	it("does not attach cause when undefined", () => {
		const err = new ProviderHttpError("msg", 500, { cause: undefined });
		expect(err.cause).toBeUndefined();
	});
	it("is an Error", () => {
		expect(new ProviderHttpError("m", 500) instanceof Error).toBe(true);
	});
});

describe("OpenAIHttpError", () => {
	const captured: CapturedHttpErrorResponse = {
		status: 429,
		headers: new Headers(),
		bodyText: "rate limited",
		bodyJson: undefined,
	};
	it("sets name and captured", () => {
		const err = new OpenAIHttpError("msg", captured);
		expect(err.name).toBe("OpenAIHttpError");
		expect(err.captured).toBe(captured);
		expect(err.status).toBe(429);
	});
	it("accepts code and cause", () => {
		const cause = new Error("root");
		const err = new OpenAIHttpError("msg", captured, "RATE_LIMIT", cause);
		expect(err.code).toBe("RATE_LIMIT");
		expect(err.cause).toBe(cause);
	});
	it("is a ProviderHttpError", () => {
		expect(new OpenAIHttpError("m", captured) instanceof ProviderHttpError).toBe(true);
	});
	it("parseEnvelope extracts error.message and code", () => {
		const result = OpenAIHttpError.parseEnvelope({ error: { message: "failed", code: "ERR" } }, undefined);
		expect(result.detail).toBe("failed");
		expect(result.code).toBe("ERR");
	});
	it("parseEnvelope falls back to type for code", () => {
		const result = OpenAIHttpError.parseEnvelope({ error: { message: "failed", type: "ERR_TYPE" } }, undefined);
		expect(result.code).toBe("ERR_TYPE");
	});
	it("parseEnvelope extracts string error", () => {
		const result = OpenAIHttpError.parseEnvelope({ error: "string error" }, undefined);
		expect(result.detail).toBe("string error");
		expect(result.code).toBeUndefined();
	});
	it("parseEnvelope extracts top-level message", () => {
		const result = OpenAIHttpError.parseEnvelope({ message: "top msg" }, undefined);
		expect(result.detail).toBe("top msg");
	});
	it("parseEnvelope falls back to bodyText", () => {
		const result = OpenAIHttpError.parseEnvelope({ unrelated: true }, "fallback text");
		expect(result.detail).toBe("fallback text");
	});
	it("parseEnvelope falls back to bodyText for non-object", () => {
		const result = OpenAIHttpError.parseEnvelope("not object", "fallback");
		expect(result.detail).toBe("fallback");
	});
	it("parseEnvelope falls back to bodyText for empty error message", () => {
		const result = OpenAIHttpError.parseEnvelope({ error: { message: "" } }, "fallback");
		expect(result.detail).toBe("fallback");
	});
});

describe("AnthropicApiError", () => {
	it("sets name, status, requestId", () => {
		const h = new Headers({ "request-id": "req-123" });
		const err = new AnthropicApiError(429, "rate limited", h);
		expect(err.name).toBe("AnthropicApiError");
		expect(err.status).toBe(429);
		expect(err.requestId).toBe("req-123");
		expect(err.headers).toBe(h);
	});
	it("requestId is null when header missing", () => {
		const err = new AnthropicApiError(500, "err", new Headers());
		expect(err.requestId).toBeNull();
	});
	it("is a ProviderHttpError", () => {
		expect(new AnthropicApiError(500, "m", new Headers()) instanceof ProviderHttpError).toBe(true);
	});
});

describe("AnthropicConnectionError", () => {
	it("sets name and cause", () => {
		const cause = new Error("network");
		const err = new AnthropicConnectionError(cause);
		expect(err.name).toBe("AnthropicConnectionError");
		expect(err.message).toBe("Connection error.");
		expect(err.cause).toBe(cause);
	});
});

describe("AnthropicConnectionTimeoutError", () => {
	it("sets name and message", () => {
		const err = new AnthropicConnectionTimeoutError();
		expect(err.name).toBe("AnthropicConnectionTimeoutError");
		expect(err.message).toBe("Request timed out.");
	});
});

describe("AnthropicStreamEnvelopeError", () => {
	it("sets name and prefixed message", () => {
		const err = new AnthropicStreamEnvelopeError("bad envelope");
		expect(err.name).toBe("AnthropicStreamEnvelopeError");
		expect(err.message).toBe(`${STREAM_ENVELOPE_ERROR_PREFIX} bad envelope`);
	});
});

describe("STREAM_ENVELOPE_ERROR_PREFIX", () => {
	it("is a non-empty string", () => {
		expect(STREAM_ENVELOPE_ERROR_PREFIX.length).toBeGreaterThan(0);
	});
});

describe("BedrockApiError", () => {
	it("sets name", () => {
		const err = new BedrockApiError("msg", 500);
		expect(err.name).toBe("BedrockApiError");
		expect(err.status).toBe(500);
	});
	it("is a ProviderHttpError", () => {
		expect(new BedrockApiError("m", 500) instanceof ProviderHttpError).toBe(true);
	});
});

describe("GeminiCliApiError", () => {
	it("sets name", () => {
		expect(new GeminiCliApiError("m", 500).name).toBe("GeminiCliApiError");
	});
});

describe("GoogleApiError", () => {
	it("sets name", () => {
		expect(new GoogleApiError("m", 500).name).toBe("GoogleApiError");
	});
});

describe("OllamaApiError", () => {
	it("sets name", () => {
		expect(new OllamaApiError("m", 500).name).toBe("OllamaApiError");
	});
});

describe("AuthGatewayError", () => {
	it("sets name", () => {
		const err = new AuthGatewayError("msg", 401);
		expect(err.name).toBe("AuthGatewayError");
		expect(err.status).toBe(401);
	});
	it("accepts headers and code", () => {
		const h = new Headers();
		const err = new AuthGatewayError("msg", 401, h, "AUTH_FAILED");
		expect(err.headers).toBe(h);
		expect(err.code).toBe("AUTH_FAILED");
	});
	it("is a ProviderHttpError", () => {
		expect(new AuthGatewayError("m", 401) instanceof ProviderHttpError).toBe(true);
	});
});

describe("CodexWebSocketTransportError", () => {
	it("sets name and prefixed message", () => {
		const err = new CodexWebSocketTransportError("detail");
		expect(err.name).toBe("CodexWebSocketTransportError");
		expect(err.message).toBe(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: detail`);
	});
});

describe("CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX", () => {
	it("is non-empty", () => {
		expect(CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX.length).toBeGreaterThan(0);
	});
});

describe("CodexWhitespaceToolCallLoopError", () => {
	it("sets name and message", () => {
		const err = new CodexWhitespaceToolCallLoopError("loop detected");
		expect(err.name).toBe("CodexWhitespaceToolCallLoopError");
		expect(err.message).toBe("loop detected");
	});
});

describe("CodexProviderStreamError", () => {
	it("sets name, retryable, code", () => {
		const err = new CodexProviderStreamError("stream err", { retryable: true, code: "STREAM" });
		expect(err.name).toBe("CodexProviderStreamError");
		expect(err.retryable).toBe(true);
		expect(err.code).toBe("STREAM");
	});
	it("retryable false and code undefined by default", () => {
		const err = new CodexProviderStreamError("err", { retryable: false });
		expect(err.retryable).toBe(false);
		expect(err.code).toBeUndefined();
	});
	it("attaches cause", () => {
		const cause = new Error("root");
		const err = new CodexProviderStreamError("err", { retryable: false, cause });
		expect(err.cause).toBe(cause);
	});
});

describe("AuthBrokerError", () => {
	it("sets name and message", () => {
		const err = new AuthBrokerError("broker failed");
		expect(err.name).toBe("AuthBrokerError");
		expect(err.message).toBe("broker failed");
	});
	it("defaults status and body to undefined", () => {
		const err = new AuthBrokerError("msg");
		expect(err.status).toBeUndefined();
		expect(err.body).toBeUndefined();
	});
	it("accepts status, body, cause", () => {
		const cause = new Error("root");
		const err = new AuthBrokerError("msg", { status: 502, body: "body text", cause });
		expect(err.status).toBe(502);
		expect(err.body).toBe("body text");
		expect(err.cause).toBe(cause);
	});
});

describe("AuthBrokerStreamUnsupportedError", () => {
	it("sets name and default message", () => {
		const err = new AuthBrokerStreamUnsupportedError();
		expect(err.name).toBe("AuthBrokerStreamUnsupportedError");
		expect(err.message).toContain("snapshot/stream");
		expect(err.status).toBe(404);
	});
	it("accepts custom message", () => {
		const err = new AuthBrokerStreamUnsupportedError("custom");
		expect(err.message).toBe("custom");
	});
	it("is an AuthBrokerError", () => {
		expect(new AuthBrokerStreamUnsupportedError() instanceof AuthBrokerError).toBe(true);
	});
});
