import { describe, expect, it } from "bun:test";
import type { OpenAIGatewayRoutingParams } from "../src/providers/openai-shared-helpers";
import {
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	formatOpenAiError,
	isCompiledGrammarTooLargeStrictError,
	mapOpenAIReasoningEffort,
	normalizeOpenAIStableId,
	shouldRetryWithoutStrictTools,
} from "../src/providers/openai-shared-helpers";
import type { Tool } from "../src/types";

describe("applyOpenAIGatewayRouting", () => {
	it("applies OpenRouter routing when host is OpenRouter", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: true,
			openRouterRouting: { order: ["provider1"] } as never,
		});
		expect(params.provider).toEqual({ order: ["provider1"] });
	});

	it("does not apply OpenRouter routing when host is not OpenRouter", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			openRouterRouting: { order: ["provider1"] } as never,
		});
		expect(params.provider).toBeUndefined();
	});

	it("applies Vercel Gateway routing with only filter", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { only: ["provider1", "provider2"] } as never,
		});
		expect(params.providerOptions?.gateway?.only).toEqual(["provider1", "provider2"]);
	});

	it("applies Vercel Gateway routing with order", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { order: ["provider1"] } as never,
		});
		expect(params.providerOptions?.gateway?.order).toEqual(["provider1"]);
	});

	it("does not apply Vercel Gateway routing when host is not Vercel", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: false,
			vercelGatewayRouting: { only: ["provider1"] } as never,
		});
		expect(params.providerOptions).toBeUndefined();
	});

	it("does not apply Vercel Gateway routing when routing has no only or order", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: {} as never,
		});
		expect(params.providerOptions).toBeUndefined();
	});

	it("applies both OpenRouter and Vercel Gateway when both are set", () => {
		const params: OpenAIGatewayRoutingParams = {};
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: true,
			openRouterRouting: { order: ["p1"] } as never,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { only: ["p2"] } as never,
		});
		expect(params.provider).toEqual({ order: ["p1"] });
		expect(params.providerOptions?.gateway?.only).toEqual(["p2"]);
	});
});

describe("applyOpenAIExtraBody", () => {
	it("does nothing when extraBody is undefined", () => {
		const params: Record<string, unknown> = { a: 1 };
		applyOpenAIExtraBody(params, undefined);
		expect(params).toEqual({ a: 1 });
	});

	it("merges extraBody into params", () => {
		const params: Record<string, unknown> = { a: 1 };
		applyOpenAIExtraBody(params, { b: 2, c: 3 });
		expect(params).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("overwrites existing params with extraBody", () => {
		const params: Record<string, unknown> = { a: 1, b: 2 };
		applyOpenAIExtraBody(params, { b: 99 });
		expect(params).toEqual({ a: 1, b: 99 });
	});

	it("drops thinking when reasoning_effort is set and option is enabled", () => {
		const params: Record<string, unknown> = { reasoning_effort: "high", thinking: { type: "enabled" } };
		applyOpenAIExtraBody(params, { reasoning_effort: "high" }, { dropThinkingWhenReasoningEffort: true });
		expect(params).toEqual({ reasoning_effort: "high" });
		expect(params.thinking).toBeUndefined();
	});

	it("does not drop thinking when reasoning_effort is not set", () => {
		const params = { thinking: { type: "enabled" } };
		applyOpenAIExtraBody(params, {}, { dropThinkingWhenReasoningEffort: true });
		expect((params as { thinking?: unknown }).thinking).toEqual({ type: "enabled" });
	});

	it("does not drop thinking when option is not enabled", () => {
		const params = { reasoning_effort: "high", thinking: { type: "enabled" } };
		applyOpenAIExtraBody(params, { reasoning_effort: "high" });
		expect((params as { thinking?: unknown }).thinking).toEqual({ type: "enabled" });
	});

	it("handles empty extraBody object", () => {
		const params = { a: 1 };
		applyOpenAIExtraBody(params, {});
		expect(params).toEqual({ a: 1 });
	});

	it("handles null extraBody", () => {
		const params = { a: 1 };
		applyOpenAIExtraBody(params, null as unknown as undefined);
		expect(params).toEqual({ a: 1 });
	});
});

describe("mapOpenAIReasoningEffort", () => {
	it("returns effort unchanged when no compat or model map", () => {
		const model = { thinking: {} } as never;
		expect(mapOpenAIReasoningEffort(model, undefined, "high")).toBe("high");
	});

	it("returns mapped effort from compat map", () => {
		const model = { thinking: {} } as never;
		const compat = { reasoningEffortMap: { high: "max" } } as never;
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("max");
	});

	it("returns mapped effort from model thinking map", () => {
		const model = { thinking: { effortMap: { low: "minimal" } } } as never;
		expect(mapOpenAIReasoningEffort(model, undefined, "low")).toBe("minimal");
	});

	it("prefers compat map over model map", () => {
		const model = { thinking: { effortMap: { high: "from-model" } } } as never;
		const compat = { reasoningEffortMap: { high: "from-compat" } } as never;
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("from-compat");
	});

	it("returns effort unchanged when not in either map", () => {
		const model = { thinking: { effortMap: { low: "minimal" } } } as never;
		const compat = { reasoningEffortMap: { high: "max" } } as never;
		expect(mapOpenAIReasoningEffort(model, compat, "medium")).toBe("medium");
	});

	it("handles empty compat object", () => {
		const model = { thinking: {} } as never;
		expect(mapOpenAIReasoningEffort(model, {}, "high")).toBe("high");
	});

	it("handles empty effort map", () => {
		const model = { thinking: { effortMap: {} } } as never;
		const compat = { reasoningEffortMap: {} } as never;
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("high");
	});
});

describe("normalizeOpenAIStableId", () => {
	it("returns undefined for undefined input", () => {
		expect(normalizeOpenAIStableId(undefined, 100, "h")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(normalizeOpenAIStableId("", 100, "h")).toBeUndefined();
	});

	it("returns short string unchanged", () => {
		expect(normalizeOpenAIStableId("abc", 100, "h")).toBe("abc");
	});

	it("returns string at exact max length unchanged", () => {
		const str = "a".repeat(50);
		expect(normalizeOpenAIStableId(str, 50, "h")).toBe(str);
	});

	it("hashes string longer than max length", () => {
		const str = "a".repeat(200);
		const result = normalizeOpenAIStableId(str, 50, "h");
		expect(result).toMatch(/^h[0-9a-z]+$/);
		expect(result!.length).toBeLessThan(50);
	});

	it("uses custom hash prefix", () => {
		const str = "a".repeat(200);
		const result = normalizeOpenAIStableId(str, 50, "custom-");
		expect(result).toMatch(/^custom-[0-9a-z]+$/);
	});

	it("normalizes lone surrogates via toWellFormed", () => {
		// Lone surrogate \uD800 gets replaced with U+FFFD by toWellFormed
		const str = "\uD800";
		const result = normalizeOpenAIStableId(str, 100, "h");
		expect(result).toBe("\uFFFD");
	});

	it("produces consistent hash for same input", () => {
		const str = "a".repeat(200);
		const r1 = normalizeOpenAIStableId(str, 50, "h");
		const r2 = normalizeOpenAIStableId(str, 50, "h");
		expect(r1).toBe(r2);
	});

	it("produces different hashes for different inputs", () => {
		const s1 = "a".repeat(200);
		const s2 = "b".repeat(200);
		const r1 = normalizeOpenAIStableId(s1, 50, "h");
		const r2 = normalizeOpenAIStableId(s2, 50, "h");
		expect(r1).not.toBe(r2);
	});
});

describe("formatOpenAiError", () => {
	it("creates a Response with JSON error body", () => {
		const response = formatOpenAiError(400, "invalid_request", "Bad request");
		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});

	it("includes error message and type in body", async () => {
		const response = formatOpenAiError(429, "rate_limit", "Too many requests");
		const body = (await response.json()) as { error: { message: string; type: string } };
		expect(body).toEqual({ error: { message: "Too many requests", type: "rate_limit" } });
	});

	it("handles 500 status", () => {
		const response = formatOpenAiError(500, "server_error", "Internal error");
		expect(response.status).toBe(500);
	});

	it("handles empty message", async () => {
		const response = formatOpenAiError(400, "error", "");
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toBe("");
	});
});

describe("shouldRetryWithoutStrictTools", () => {
	it("returns false when no tools", () => {
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, true, undefined)).toBe(false);
	});

	it("returns false when tools array is empty", () => {
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, true, [])).toBe(false);
	});

	it("returns false when strictToolsApplied is false", () => {
		const tools: Tool[] = [{ type: "function", function: { name: "test" } } as never];
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, false, tools)).toBe(false);
	});

	it("returns false when status is not 400 or 422", () => {
		const tools: Tool[] = [{ type: "function", function: { name: "test" } } as never];
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, true, tools)).toBe(false);
	});

	it("returns false for 500 status", () => {
		const tools: Tool[] = [{ type: "function", function: { name: "test" } } as never];
		expect(shouldRetryWithoutStrictTools(new Error("500 error"), undefined, true, tools)).toBe(false);
	});
});

describe("isCompiledGrammarTooLargeStrictError", () => {
	it("returns false when status is not 400", () => {
		expect(isCompiledGrammarTooLargeStrictError(new Error("err"), undefined)).toBe(false);
	});

	it("returns false for undefined error and captured response", () => {
		expect(isCompiledGrammarTooLargeStrictError(undefined, undefined)).toBe(false);
	});
});
