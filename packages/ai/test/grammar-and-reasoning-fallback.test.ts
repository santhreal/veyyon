import { describe, expect, it } from "bun:test";
import { compactGrammarDefinition } from "../src/providers/grammar";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "../src/providers/openai-reasoning-fallback";

describe("compactGrammarDefinition", () => {
	it("returns definition unchanged for non-lark syntax", () => {
		const def = "some regex definition";
		expect(compactGrammarDefinition("regex", def)).toBe(def);
	});

	it("removes empty lines from lark grammar", () => {
		const def = "rule1: abc\n\n\nrule2: def";
		expect(compactGrammarDefinition("lark", def)).toBe("rule1: abc\nrule2: def");
	});

	it("removes line comments from lark grammar", () => {
		const def = "rule1: abc // comment\nrule2: def";
		expect(compactGrammarDefinition("lark", def)).toBe("rule1: abc\nrule2: def");
	});

	it("removes comment-only lines", () => {
		const def = "// just a comment\nrule1: abc";
		expect(compactGrammarDefinition("lark", def)).toBe("rule1: abc");
	});

	it("handles trailing whitespace", () => {
		const def = "rule1: abc   \nrule2: def   ";
		expect(compactGrammarDefinition("lark", def)).toBe("rule1: abc\nrule2: def");
	});

	it("handles CRLF line endings", () => {
		const def = "rule1: abc\r\n\r\nrule2: def\r\n";
		expect(compactGrammarDefinition("lark", def)).toBe("rule1: abc\nrule2: def");
	});

	it("does not strip // inside strings", () => {
		const def = 'rule: "http://example.com"';
		expect(compactGrammarDefinition("lark", def)).toBe('rule: "http://example.com"');
	});

	it("does not strip // inside single-quoted strings", () => {
		const def = "rule: 'http://example.com'";
		expect(compactGrammarDefinition("lark", def)).toBe("rule: 'http://example.com'");
	});

	it("does not strip // inside regex", () => {
		const def = "rule: /https?:\\/\\/.+//";
		expect(compactGrammarDefinition("lark", def)).toBe("rule: /https?:\\/\\/.+//");
	});

	it("handles escaped characters in strings", () => {
		const def = 'rule: "say \\"hi\\"" // comment';
		expect(compactGrammarDefinition("lark", def)).toBe('rule: "say \\"hi\\""');
	});

	it("handles empty definition", () => {
		expect(compactGrammarDefinition("lark", "")).toBe("");
	});

	it("handles whitespace-only definition", () => {
		expect(compactGrammarDefinition("lark", "  \n  \n  ")).toBe("");
	});

	it("preserves comment after string value", () => {
		const def = 'rule: "value" // this is a comment';
		const result = compactGrammarDefinition("lark", def);
		expect(result).toBe('rule: "value"');
	});

	it("handles multiple rules with mixed comments", () => {
		const def = [
			"// header comment",
			"start: expr",
			"",
			"expr: term // expr rule",
			"// another comment",
			"term: factor",
		].join("\n");
		expect(compactGrammarDefinition("lark", def)).toBe("start: expr\nexpr: term\nterm: factor");
	});
});

describe("createOpenAIReasoningEffortFallbackState", () => {
	it("creates a state with an empty Map", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		expect(state.reasoningEffortFallbacks).toBeInstanceOf(Map);
		expect(state.reasoningEffortFallbacks.size).toBe(0);
	});
});

describe("clearOpenAIReasoningEffortFallbackState", () => {
	it("clears all entries from the state", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		state.reasoningEffortFallbacks.set("key", "low");
		clearOpenAIReasoningEffortFallbackState(state);
		expect(state.reasoningEffortFallbacks.size).toBe(0);
	});

	it("does nothing on empty state", () => {
		const state = createOpenAIReasoningEffortFallbackState();
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

	it("returns stored value for existing key", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		state.reasoningEffortFallbacks.set("key", "low");
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBe("low");
	});

	it("returns null when null was stored", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		state.reasoningEffortFallbacks.set("key", null);
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBeNull();
	});
});

describe("rememberOpenAIReasoningEffortFallback", () => {
	it("stores a fallback value", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", "medium");
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBe("medium");
	});

	it("overwrites existing value", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", "low");
		rememberOpenAIReasoningEffortFallback(state, "key", "high");
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBe("high");
	});

	it("stores null", () => {
		const state = createOpenAIReasoningEffortFallbackState();
		rememberOpenAIReasoningEffortFallback(state, "key", null);
		expect(getOpenAIReasoningEffortFallback(state, "key")).toBeNull();
	});

	it("does nothing for undefined state", () => {
		rememberOpenAIReasoningEffortFallback(undefined, "key", "low");
		// Should not throw
		expect(true).toBe(true);
	});
});

describe("createOpenAIReasoningEffortFallbackKey", () => {
	it("creates key from endpoint, baseUrl, and modelId", () => {
		expect(createOpenAIReasoningEffortFallbackKey("chat-completions", "https://api.openai.com", "gpt-4")).toBe(
			"chat-completions:https://api.openai.com:gpt-4",
		);
	});

	it("handles undefined baseUrl", () => {
		expect(createOpenAIReasoningEffortFallbackKey("responses", undefined, "o3")).toBe("responses::o3");
	});

	it("handles undefined modelId", () => {
		expect(createOpenAIReasoningEffortFallbackKey("chat-completions", "https://api.openai.com", undefined)).toBe(
			"chat-completions:https://api.openai.com:",
		);
	});

	it("handles both undefined", () => {
		expect(createOpenAIReasoningEffortFallbackKey("azure-responses", undefined, undefined)).toBe("azure-responses::");
	});

	it("handles empty strings", () => {
		expect(createOpenAIReasoningEffortFallbackKey("chat-completions", "", "")).toBe("chat-completions::");
	});
});

describe("applyOpenAIReasoningEffortFallback", () => {
	it("returns false for non-record params", () => {
		expect(applyOpenAIReasoningEffortFallback("string", "low")).toBe(false);
		expect(applyOpenAIReasoningEffortFallback(42, "low")).toBe(false);
		expect(applyOpenAIReasoningEffortFallback(null, "low")).toBe(false);
		expect(applyOpenAIReasoningEffortFallback(undefined, "low")).toBe(false);
	});

	it("updates reasoning_effort string field", () => {
		const params = { reasoning_effort: "high" };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(true);
		expect(params.reasoning_effort).toBe("low");
	});

	it("deletes reasoning_effort when fallback is null", () => {
		const params: Record<string, unknown> = { reasoning_effort: "high" };
		expect(applyOpenAIReasoningEffortFallback(params, null)).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("updates reasoning.effort nested field", () => {
		const params = { reasoning: { effort: "high" } };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(true);
		expect((params.reasoning as Record<string, unknown>).effort).toBe("low");
	});

	it("deletes reasoning.effort and cleans up empty reasoning object", () => {
		const params: Record<string, unknown> = { reasoning: { effort: "high" } };
		expect(applyOpenAIReasoningEffortFallback(params, null)).toBe(true);
		expect(params.reasoning).toBeUndefined();
	});

	it("deletes reasoning.effort but keeps reasoning if it has other keys", () => {
		const params: Record<string, unknown> = { reasoning: { effort: "high", other: "value" } };
		expect(applyOpenAIReasoningEffortFallback(params, null)).toBe(true);
		expect((params.reasoning as Record<string, unknown>).effort).toBeUndefined();
		expect((params.reasoning as Record<string, unknown>).other).toBe("value");
	});

	it("returns false when no reasoning fields present", () => {
		const params = { model: "gpt-4" };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(false);
	});

	it("updates both reasoning_effort and reasoning.effort", () => {
		const params = { reasoning_effort: "high", reasoning: { effort: "high" } };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(true);
		expect(params.reasoning_effort).toBe("low");
		expect((params.reasoning as Record<string, unknown>).effort).toBe("low");
	});

	it("handles reasoning object without effort field", () => {
		const params = { reasoning: { other: "value" } };
		expect(applyOpenAIReasoningEffortFallback(params, "low")).toBe(false);
	});
});

describe("resolveOpenAIReasoningEffortFallback", () => {
	it("returns undefined for undefined params", () => {
		expect(resolveOpenAIReasoningEffortFallback(new Error("err"), undefined, undefined)).toBeUndefined();
	});

	it("returns undefined when params has no reasoning effort", () => {
		expect(resolveOpenAIReasoningEffortFallback(new Error("err"), undefined, { model: "gpt-4" })).toBeUndefined();
	});

	it("returns undefined for non-record params", () => {
		expect(resolveOpenAIReasoningEffortFallback(new Error("err"), undefined, "string")).toBeUndefined();
	});
});
