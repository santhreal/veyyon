import { describe, expect, it } from "bun:test";
import type { Effort } from "@veyyon/catalog/effort";
import {
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	formatOpenAiError,
	isCompiledGrammarTooLargeStrictError,
	mapOpenAIReasoningEffort,
	normalizeOpenAIStableId,
	type OpenAIGatewayRoutingCompat,
	type OpenAIGatewayRoutingParams,
	shouldRetryWithoutStrictTools,
} from "../src/providers/openai-shared-helpers";
import type { Model } from "../src/types";

describe("applyOpenAIGatewayRouting", () => {
	it("sets provider when isOpenRouterHost and openRouterRouting provided", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: true,
		openRouterRouting: { order: ["auto"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.provider).toBe("openrouter/auto");
	});
	it("does not set provider when not OpenRouter host", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
		openRouterRouting: { order: ["auto"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.provider).toBeUndefined();
	});
	it("does not set provider when openRouterRouting missing", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: true,
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.provider).toBeUndefined();
	});
	it("sets gateway.only when Vercel gateway with only routing", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { only: ["openai"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions?.gateway?.only).toEqual(["openai"]);
	});
	it("sets gateway.order when Vercel gateway with order routing", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { order: ["openai", "anthropic"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions?.gateway?.order).toEqual(["openai", "anthropic"]);
	});
	it("sets both gateway.only and gateway.order when both provided", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { only: ["openai"], order: ["anthropic"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions?.gateway?.only).toEqual(["openai"]);
		expect(params.providerOptions?.gateway?.order).toEqual(["anthropic"]);
	});
	it("does not set gateway when Vercel routing has neither only nor order", () => {
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: {},
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions).toBeUndefined();
	});
	it("does not set gateway when not Vercel host", () => {
		const params: OpenAIGatewayRoutingParams = {};
		const compat: OpenAIGatewayRoutingCompat = {
		isOpenRouterHost: false,
		isVercelGatewayHost: false,
			vercelGatewayRouting: { only: ["openai"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions).toBeUndefined();
	});
});

describe("applyOpenAIExtraBody", () => {
	it("does nothing when extraBody is undefined", () => {
		const params = { foo: "bar" };
		applyOpenAIExtraBody(params, undefined);
		expect(params).toEqual({ foo: "bar" });
	});
	it("merges extraBody into params", () => {
		const params = { foo: "bar" };
		applyOpenAIExtraBody(params, { baz: "qux" });
		expect(params).toEqual({ foo: "bar", baz: "qux" });
	});
	it("overwrites existing params with extraBody", () => {
		const params = { foo: "bar" };
		applyOpenAIExtraBody(params, { foo: "overwritten" });
		expect(params.foo).toBe("overwritten");
	});
	it("drops thinking when reasoning_effort is set and option enabled", () => {
		const params: { reasoning_effort?: string; thinking?: unknown } = {
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		};
		applyOpenAIExtraBody(params, {}, { dropThinkingWhenReasoningEffort: true });
		expect(params.thinking).toBeUndefined();
		expect(params.reasoning_effort).toBe("high");
	});
	it("does not drop thinking when reasoning_effort not set", () => {
		const params: { reasoning_effort?: string; thinking?: unknown } = {
			thinking: { type: "enabled" },
		};
		applyOpenAIExtraBody(params, {}, { dropThinkingWhenReasoningEffort: true });
		expect(params.thinking).toEqual({ type: "enabled" });
	});
	it("does not drop thinking when option not enabled", () => {
		const params: { reasoning_effort?: string; thinking?: unknown } = {
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		};
		applyOpenAIExtraBody(params, {});
		expect(params.thinking).toEqual({ type: "enabled" });
	});
	it("merges nested objects by assignment", () => {
		const params = { config: { a: 1 } };
		applyOpenAIExtraBody(params, { config: { b: 2 } });
		expect(params.config).toEqual({ b: 2 });
	});
});

describe("mapOpenAIReasoningEffort", () => {
	it("returns effort as-is when no compat or model map", () => {
		const model = { thinking: {} } as Pick<Model, "thinking">;
		expect(mapOpenAIReasoningEffort(model, undefined, "high")).toBe("high");
	});
	it("returns mapped effort from compat map", () => {
		const model = { thinking: {} } as Pick<Model, "thinking">;
		const compat = { reasoningEffortMap: { high: "max" } as Partial<Record<Effort, string>> };
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("max");
	});
	it("returns mapped effort from model thinking map", () => {
		const model = { thinking: { effortMap: { high: "ultra" } } } as unknown as Pick<Model, "thinking">;
		expect(mapOpenAIReasoningEffort(model, undefined, "high")).toBe("ultra");
	});
	it("prefers compat map over model map", () => {
		const model = { thinking: { effortMap: { high: "ultra" } } } as unknown as Pick<Model, "thinking">;
		const compat = { reasoningEffortMap: { high: "max" } as Partial<Record<Effort, string>> };
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("max");
	});
	it("returns effort as-is when not in either map", () => {
		const model = { thinking: { effortMap: { low: "min" } } } as unknown as Pick<Model, "thinking">;
		const compat = { reasoningEffortMap: { low: "min" } as Partial<Record<Effort, string>> };
		expect(mapOpenAIReasoningEffort(model, compat, "high")).toBe("high");
	});
});

describe("normalizeOpenAIStableId", () => {
	it("returns undefined for undefined input", () => {
		expect(normalizeOpenAIStableId(undefined, 64, "id_")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(normalizeOpenAIStableId("", 64, "id_")).toBeUndefined();
	});
	it("returns well-formed string when within maxLength", () => {
		expect(normalizeOpenAIStableId("abc123", 64, "id_")).toBe("abc123");
	});
	it("returns hash-prefixed id when exceeding maxLength", () => {
		const longId = "a".repeat(100);
		const result = normalizeOpenAIStableId(longId, 64, "id_");
		expect(result).toMatch(/^id_/);
		expect(result!.length).toBeLessThan(longId.length);
	});
	it("returns string as-is when exactly maxLength", () => {
		const exact = "a".repeat(64);
		expect(normalizeOpenAIStableId(exact, 64, "id_")).toBe(exact);
	});
	it("normalizes lone surrogates via toWellFormed", () => {
		const malformed = "a\uD800b";
		const result = normalizeOpenAIStableId(malformed, 64, "id_");
		expect(result).toBe(malformed.toWellFormed());
	});
	it("produces deterministic hash for same input", () => {
		const longId = "a".repeat(100);
		const r1 = normalizeOpenAIStableId(longId, 64, "id_");
		const r2 = normalizeOpenAIStableId(longId, 64, "id_");
		expect(r1).toBe(r2);
	});
	it("produces different hashes for different inputs", () => {
		const id1 = "a".repeat(100);
		const id2 = "b".repeat(100);
		expect(normalizeOpenAIStableId(id1, 64, "id_")).not.toBe(normalizeOpenAIStableId(id2, 64, "id_"));
	});
});

describe("formatOpenAiError", () => {
	it("returns a Response with correct status", () => {
		const response = formatOpenAiError(400, "invalid_request_error", "Bad request");
		expect(response.status).toBe(400);
	});
	it("returns JSON content type", () => {
		const response = formatOpenAiError(500, "server_error", "Internal error");
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});
	it("body contains error object with message and type", async () => {
		const response = formatOpenAiError(429, "rate_limit_error", "Too many requests");
		const body = (await response.json()) as { error: { message: string; type: string } };
		expect(body.error.message).toBe("Too many requests");
		expect(body.error.type).toBe("rate_limit_error");
	});
});

describe("isCompiledGrammarTooLargeStrictError", () => {
	it("returns false for non-400 status errors", () => {
		expect(isCompiledGrammarTooLargeStrictError(new Error("some error"), { status: 500 } as never)).toBe(false);
	});
	it("returns false for undefined error and response", () => {
		expect(isCompiledGrammarTooLargeStrictError(undefined, undefined)).toBe(false);
	});
	it("returns false for 400 with non-matching text", () => {
		expect(isCompiledGrammarTooLargeStrictError(new Error("some other error"), { status: 400 } as never)).toBe(false);
	});
});

describe("shouldRetryWithoutStrictTools", () => {
	it("returns false when no tools provided", () => {
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, true, undefined)).toBe(false);
	});
	it("returns false when tools array is empty", () => {
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, true, [])).toBe(false);
	});
	it("returns false when strictToolsApplied is false", () => {
		expect(shouldRetryWithoutStrictTools(new Error("err"), undefined, false, [{ type: "function" } as never])).toBe(
			false,
		);
	});
	it("returns false for non-400/422 status", () => {
		expect(
			shouldRetryWithoutStrictTools(new Error("err"), { status: 500 } as never, true, [
				{ type: "function" } as never,
			]),
		).toBe(false);
	});
	it("returns false for 400 with non-matching text", () => {
		expect(
			shouldRetryWithoutStrictTools(new Error("some error"), { status: 400 } as never, true, [
				{ type: "function" } as never,
			]),
		).toBe(false);
	});
});
