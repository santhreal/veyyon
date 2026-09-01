import { describe, expect, it } from "bun:test";
import {
	formatOpenAIInputText,
	isOfficialOpenAIResponsesEndpoint,
	OPENAI_PROMPT_CACHE_DISABLED,
	type OpenAIPromptCachePolicyInput,
	resolveOpenAIPromptCachePolicy,
} from "../src/providers/openai-prompt-cache";
import type { Model } from "../src/types";

function makeModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-4o",
		provider: "openai",
		api: "openai-responses",
		compat: { supportsLongPromptCacheRetention: true },
		...overrides,
	} as unknown as Model<"openai-responses">;
}

describe("isOfficialOpenAIResponsesEndpoint", () => {
	it("returns false for non-openai provider", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ provider: "azure" }))).toBe(false);
	});
	it("returns true when baseUrl is undefined", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: undefined }))).toBe(true);
	});
	it("returns true when baseUrl hostname is api.openai.com", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "https://api.openai.com/v1" }))).toBe(true);
	});
	it("returns false when baseUrl hostname is not api.openai.com", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "https://custom.example.com/v1" }))).toBe(false);
	});
	it("returns false for invalid URL", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "not-a-url" }))).toBe(false);
	});
});

describe("OPENAI_PROMPT_CACHE_DISABLED", () => {
	it("has undefined stablePrefixBreakpoint", () => {
		expect(OPENAI_PROMPT_CACHE_DISABLED.stablePrefixBreakpoint).toBeUndefined();
	});
	it("has undefined promptCacheRetention", () => {
		expect(OPENAI_PROMPT_CACHE_DISABLED.promptCacheRetention).toBeUndefined();
	});
	it("is frozen", () => {
		expect(Object.isFrozen(OPENAI_PROMPT_CACHE_DISABLED)).toBe(true);
	});
});

describe("resolveOpenAIPromptCachePolicy", () => {
	it("returns disabled policy when promptCacheKey is undefined", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel(),
			promptCacheKey: undefined,
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeUndefined();
		expect(result.promptCacheRetention).toBeUndefined();
	});
	it("returns disabled policy when promptCacheKey is empty", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel(),
			promptCacheKey: "",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeUndefined();
	});
	it("returns disabled policy when not official endpoint", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ baseUrl: "https://custom.example.com/v1" }),
			promptCacheKey: "cache-key",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeUndefined();
	});
	it("returns disabled policy when model does not support breakpoints", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "unknown-model-id" }),
			promptCacheKey: "cache-key",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeUndefined();
	});
	it("returns breakpoint when all conditions met", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "gpt-5.6" }),
			promptCacheKey: "cache-key",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeDefined();
		expect(result.stablePrefixBreakpoint?.mode).toBe("explicit");
	});
	it("returns 24h retention when cacheRetention is long and model supports it", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "unknown-model-id" }),
			promptCacheKey: "cache-key",
			cacheRetention: "long",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.promptCacheRetention).toBe("24h");
	});
	it("does not return 24h retention when cacheRetention is not long", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "unknown-model-id" }),
			promptCacheKey: "cache-key",
			cacheRetention: "short",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.promptCacheRetention).toBeUndefined();
	});
	it("does not return 24h retention when model does not support it", () => {
		const input: OpenAIPromptCachePolicyInput = {
		model: makeModel({ id: "unknown-model-id", compat: { supportsLongPromptCacheRetention: false } as never }),
			promptCacheKey: "cache-key",
			cacheRetention: "long",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.promptCacheRetention).toBeUndefined();
	});
	it("does not return 24h retention when generation supports breakpoints", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "gpt-5.6" }),
			promptCacheKey: "cache-key",
			cacheRetention: "long",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.promptCacheRetention).toBeUndefined();
	});
	it("uses requestModelId when available", () => {
		const input: OpenAIPromptCachePolicyInput = {
			model: makeModel({ id: "alias-id", requestModelId: "gpt-5.6" }),
			promptCacheKey: "cache-key",
		};
		const result = resolveOpenAIPromptCachePolicy(input);
		expect(result.stablePrefixBreakpoint).toBeDefined();
	});
});

describe("formatOpenAIInputText", () => {
	it("returns plain input_text when policy has no breakpoint", () => {
		const result = formatOpenAIInputText("hello", OPENAI_PROMPT_CACHE_DISABLED);
		expect(result).toEqual({ type: "input_text", text: "hello" });
	});
	it("returns plain input_text when text is whitespace-only", () => {
		const policy = { stablePrefixBreakpoint: { mode: "explicit" as const }, promptCacheRetention: undefined };
		const result = formatOpenAIInputText("   ", policy);
		expect(result).toEqual({ type: "input_text", text: "   " });
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("returns plain input_text when text is empty", () => {
		const policy = { stablePrefixBreakpoint: { mode: "explicit" as const }, promptCacheRetention: undefined };
		const result = formatOpenAIInputText("", policy);
		expect(result).toEqual({ type: "input_text", text: "" });
	});
	it("attaches breakpoint when text has content and policy has breakpoint", () => {
		const policy = { stablePrefixBreakpoint: { mode: "explicit" as const }, promptCacheRetention: undefined };
		const result = formatOpenAIInputText("hello world", policy);
		expect(result.type).toBe("input_text");
		expect(result.text).toBe("hello world");
		expect(result.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
	});
	it("uses default disabled policy when no policy provided", () => {
		const result = formatOpenAIInputText("hello");
		expect(result).toEqual({ type: "input_text", text: "hello" });
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("attaches breakpoint for text with leading whitespace and content", () => {
		const policy = { stablePrefixBreakpoint: { mode: "explicit" as const }, promptCacheRetention: undefined };
		const result = formatOpenAIInputText("  hello  ", policy);
		expect(result.prompt_cache_breakpoint).toBeDefined();
	});
});
