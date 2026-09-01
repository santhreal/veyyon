import { describe, expect, it } from "bun:test";
import type { AnthropicKind } from "../src/identity/classify";
import {
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseAnthropicModel,
	parseGeminiModel,
	parseGlmModel,
	parseKnownModel,
	parseOpenAIModel,
	semverEqual,
	semverGte,
} from "../src/identity/classify";

describe("bareModelId", () => {
	it("returns the part after the last slash", () => {
		expect(bareModelId("accounts/fireworks/models/llama-v3p1-405b")).toBe("llama-v3p1-405b");
	});

	it("returns the full string when no slash", () => {
		expect(bareModelId("gpt-4")).toBe("gpt-4");
	});

	it("handles trailing slash", () => {
		expect(bareModelId("prefix/")).toBe("");
	});

	it("handles multiple slashes", () => {
		expect(bareModelId("a/b/c/d")).toBe("d");
	});

	it("caches results", () => {
		// Call twice, should return same cached result
		const r1 = bareModelId("test/path/model");
		const r2 = bareModelId("test/path/model");
		expect(r1).toBe("model");
		expect(r2).toBe("model");
	});
});

describe("parseGeminiModel", () => {
	it("parses gemini-pro", () => {
		const result = parseGeminiModel("gemini-1.5-pro");
		expect(result).not.toBeNull();
		expect(result!.family).toBe("gemini");
		expect(result!.kind).toBe("pro");
	});

	it("parses gemini-flash", () => {
		const result = parseGeminiModel("gemini-2.0-flash");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("flash");
	});

	it("parses gemini with -preview suffix", () => {
		const result = parseGeminiModel("gemini-2.5-pro-preview");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("pro");
	});

	it("returns null for non-gemini model", () => {
		expect(parseGeminiModel("gpt-4")).toBeNull();
	});

	it("returns null for invalid version", () => {
		expect(parseGeminiModel("gemini-abc-pro")).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = parseGeminiModel("GEMINI-1.5-PRO");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("pro");
	});
});

describe("parseAnthropicModel", () => {
	it("parses claude-sonnet with kind first", () => {
		const result = parseAnthropicModel("claude-sonnet-4");
		expect(result).not.toBeNull();
		expect(result!.family).toBe("anthropic");
		expect(result!.kind).toBe("sonnet");
	});

	it("parses claude-opus with kind first", () => {
		const result = parseAnthropicModel("claude-opus-4.6");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("opus");
	});

	it("parses claude with version first", () => {
		const result = parseAnthropicModel("claude-3.5-sonnet");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("sonnet");
	});

	it("parses claude fable", () => {
		const result = parseAnthropicModel("claude-fable-4");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("fable");
	});

	it("parses claude mythos", () => {
		const result = parseAnthropicModel("claude-mythos-4");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("mythos");
	});

	it("returns null for non-claude model", () => {
		expect(parseAnthropicModel("gpt-4")).toBeNull();
	});

	it("parses gpt-4.1-mini", () => {
		const result = parseOpenAIModel("gpt-4.1-mini");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("mini");
	});
	it("is case-insensitive", () => {
		const result = parseAnthropicModel("CLAUDE-SONNET-4");
		expect(result).not.toBeNull();
		expect(result!.kind).toBe("sonnet");
	});
});

describe("parseOpenAIModel", () => {
	it("parses gpt-4 base", () => {
		const result = parseOpenAIModel("gpt-4");
		expect(result).not.toBeNull();
		expect(result!.family).toBe("openai");
		expect(result!.variant).toBe("base");
	});

	it("parses gpt-4-mini", () => {
		const result = parseOpenAIModel("gpt-4-mini");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("mini");
	});

	it("parses gpt-5-codex", () => {
		const result = parseOpenAIModel("gpt-5-codex");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("codex");
	});

	it("parses gpt-5-codex-max", () => {
		const result = parseOpenAIModel("gpt-5-codex-max");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("codex-max");
	});

	it("parses gpt-5-codex-mini", () => {
		const result = parseOpenAIModel("gpt-5-codex-mini");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("codex-mini");
	});

	it("parses gpt-5-nano", () => {
		const result = parseOpenAIModel("gpt-5-nano");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("nano");
	});

	it("returns null for non-gpt model", () => {
		expect(parseOpenAIModel("claude-4")).toBeNull();
	});

	it("returns null for invalid version", () => {
		expect(parseOpenAIModel("gpt-abc")).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = parseOpenAIModel("GPT-4");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("base");
	});
});

describe("parseGlmModel", () => {
	it("parses glm-4 base", () => {
		const result = parseGlmModel("glm-4");
		expect(result).not.toBeNull();
		expect(result!.family).toBe("glm");
		expect(result!.variant).toBe("base");
		expect(result!.vision).toBe(false);
	});

	it("parses glm-4v with vision", () => {
		const result = parseGlmModel("glm-4v");
		expect(result).not.toBeNull();
		expect(result!.vision).toBe(true);
	});

	it("parses glm-4-air", () => {
		const result = parseGlmModel("glm-4-air");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("air");
	});

	it("parses glm-4-flash", () => {
		const result = parseGlmModel("glm-4-flash");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("flash");
	});

	it("parses glm-4-flashx", () => {
		const result = parseGlmModel("glm-4-flashx");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("flashx");
	});

	it("parses glm-4.5-preview", () => {
		const result = parseGlmModel("glm-4.5-preview");
		expect(result).not.toBeNull();
		expect(result!.variant).toBe("preview");
	});

	it("parses glm-4.5v-turbo", () => {
		const result = parseGlmModel("glm-4.5v-turbo");
		expect(result).not.toBeNull();
		expect(result!.vision).toBe(true);
		expect(result!.variant).toBe("turbo");
	});

	it("returns null for non-glm model", () => {
		expect(parseGlmModel("gpt-4")).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = parseGlmModel("GLM-4");
		expect(result).not.toBeNull();
		expect(result!.family).toBe("glm");
	});
});

describe("parseKnownModel", () => {
	it("parses a gemini model from full path", () => {
		const result = parseKnownModel("google/gemini-2.0-flash");
		expect(result.family).toBe("gemini");
	});

	it("parses a claude model from full path", () => {
		const result = parseKnownModel("anthropic/claude-sonnet-4");
		expect(result.family).toBe("anthropic");
	});

	it("parses a gpt model from bare id", () => {
		const result = parseKnownModel("gpt-4");
		expect(result.family).toBe("openai");
	});

	it("returns unknown for unrecognized model", () => {
		const result = parseKnownModel("some-unknown-model");
		expect(result.family).toBe("unknown");
	});

	it("returns unknown for empty string", () => {
		const result = parseKnownModel("");
		expect(result.family).toBe("unknown");
	});
});

describe("isFableOrMythos", () => {
	it("returns true for fable", () => {
		expect(isFableOrMythos("fable" as AnthropicKind)).toBe(true);
	});

	it("returns true for mythos", () => {
		expect(isFableOrMythos("mythos" as AnthropicKind)).toBe(true);
	});

	it("returns false for opus", () => {
		expect(isFableOrMythos("opus" as AnthropicKind)).toBe(false);
	});

	it("returns false for sonnet", () => {
		expect(isFableOrMythos("sonnet" as AnthropicKind)).toBe(false);
	});
});

describe("isAnthropicAdaptiveGenAtLeast", () => {
	it("returns true for opus at 4.6 when min is 4.6", () => {
		const parsed = parseAnthropicModel("claude-opus-4.6");
		expect(parsed).not.toBeNull();
		expect(isAnthropicAdaptiveGenAtLeast(parsed!, "4.6")).toBe(true);
	});

	it("returns false for opus below 4.6 when min is 4.6", () => {
		const parsed = parseAnthropicModel("claude-opus-4");
		expect(parsed).not.toBeNull();
		expect(isAnthropicAdaptiveGenAtLeast(parsed!, "4.6")).toBe(false);
	});

	it("returns true for sonnet at 5 when min opus is 4.6", () => {
		const parsed = parseAnthropicModel("claude-sonnet-5");
		expect(parsed).not.toBeNull();
		expect(isAnthropicAdaptiveGenAtLeast(parsed!, "4.6")).toBe(true);
	});

	it("returns false for sonnet below 5 when min opus is 4.6", () => {
		const parsed = parseAnthropicModel("claude-sonnet-4");
		expect(parsed).not.toBeNull();
		expect(isAnthropicAdaptiveGenAtLeast(parsed!, "4.6")).toBe(false);
	});
});

describe("semverGte", () => {
	it("returns true for equal versions", () => {
		expect(semverGte("4.5", "4.5")).toBe(true);
	});

	it("returns true for greater version", () => {
		expect(semverGte("4.6", "4.5")).toBe(true);
	});

	it("returns false for lesser version", () => {
		expect(semverGte("4.4", "4.5")).toBe(false);
	});

	it("compares major versions", () => {
		expect(semverGte("5", "4.9")).toBe(true);
		expect(semverGte("3", "4")).toBe(false);
	});

	it("handles SemVer objects", () => {
		expect(semverGte({ major: 4, minor: 5, patch: 0 }, { major: 4, minor: 5, patch: 0 })).toBe(true);
		expect(semverGte({ major: 4, minor: 6, patch: 0 }, { major: 4, minor: 5, patch: 0 })).toBe(true);
	});

	it("handles mixed string and object", () => {
		expect(semverGte("4.5", { major: 4, minor: 4, patch: 0 })).toBe(true);
		expect(semverGte({ major: 4, minor: 4, patch: 0 }, "4.5")).toBe(false);
	});

	it("handles hyphen-separated versions", () => {
		expect(semverGte("3-5", "3.5")).toBe(true);
	});
});

describe("semverEqual", () => {
	it("returns true for equal versions", () => {
		expect(semverEqual("4.5", "4.5")).toBe(true);
	});

	it("returns false for different minor", () => {
		expect(semverEqual("4.5", "4.6")).toBe(false);
	});

	it("returns false for different major", () => {
		expect(semverEqual("4.5", "5.5")).toBe(false);
	});

	it("handles SemVer objects", () => {
		expect(semverEqual({ major: 4, minor: 5, patch: 0 }, { major: 4, minor: 5, patch: 0 })).toBe(true);
	});

	it("handles hyphen and dot equivalence", () => {
		expect(semverEqual("3-5", "3.5")).toBe(true);
	});
});
