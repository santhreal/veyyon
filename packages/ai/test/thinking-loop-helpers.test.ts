import { describe, expect, it } from "bun:test";
import type { Api, Model } from "../src/types";
import {
	detectDegenerateRepetition,
	GEMINI_HEADER_RUNAWAY_THRESHOLD,
	isGeminiThinkingModel,
	isLoopGuardEnabled,
	isReasoningSummaryHeader,
	THINKING_LOOP_ERROR_MARKER,
} from "../src/utils/thinking-loop";

function model(provider: string, id: string, api: Api = "google-genai"): Model {
	return { provider, id, api } as unknown as Model;
}

describe("THINKING_LOOP_ERROR_MARKER", () => {
	it("is 'Thinking loop detected'", () => {
		expect(THINKING_LOOP_ERROR_MARKER).toBe("Thinking loop detected");
	});
});

describe("GEMINI_HEADER_RUNAWAY_THRESHOLD", () => {
	it("is 24", () => {
		expect(GEMINI_HEADER_RUNAWAY_THRESHOLD).toBe(24);
	});
});

describe("isGeminiThinkingModel", () => {
	it("returns true for google provider with gemini model id", () => {
		expect(isGeminiThinkingModel(model("google", "gemini-1.5-pro"))).toBe(true);
	});
	it("returns true for provider with gemini in name", () => {
		expect(isGeminiThinkingModel(model("google-vertex", "gemini-2.0-flash"))).toBe(true);
	});
	it("returns false for non-gemini model", () => {
		expect(isGeminiThinkingModel(model("openai", "gpt-4"))).toBe(false);
	});
	it("returns false for anthropic model", () => {
		expect(isGeminiThinkingModel(model("anthropic", "claude-3", "anthropic-messages"))).toBe(false);
	});
	it("returns true for openai-completions with compat flag", () => {
		const m = {
			provider: "openai",
			id: "gpt-4",
			api: "openai-completions",
			compat: { enableGeminiThinkingLoopGuard: true },
		} as unknown as Model;
		expect(isGeminiThinkingModel(m)).toBe(true);
	});
	it("returns false for openai-completions without compat flag", () => {
		const m = {
			provider: "openai",
			id: "gpt-4",
			api: "openai-completions",
			compat: {},
		} as unknown as Model;
		expect(isGeminiThinkingModel(m)).toBe(false);
	});
	it("returns false for openai-completions with compat flag false", () => {
		const m = {
			provider: "openai",
			id: "gpt-4",
			api: "openai-completions",
			compat: { enableGeminiThinkingLoopGuard: false },
		} as unknown as Model;
		expect(isGeminiThinkingModel(m)).toBe(false);
	});
});

describe("isLoopGuardEnabled", () => {
	it("returns true for undefined options", () => {
		expect(isLoopGuardEnabled(undefined)).toBe(true);
	});
	it("returns true when loopGuard is undefined", () => {
		expect(isLoopGuardEnabled({})).toBe(true);
	});
	it("returns true when loopGuard.enabled is true", () => {
		expect(isLoopGuardEnabled({ loopGuard: { enabled: true } })).toBe(true);
	});
	it("returns false when loopGuard.enabled is false", () => {
		expect(isLoopGuardEnabled({ loopGuard: { enabled: false } })).toBe(false);
	});
});

describe("detectDegenerateRepetition", () => {
	it("returns null for short text", () => {
		expect(detectDegenerateRepetition("hello")).toBeNull();
	});
	it("returns null for normal text", () => {
		expect(detectDegenerateRepetition("The quick brown fox jumps over the lazy dog.")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(detectDegenerateRepetition("")).toBeNull();
	});
	it("detects repeated unit", () => {
		const repeated = "hello world ".repeat(20);
		const result = detectDegenerateRepetition(repeated);
		expect(result).not.toBeNull();
		expect(result).toContain("repeated");
		expect(result).toContain("×");
	});
	it("detects single character repetition", () => {
		const result = detectDegenerateRepetition("a".repeat(200));
		// Single char 'a' has no letter content per VERBATIM_UNIT_CONTENT? Actually \p{L} matches 'a'
		expect(result).not.toBeNull();
	});
	it("does not detect repetition in diverse text", () => {
		const diverse = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ";
		expect(detectDegenerateRepetition(diverse)).toBeNull();
	});
});

describe("isReasoningSummaryHeader", () => {
	it("returns true for markdown heading", () => {
		expect(isReasoningSummaryHeader("## Heading")).toBe(true);
	});
	it("returns true for h1", () => {
		expect(isReasoningSummaryHeader("# Title")).toBe(true);
	});
	it("returns true for h6", () => {
		expect(isReasoningSummaryHeader("###### Deep")).toBe(true);
	});
	it("returns true for bold with asterisks", () => {
		expect(isReasoningSummaryHeader("**bold text**")).toBe(true);
	});
	it("returns true for triple asterisks", () => {
		expect(isReasoningSummaryHeader("***bold italic***")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(isReasoningSummaryHeader("just text")).toBe(false);
	});
	it("returns false for heading without space after #", () => {
		expect(isReasoningSummaryHeader("##NoSpace")).toBe(false);
	});
	it("returns false for single asterisk", () => {
		expect(isReasoningSummaryHeader("*italic*")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isReasoningSummaryHeader("")).toBe(false);
	});
	it("returns false for heading with only spaces after #", () => {
		expect(isReasoningSummaryHeader("##   ")).toBe(false);
	});
	it("returns true for heading with tab after #", () => {
		expect(isReasoningSummaryHeader("##\tHeading")).toBe(true);
	});
});
