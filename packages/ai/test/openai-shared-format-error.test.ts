import { describe, expect, it } from "bun:test";
import { formatOpenAiError } from "@veyyon/ai/providers/openai-shared";

// The OpenAI-compatible error envelope shared by the openai-responses and
// openai-chat server modules. Both delegate their formatError here, so this
// pins the exact wire shape ({error:{message,type}}), status, and content-type.
describe("formatOpenAiError", () => {
	it("emits the OpenAI-compatible {error:{message,type}} envelope", async () => {
		const res = formatOpenAiError(400, "invalid_request_error", "bad model");
		expect(res.status).toBe(400);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(await res.json()).toEqual({ error: { message: "bad model", type: "invalid_request_error" } });
	});

	it("passes the status through unchanged", async () => {
		const res = formatOpenAiError(429, "rate_limit_exceeded", "slow down");
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: { message: "slow down", type: "rate_limit_exceeded" } });
	});

	it("preserves an empty message and type verbatim", async () => {
		const res = formatOpenAiError(500, "", "");
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: { message: "", type: "" } });
	});
});
