import { describe, expect, it } from "bun:test";
import {
	formatOpenAIInputText,
	isOfficialOpenAIResponsesEndpoint,
	OPENAI_PROMPT_CACHE_DISABLED,
	type OpenAIPromptCachePolicy,
	resolveOpenAIPromptCachePolicy,
} from "../src/providers/openai-prompt-cache";
import type { Model } from "../src/types";

function makeModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-4o",
		provider: "openai",
		api: "openai-responses",
		compat: { supportsLongPromptCacheRetention: false },
		...overrides,
	} as unknown as Model<"openai-responses">;
}

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

describe("isOfficialOpenAIResponsesEndpoint", () => {
	it("returns true for openai provider with no baseUrl", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: undefined }))).toBe(true);
	});
	it("returns true for api.openai.com baseUrl", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "https://api.openai.com/v1" }))).toBe(true);
	});
	it("returns false for non-openai provider", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ provider: "other" }))).toBe(false);
	});
	it("returns false for non-openai.com baseUrl", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "https://custom.example.com/v1" }))).toBe(false);
	});
	it("returns false for invalid URL baseUrl", () => {
		expect(isOfficialOpenAIResponsesEndpoint(makeModel({ baseUrl: "not-a-url" }))).toBe(false);
	});
});

describe("resolveOpenAIPromptCachePolicy", () => {
	it("returns disabled policy when no promptCacheKey", () => {
		const result = resolveOpenAIPromptCachePolicy({ model: makeModel(), promptCacheKey: undefined });
		expect(result.stablePrefixBreakpoint).toBeUndefined();
		expect(result.promptCacheRetention).toBeUndefined();
	});
	it("returns disabled policy when no cacheRetention", () => {
		const result = resolveOpenAIPromptCachePolicy({ model: makeModel(), promptCacheKey: "key" });
		expect(result.stablePrefixBreakpoint).toBeUndefined();
		expect(result.promptCacheRetention).toBeUndefined();
	});
});

describe("formatOpenAIInputText", () => {
	it("returns plain input_text for empty text", () => {
		const result = formatOpenAIInputText("");
		expect(result.type).toBe("input_text");
		expect(result.text).toBe("");
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("returns plain input_text for whitespace-only text", () => {
		const result = formatOpenAIInputText("   ");
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("returns plain input_text with disabled policy", () => {
		const result = formatOpenAIInputText("hello", OPENAI_PROMPT_CACHE_DISABLED);
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("attaches breakpoint when policy has one and text has content", () => {
		const policy: OpenAIPromptCachePolicy = {
			stablePrefixBreakpoint: { mode: "explicit" },
			promptCacheRetention: undefined,
		};
		const result = formatOpenAIInputText("hello", policy);
		expect(result.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
	});
	it("does not attach breakpoint for whitespace-only text even with policy", () => {
		const policy: OpenAIPromptCachePolicy = {
			stablePrefixBreakpoint: { mode: "explicit" },
			promptCacheRetention: undefined,
		};
		const result = formatOpenAIInputText("   ", policy);
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
	it("defaults to disabled policy when no policy provided", () => {
		const result = formatOpenAIInputText("hello");
		expect(result.prompt_cache_breakpoint).toBeUndefined();
	});
});
