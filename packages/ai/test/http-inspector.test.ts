import { describe, expect, it } from "bun:test";
import {
	buildHttp400DumpPayload,
	captureHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	shouldDumpRejectedRequest,
} from "@veyyon/ai/utils/http-inspector";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const dump: RawHttpRequestDump = {
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-opus-4-8",
	method: "POST",
	url: "https://api.anthropic.com/v1/messages",
	headers: { "x-api-key": "secret-key", "content-type": "application/json" },
	body: { messages: [{ role: "user", content: "hi" }] },
};

describe("buildHttp400DumpPayload", () => {
	it("keeps request fields top-level and records the provider error response", () => {
		const message = "400 image exceeds 5 MB limit";
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, message), message);

		expect(payload.provider).toBe("anthropic");
		expect(payload.url).toBe("https://api.anthropic.com/v1/messages");
		expect(payload.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
		expect(payload.errorResponse).toEqual({ status: 400, message });
	});

	it("records the same message-derived status that enables dumping", () => {
		const message = "400 Bad Request: image exceeds 5 MB limit";
		const error = new Error(message);

		expect(shouldDumpRejectedRequest(error)).toBe(true);
		expect(buildHttp400DumpPayload(dump, error, message).errorResponse).toEqual({ status: 400, message });
	});

	it("redacts sensitive request headers while keeping the rest", () => {
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});
});

describe("shouldDumpRejectedRequest", () => {
	it("captures request-content rejections (400 bad request, 413 payload too large)", () => {
		expect(shouldDumpRejectedRequest(new HttpError(400, "bad request"))).toBe(true);
		expect(shouldDumpRejectedRequest(new HttpError(413, "payload too large"))).toBe(true);
	});

	it("skips auth, not-found, rate-limit, and retried 5xx errors that would spam dumps", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
			expect(shouldDumpRejectedRequest(new HttpError(status, "x"))).toBe(false);
		}
	});

	it("skips errors without an HTTP status", () => {
		expect(shouldDumpRejectedRequest(new Error("network reset"))).toBe(false);
	});
});

describe("captureHttpErrorResponse", () => {
	it("parses a JSON error body into bodyJson and keeps the raw text", async () => {
		const captured = await captureHttpErrorResponse(new Response('{"error":{"message":"quota"}}', { status: 429 }));
		expect(captured.status).toBe(429);
		expect(captured.bodyText).toBe('{"error":{"message":"quota"}}');
		expect(captured.bodyJson).toEqual({ error: { message: "quota" } });
	});

	it("keeps a non-JSON body as text with bodyJson undefined", async () => {
		const captured = await captureHttpErrorResponse(new Response("<html>bad gateway</html>", { status: 502 }));
		expect(captured.bodyText).toBe("<html>bad gateway</html>");
		expect(captured.bodyJson).toBeUndefined();
	});

	it("normalizes an empty body to bodyText undefined", async () => {
		const captured = await captureHttpErrorResponse(new Response("", { status: 500 }));
		expect(captured.status).toBe(500);
		expect(captured.bodyText).toBeUndefined();
		expect(captured.bodyJson).toBeUndefined();
	});

	it("degrades to a status-only capture when the body was already consumed", async () => {
		const response = new Response("gone", { status: 503 });
		await response.text();
		const captured = await captureHttpErrorResponse(response);
		expect(captured.status).toBe(503);
		expect(captured.bodyText).toBeUndefined();
		expect(captured.bodyJson).toBeUndefined();
	});
});

describe("finalizeErrorMessage captured-body rendering", () => {
	async function finalize(bodyText: string): Promise<string> {
		return finalizeErrorMessage(new Error("boom"), undefined, {
			status: 400,
			bodyText,
			bodyJson: JSON.parse(bodyText),
		});
	}

	it("labels extras by field name even when earlier fields are absent", async () => {
		// Regression: extras were labeled by post-filter index, so a body without
		// `type` rendered param as `type=` and code as `param=`.
		const message = await finalize('{"error":{"message":"bad param","param":"messages","code":"invalid"}}');
		expect(message).toBe("boom\nbad param (param=messages code=invalid)");
	});

	it("labels the full type/param/code triple in order", async () => {
		const message = await finalize(
			'{"error":{"message":"bad","type":"invalid_request_error","param":"messages","code":"invalid"}}',
		);
		expect(message).toBe("boom\nbad (type=invalid_request_error param=messages code=invalid)");
	});

	it('renders a plain-string error body ({"error":"..."})', async () => {
		expect(await finalize('{"error":"model overloaded"}')).toBe("boom\nmodel overloaded");
	});

	it("treats a blank message as absent and falls through to the raw body", async () => {
		expect(await finalize('{"error":{"message":"   "}}')).toBe('boom\n{"error":{"message":"   "}}');
	});

	it("replaces a status-code-only message with the captured body", async () => {
		const message = await finalizeErrorMessage(new Error("400 status code (no body)"), undefined, {
			status: 400,
			bodyText: '{"error":{"message":"quota exceeded"}}',
			bodyJson: { error: { message: "quota exceeded" } },
		});
		expect(message).toBe("400 status code: quota exceeded");
	});
});
