import { describe, expect, it } from "bun:test";
import {
	applyOpenAIExtraBody,
	formatOpenAiError,
	mapOpenAIReasoningEffort,
	normalizeOpenAIStableId,
} from "../src/providers/openai-shared-helpers";

describe("normalizeOpenAIStableId", () => {
	it("returns undefined for undefined input", () => {
		expect(normalizeOpenAIStableId(undefined, 64, "h_")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(normalizeOpenAIStableId("", 64, "h_")).toBeUndefined();
	});
	it("returns value when within max length", () => {
		expect(normalizeOpenAIStableId("short", 64, "h_")).toBe("short");
	});
	it("replaces lone surrogates with replacement character", () => {
		const result = normalizeOpenAIStableId("test\uD800", 64, "h_");
		expect(result).toBe("test\uFFFD");
	});
	it("hashes when value exceeds max length", () => {
		const long = "a".repeat(100);
		const result = normalizeOpenAIStableId(long, 10, "h_");
		expect(result).toMatch(/^h_/);
		expect(result!.length).toBeLessThan(20);
	});
	it("returns value when exactly at max length", () => {
		const exact = "a".repeat(10);
		expect(normalizeOpenAIStableId(exact, 10, "h_")).toBe(exact);
	});
	it("hashes when one char over max length", () => {
		const over = "a".repeat(11);
		const result = normalizeOpenAIStableId(over, 10, "h_");
		expect(result).toMatch(/^h_/);
	});
});

describe("formatOpenAiError", () => {
	it("creates a Response with the given status", async () => {
		const res = formatOpenAiError(429, "rate_limit", "too many requests");
		expect(res.status).toBe(429);
	});
	it("includes error message and type in JSON body", async () => {
		const res = formatOpenAiError(400, "invalid_request", "bad input");
		const body = await res.json();
		expect(body.error.message).toBe("bad input");
		expect(body.error.type).toBe("invalid_request");
	});
	it("sets Content-Type to application/json", () => {
		const res = formatOpenAiError(500, "server_error", "oops");
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});
});

describe("applyOpenAIExtraBody", () => {
	it("does nothing when extraBody is undefined", () => {
		const params = { foo: 1 };
		applyOpenAIExtraBody(params, undefined);
		expect(params).toEqual({ foo: 1 });
	});
	it("does nothing when extraBody is null", () => {
		const params = { foo: 1 };
		applyOpenAIExtraBody(params, null as unknown as undefined);
		expect(params).toEqual({ foo: 1 });
	});
	it("merges extraBody into params", () => {
		const params = { foo: 1 };
		applyOpenAIExtraBody(params, { bar: 2 });
		expect(params).toEqual({ foo: 1, bar: 2 });
	});
	it("overwrites existing keys", () => {
		const params = { foo: 1 };
		applyOpenAIExtraBody(params, { foo: 99 });
		expect(params).toEqual({ foo: 99 });
	});
	it("drops thinking when reasoning_effort present and option set", () => {
		const params: { reasoning_effort?: string; thinking?: unknown } = { thinking: { budget: 100 } };
		applyOpenAIExtraBody(params, { reasoning_effort: "high" }, { dropThinkingWhenReasoningEffort: true });
		expect(params.reasoning_effort).toBe("high");
		expect(params.thinking).toBeUndefined();
	});
	it("does not drop thinking when reasoning_effort absent", () => {
		const params: { thinking?: unknown } = { thinking: { budget: 100 } };
		applyOpenAIExtraBody(params, { foo: 1 }, { dropThinkingWhenReasoningEffort: true });
		expect(params.thinking).toEqual({ budget: 100 });
	});
	it("does not drop thinking when option not set", () => {
		const params: { reasoning_effort?: string; thinking?: unknown } = { thinking: { budget: 100 } };
		applyOpenAIExtraBody(params, { reasoning_effort: "high" });
		expect(params.reasoning_effort).toBe("high");
		expect(params.thinking).toEqual({ budget: 100 });
	});
});

describe("mapOpenAIReasoningEffort", () => {
	it("returns effort when no map provided", () => {
		const model = { thinking: {} };
		expect(mapOpenAIReasoningEffort(model, undefined, "high")).toBe("high");
	});
	it("returns effort when map has no matching key", () => {
		const model = { thinking: {} };
		expect(mapOpenAIReasoningEffort(model, { reasoningEffortMap: { low: "1" } }, "high")).toBe("high");
	});
	it("returns compat map value when present", () => {
		const model = { thinking: {} };
		expect(mapOpenAIReasoningEffort(model, { reasoningEffortMap: { high: "MAX" } }, "high")).toBe("MAX");
	});
	it("returns model map value when compat map missing", () => {
		const model = { thinking: { effortMap: { high: "ULTRA" } } };
		expect(mapOpenAIReasoningEffort(model, undefined, "high")).toBe("ULTRA");
	});
	it("prefers compat map over model map", () => {
		const model = { thinking: { effortMap: { high: "MODEL" } } };
		expect(mapOpenAIReasoningEffort(model, { reasoningEffortMap: { high: "COMPAT" } }, "high")).toBe("COMPAT");
	});
	it("returns effort when both maps missing the key", () => {
		const model = { thinking: { effortMap: { low: "L" } } };
		expect(mapOpenAIReasoningEffort(model, { reasoningEffortMap: { low: "C" } }, "high")).toBe("high");
	});
});
