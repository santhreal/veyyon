import { describe, expect, it } from "bun:test";
import {
	buildHttp400DumpPayload,
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	shouldDumpRejectedRequest,
} from "@veyyon/pi-ai/utils/http-inspector";

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

describe("finalizeErrorMessage captured-body formatting", () => {
	const noBodyError = new HttpError(400, "400 status code (no body)");

	function captured(body: unknown): CapturedHttpErrorResponse {
		return { status: 400, bodyText: JSON.stringify(body), bodyJson: body };
	}

	it("labels extras by field name, not by position, when earlier fields are absent", async () => {
		// No "type": before the labeled-pair fix, param was mislabeled `type=` and code `param=`.
		const message = await finalizeErrorMessage(
			noBodyError,
			undefined,
			captured({ error: { message: "bad request", param: "temperature", code: "invalid_value" } }),
		);
		expect(message).toBe("400 status code: bad request (param=temperature code=invalid_value)");
	});

	it("skips blank message fields so the fallback chain reaches the outer message", async () => {
		const message = await finalizeErrorMessage(
			noBodyError,
			undefined,
			captured({ error: { message: "   " }, message: "outer message" }),
		);
		expect(message).toBe("400 status code: outer message");
	});

	it("falls back to a plain-string error value", async () => {
		const message = await finalizeErrorMessage(noBodyError, undefined, captured({ error: "plain failure" }));
		expect(message).toBe("400 status code: plain failure");
	});
});
