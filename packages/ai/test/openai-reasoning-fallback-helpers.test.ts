import { describe, expect, it } from "bun:test";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "../src/providers/openai-reasoning-fallback";

describe("createOpenAIReasoningEffortFallbackState", () => {
	it("returns state with empty Map", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		expect(state.reasoningEffortFallbacks).toBeInstanceOf(Map);
		expect(state.reasoningEffortFallbacks.size).toBe(0);
	});
});

describe("clearOpenAIReasoningEffortFallbackState", () => {
	it("clears the map", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", "low");
		clearOpenAIReasoningEffortFallbackState(state);
		expect(state.reasoningEffortFallbacks.size).toBe(0);
	});
});

describe("getOpenAIReasoningEffortFallback", () => {
	it("returns undefined for undefined state", () => {
		expect(getOpenAIReasoningEffortFallback(undefined, "key")).toBeUndefined();
	});
	it("returns undefined for missing key", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		expect(getOpenAIReasoningEffortFallback(state, "missing")).toBeUndefined();
	});
	it("returns stored value", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", "low");
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBe("low");
	});
	it("returns null when null was stored", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", null);
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBeNull();
	});
});

describe("rememberOpenAIReasoningEffortFallback", () => {
	it("does nothing for undefined state", () => {
		rememberOpenAIReasoningEffortFallback(undefined, "key", "low");
		// no throw
	});
	it("overwrites existing key", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", "low");
		rememberOpenAIReasoningEffortFallback(state, "key", "medium");
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBe("medium");
	});
});

describe("createOpenAIReasoningEffortFallbackKey", () => {
	it("creates key from endpoint, baseUrl, modelId", () => {
		expect(createOpenAIReasoningEffortFallbackKey("chat-completions", "https://api.openai.com", "gpt-4o")).toBe(
			"chat-completions:https://api.openai.com:gpt-4o",
		);
	});
	it("handles undefined baseUrl", () => {
		expect(createOpenAIReasoningEffortFallbackKey("responses", undefined, "gpt-4o")).toBe("responses::gpt-4o");
	});
	it("handles undefined modelId", () => {
		expect(createOpenAIReasoningEffortFallbackKey("responses", "https://api.openai.com", undefined)).toBe(
			"responses:https://api.openai.com:",
		);
	});
	it("handles all undefined", () => {
		expect(createOpenAIReasoningEffortFallbackKey("azure-responses", undefined, undefined)).toBe("azure-responses::");
	});
});

describe("applyOpenAIReasoningEffortFallback", () => {
	it("returns false for non-object params", () => {
		expect(applyOpenAIReasoningEffortFallback("string", "low")).toBe(false);
		expect(applyOpenAIReasoningEffortFallback(42, "low")).toBe(false);
		expect(applyOpenAIReasoningEffortFallback(null, "low")).toBe(false);
	});
	it("returns false when no reasoning_effort field", () => {
		expect(applyOpenAIReasoningEffortFallback({}, "low")).toBe(false);
	});
	it("updates reasoning_effort to new value", () => {
		const params: { reasoning_effort?: string } = { reasoning_effort: "high" };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(true);
		expect(params.reasoning_effort).toBe("low");
	});
	it("deletes reasoning_effort when fallback is null", () => {
		const params: { reasoning_effort?: string } = { reasoning_effort: "high" };
		expect(applyOpenAIReasoningEffortFallback(params, null)).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
	});
	it("updates nested reasoning.effort to new value", () => {
		const params: { reasoning?: { effort?: string } } = { reasoning: { effort: "high" } };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(true);
		expect(params.reasoning?.effort).toBe("low");
	});
	it("deletes nested reasoning.effort when fallback is null", () => {
		const params: { reasoning?: { effort?: string } } = { reasoning: { effort: "high" } };
		expect(applyOpenAIReasoningEffortFallback(params, null)).toBe(true);
		expect(params.reasoning?.effort).toBeUndefined();
	});
	it("deletes nested reasoning object when only effort was in it", () => {
		const params: { reasoning?: { effort?: string } } = { reasoning: { effort: "high" } };
		applyOpenAIReasoningEffortFallback(params, null);
		expect(params.reasoning).toBeUndefined();
	});
	it("does not delete reasoning object when it has other keys", () => {
		const params: { reasoning?: { effort?: string; other?: string } } = {
			reasoning: { effort: "high", other: "value" },
		};
		applyOpenAIReasoningEffortFallback(params, null);
		expect(params.reasoning).toBeDefined();
		expect(params.reasoning?.other).toBe("value");
	});
	it("updates both reasoning_effort and nested reasoning.effort", () => {
		const params: { reasoning_effort?: string; reasoning?: { effort?: string } } = {
			reasoning_effort: "high",
			reasoning: { effort: "high" },
		};
		applyOpenAIReasoningEffortFallback(params, "low");
		expect(params.reasoning_effort).toBe("low");
		expect(params.reasoning?.effort).toBe("low");
	});
});

describe("resolveOpenAIReasoningEffortFallback", () => {
	it("returns undefined when params has no reasoning_effort", () => {
		expect(resolveOpenAIReasoningEffortFallback(new Error("bad"), undefined, {})).toBeUndefined();
	});
	it("returns undefined when params is not an object", () => {
		expect(resolveOpenAIReasoningEffortFallback(new Error("bad"), undefined, "string")).toBeUndefined();
	});
	it("returns undefined when error is not about reasoning effort", () => {
		const params = { reasoning_effort: "high" };
		expect(resolveOpenAIReasoningEffortFallback(new Error("unrelated error"), undefined, params)).toBeUndefined();
	});
});
