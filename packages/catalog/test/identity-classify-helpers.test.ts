import { describe, expect, it } from "bun:test";
import {
	type AnthropicKind,
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseAnthropicModel,
	parseGeminiModel,
	parseGlmModel,
	parseKnownModel,
	parseOpenAIModel,
	type SemVer,
	semverEqual,
	semverGte,
} from "../src/identity/classify";

describe("bareModelId", () => {
	it("returns full id when no slash", () => {
		expect(bareModelId("gpt-4")).toBe("gpt-4");
	});
	it("strips provider prefix", () => {
		expect(bareModelId("openai/gpt-4")).toBe("gpt-4");
	});
	it("strips nested prefix", () => {
		expect(bareModelId("provider/org/gpt-4")).toBe("gpt-4");
	});
	it("handles trailing slash", () => {
		expect(bareModelId("provider/")).toBe("");
	});
	it("caches results", () => {
		expect(bareModelId("openai/gpt-4")).toBe("gpt-4");
		expect(bareModelId("openai/gpt-4")).toBe("gpt-4");
	});
});

describe("parseGeminiModel", () => {
	it("parses gemini-1.5-pro", () => {
		const result = parseGeminiModel("gemini-1.5-pro");
		expect(result).not.toBeNull();
		expect(result?.family).toBe("gemini");
		expect(result?.kind).toBe("pro");
		expect(result?.version.major).toBe(1);
		expect(result?.version.minor).toBe(5);
	});
	it("parses gemini-2.0-flash", () => {
		const result = parseGeminiModel("gemini-2.0-flash");
		expect(result?.kind).toBe("flash");
		expect(result?.version.major).toBe(2);
	});
	it("parses gemini-2.5-pro-preview", () => {
		const result = parseGeminiModel("gemini-2.5-pro-preview");
		expect(result?.kind).toBe("pro");
		expect(result?.version.major).toBe(2);
		expect(result?.version.minor).toBe(5);
	});
	it("returns null for non-gemini", () => {
		expect(parseGeminiModel("gpt-4")).toBeNull();
	});
	it("returns null for missing kind", () => {
		expect(parseGeminiModel("gemini-1.5")).toBeNull();
	});
	it("returns null for invalid version", () => {
		expect(parseGeminiModel("gemini-99.99-pro")).toBeNull();
	});
	it("is case insensitive", () => {
		const result = parseGeminiModel("GEMINI-1.5-PRO");
		expect(result?.kind).toBe("pro");
	});
});

describe("parseAnthropicModel", () => {
	it("parses claude-opus-4.7 (kind first)", () => {
		const result = parseAnthropicModel("claude-opus-4.7");
		expect(result?.family).toBe("anthropic");
		expect(result?.kind).toBe("opus");
		expect(result?.version.major).toBe(4);
		expect(result?.version.minor).toBe(7);
	});
	it("parses claude-sonnet-4.5", () => {
		const result = parseAnthropicModel("claude-sonnet-4.5");
		expect(result?.kind).toBe("sonnet");
	});
	it("parses claude-3.5-sonnet (version first)", () => {
		const result = parseAnthropicModel("claude-3.5-sonnet");
		expect(result?.kind).toBe("sonnet");
		expect(result?.version.major).toBe(3);
		expect(result?.version.minor).toBe(5);
	});
	it("parses claude-3-7-sonnet with dash separators", () => {
		const result = parseAnthropicModel("claude-3-7-sonnet");
		expect(result?.kind).toBe("sonnet");
		expect(result?.version.major).toBe(3);
		expect(result?.version.minor).toBe(7);
	});
	it("parses fable kind", () => {
		const result = parseAnthropicModel("claude-fable-1.0");
		expect(result?.kind).toBe("fable");
	});
	it("parses mythos kind", () => {
		const result = parseAnthropicModel("claude-mythos-1.0");
		expect(result?.kind).toBe("mythos");
	});
	it("returns null for non-claude", () => {
		expect(parseAnthropicModel("gpt-4")).toBeNull();
	});
	it("returns null for missing version", () => {
		expect(parseAnthropicModel("claude-opus")).toBeNull();
	});
	it("returns null for invalid version", () => {
		expect(parseAnthropicModel("claude-opus-99")).toBeNull();
	});
});

describe("parseOpenAIModel", () => {
	it("parses gpt-4", () => {
		const result = parseOpenAIModel("gpt-4");
		expect(result?.family).toBe("openai");
		expect(result?.variant).toBe("base");
		expect(result?.version.major).toBe(4);
	});
	it("parses gpt-4.1", () => {
		const result = parseOpenAIModel("gpt-4.1");
		expect(result?.version.major).toBe(4);
		expect(result?.version.minor).toBe(1);
	});
	it("parses gpt-5-codex", () => {
		const result = parseOpenAIModel("gpt-5-codex");
		expect(result?.variant).toBe("codex");
	});
	it("parses gpt-5-codex-max", () => {
		const result = parseOpenAIModel("gpt-5-codex-max");
		expect(result?.variant).toBe("codex-max");
	});
	it("parses gpt-5-codex-mini", () => {
		const result = parseOpenAIModel("gpt-5-codex-mini");
		expect(result?.variant).toBe("codex-mini");
	});
	it("parses gpt-5-codex-spark", () => {
		const result = parseOpenAIModel("gpt-5-codex-spark");
		expect(result?.variant).toBe("codex-spark");
	});
	it("parses gpt-4-mini", () => {
		const result = parseOpenAIModel("gpt-4-mini");
		expect(result?.variant).toBe("mini");
	});
	it("parses gpt-4-max", () => {
		const result = parseOpenAIModel("gpt-4-max");
		expect(result?.variant).toBe("max");
	});
	it("parses gpt-4-nano", () => {
		const result = parseOpenAIModel("gpt-4-nano");
		expect(result?.variant).toBe("nano");
	});
	it("returns null for non-gpt", () => {
		expect(parseOpenAIModel("claude-4")).toBeNull();
	});
	it("returns null for missing version", () => {
		expect(parseOpenAIModel("gpt-codex")).toBeNull();
	});
	it("returns null for invalid version", () => {
		expect(parseOpenAIModel("gpt-99")).toBeNull();
	});
});

describe("parseGlmModel", () => {
	it("parses glm-4.5", () => {
		const result = parseGlmModel("glm-4.5");
		expect(result?.family).toBe("glm");
		expect(result?.variant).toBe("base");
		expect(result?.vision).toBe(false);
		expect(result?.version.major).toBe(4);
		expect(result?.version.minor).toBe(5);
	});
	it("parses glm-4.5v as vision", () => {
		const result = parseGlmModel("glm-4.5v");
		expect(result?.vision).toBe(true);
	});
	it("parses glm-4.5-air", () => {
		const result = parseGlmModel("glm-4.5-air");
		expect(result?.variant).toBe("air");
	});
	it("parses glm-4.5-turbo", () => {
		const result = parseGlmModel("glm-4.5-turbo");
		expect(result?.variant).toBe("turbo");
	});
	it("parses glm-4.5-flash", () => {
		const result = parseGlmModel("glm-4.5-flash");
		expect(result?.variant).toBe("flash");
	});
	it("parses glm-4.5-flashx", () => {
		const result = parseGlmModel("glm-4.5-flashx");
		expect(result?.variant).toBe("flashx");
	});
	it("parses glm-4.5-preview", () => {
		const result = parseGlmModel("glm-4.5-preview");
		expect(result?.variant).toBe("preview");
	});
	it("parses glm-4v as vision base", () => {
		const result = parseGlmModel("glm-4v");
		expect(result?.vision).toBe(true);
		expect(result?.variant).toBe("base");
	});
	it("returns null for non-glm", () => {
		expect(parseGlmModel("gpt-4")).toBeNull();
	});
	it("returns null for invalid version", () => {
		expect(parseGlmModel("glm-99")).toBeNull();
	});
});

describe("parseKnownModel", () => {
	it("parses gemini model", () => {
		const result = parseKnownModel("gemini-1.5-pro");
		expect(result.family).toBe("gemini");
	});
	it("parses anthropic model", () => {
		const result = parseKnownModel("claude-opus-4.7");
		expect(result.family).toBe("anthropic");
	});
	it("parses openai model", () => {
		const result = parseKnownModel("gpt-4");
		expect(result.family).toBe("openai");
	});
	it("returns unknown for unrecognized", () => {
		const result = parseKnownModel("unknown-model");
		expect(result.family).toBe("unknown");
	});
	it("strips provider prefix before parsing", () => {
		const result = parseKnownModel("openai/gpt-4");
		expect(result.family).toBe("openai");
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
	it("opus 4.7 >= 4.7 is true", () => {
		const parsed = parseAnthropicModel("claude-opus-4.7");
		expect(parsed).not.toBeNull();
		if (parsed) expect(isAnthropicAdaptiveGenAtLeast(parsed, "4.7")).toBe(true);
	});
	it("opus 4.6 >= 4.7 is false", () => {
		const parsed = parseAnthropicModel("claude-opus-4.6");
		expect(parsed).not.toBeNull();
		if (parsed) expect(isAnthropicAdaptiveGenAtLeast(parsed, "4.7")).toBe(false);
	});
	it("sonnet 5.0 >= 4.7 is true (non-opus uses 5 threshold)", () => {
		const parsed = parseAnthropicModel("claude-sonnet-5.0");
		expect(parsed).not.toBeNull();
		if (parsed) expect(isAnthropicAdaptiveGenAtLeast(parsed, "4.7")).toBe(true);
	});
	it("sonnet 4.5 >= 4.7 is false (non-opus uses 5 threshold)", () => {
		const parsed = parseAnthropicModel("claude-sonnet-4.5");
		expect(parsed).not.toBeNull();
		if (parsed) expect(isAnthropicAdaptiveGenAtLeast(parsed, "4.7")).toBe(false);
	});
	it("opus 4.8 >= 4.8 is true", () => {
		const parsed = parseAnthropicModel("claude-opus-4.8");
		expect(parsed).not.toBeNull();
		if (parsed) expect(isAnthropicAdaptiveGenAtLeast(parsed, "4.8")).toBe(true);
	});
});

describe("semverGte", () => {
	it("4.7 >= 4.5 is true", () => {
		expect(semverGte("4.7", "4.5")).toBe(true);
	});
	it("4.5 >= 4.7 is false", () => {
		expect(semverGte("4.5", "4.7")).toBe(false);
	});
	it("5.0 >= 4.7 is true", () => {
		expect(semverGte("5.0", "4.7")).toBe(true);
	});
	it("4.7 >= 4.7 is true", () => {
		expect(semverGte("4.7", "4.7")).toBe(true);
	});
	it("3.5 >= 4.0 is false", () => {
		expect(semverGte("3.5", "4.0")).toBe(false);
	});
	it("accepts SemVer objects", () => {
		const v: SemVer = { major: 5, minor: 0, patch: 0 };
		expect(semverGte(v, "4.7")).toBe(true);
	});
	it("handles null left as false", () => {
		expect(semverGte("99.99" as unknown as string, "4.7")).toBe(false);
	});
});

describe("semverEqual", () => {
	it("4.7 == 4.7 is true", () => {
		expect(semverEqual("4.7", "4.7")).toBe(true);
	});
	it("4.7 == 4.5 is false", () => {
		expect(semverEqual("4.7", "4.5")).toBe(false);
	});
	it("5.0 == 5 is true (normalization)", () => {
		expect(semverEqual("5.0", "5")).toBe(true);
	});
	it("accepts SemVer objects", () => {
		const v: SemVer = { major: 4, minor: 7, patch: 0 };
		expect(semverEqual(v, "4.7")).toBe(true);
	});
});
