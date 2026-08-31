import { describe, expect, it } from "bun:test";
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
	it("returns id as-is when no slash", () => {
		expect(bareModelId("gpt-4o")).toBe("gpt-4o");
	});
	it("strips provider prefix", () => {
		expect(bareModelId("openai/gpt-4o")).toBe("gpt-4o");
	});
	it("strips nested prefix", () => {
		expect(bareModelId("openai/v1/gpt-4o")).toBe("gpt-4o");
	});
	it("handles trailing slash", () => {
		expect(bareModelId("openai/")).toBe("");
	});
	it("handles empty string", () => {
		expect(bareModelId("")).toBe("");
	});
	it("caches results", () => {
		// Multiple calls should return same value
		const r1 = bareModelId("test/model-id");
		const r2 = bareModelId("test/model-id");
		expect(r1).toBe(r2);
	});
});

describe("parseGeminiModel", () => {
	it("parses gemini-1.5-pro", () => {
		const result = parseGeminiModel("gemini-1.5-pro");
		expect(result).not.toBeNull();
		expect(result?.family).toBe("gemini");
		expect(result?.kind).toBe("pro");
	});
	it("parses gemini-2.0-flash", () => {
		const result = parseGeminiModel("gemini-2.0-flash");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("flash");
	});
	it("parses gemini-2.5-pro-preview", () => {
		const result = parseGeminiModel("gemini-2.5-pro-preview");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("pro");
	});
	it("returns null for non-gemini model", () => {
		expect(parseGeminiModel("gpt-4o")).toBeNull();
	});
	it("returns null for invalid version", () => {
		expect(parseGeminiModel("gemini-abc-pro")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseGeminiModel("")).toBeNull();
	});
	it("is case insensitive", () => {
		const result = parseGeminiModel("GEMINI-1.5-PRO");
		expect(result).not.toBeNull();
	});
});

describe("parseAnthropicModel", () => {
	it("parses claude-opus-4-1 (kind first)", () => {
		const result = parseAnthropicModel("claude-opus-4-1");
		expect(result).not.toBeNull();
		expect(result?.family).toBe("anthropic");
		expect(result?.kind).toBe("opus");
	});
	it("parses claude-sonnet-4-5 (kind first)", () => {
		const result = parseAnthropicModel("claude-sonnet-4-5");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("sonnet");
	});
	it("parses claude-3-5-sonnet (version first)", () => {
		const result = parseAnthropicModel("claude-3-5-sonnet");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("sonnet");
	});
	it("parses claude-3-opus (version first)", () => {
		const result = parseAnthropicModel("claude-3-opus");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("opus");
	});
	it("returns null for non-claude model", () => {
		expect(parseAnthropicModel("gpt-4o")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseAnthropicModel("")).toBeNull();
	});
	it("parses fable kind", () => {
		const result = parseAnthropicModel("claude-fable-4-6");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("fable");
	});
	it("parses mythos kind", () => {
		const result = parseAnthropicModel("claude-mythos-4-6");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("mythos");
	});
});

describe("parseOpenAIModel", () => {
	it("parses gpt-4.0", () => {
		const result = parseOpenAIModel("gpt-4.0");
		expect(result).not.toBeNull();
		expect(result?.family).toBe("openai");
		expect(result?.variant).toBe("base");
	});
	it("parses gpt-4.1", () => {
		const result = parseOpenAIModel("gpt-4.1");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("base");
	});
	it("parses gpt-5.6-codex", () => {
		const result = parseOpenAIModel("gpt-5.6-codex");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("codex");
	});
	it("parses gpt-4.0-mini", () => {
		const result = parseOpenAIModel("gpt-4.0-mini");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("mini");
	});
	it("parses gpt-5.6-codex-max", () => {
		const result = parseOpenAIModel("gpt-5.6-codex-max");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("codex-max");
	});
	it("returns null for non-gpt model", () => {
		expect(parseOpenAIModel("claude-3-opus")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseOpenAIModel("")).toBeNull();
	});
});

describe("parseGlmModel", () => {
	it("parses glm-4.5", () => {
		const result = parseGlmModel("glm-4.5");
		expect(result).not.toBeNull();
		expect(result?.family).toBe("glm");
		expect(result?.variant).toBe("base");
	});
	it("parses glm-4.5-air", () => {
		const result = parseGlmModel("glm-4.5-air");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("air");
	});
	it("parses glm-4.5v as vision", () => {
		const result = parseGlmModel("glm-4.5v");
		expect(result).not.toBeNull();
		expect(result?.vision).toBe(true);
	});
	it("parses glm-4.5-flash", () => {
		const result = parseGlmModel("glm-4.5-flash");
		expect(result).not.toBeNull();
		expect(result?.variant).toBe("flash");
	});
	it("returns null for non-glm model", () => {
		expect(parseGlmModel("gpt-4o")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseGlmModel("")).toBeNull();
	});
});

describe("parseKnownModel", () => {
	it("parses gemini model", () => {
		const result = parseKnownModel("gemini-1.5-pro");
		expect(result.family).toBe("gemini");
	});
	it("parses anthropic model", () => {
		const result = parseKnownModel("claude-opus-4-1");
		expect(result.family).toBe("anthropic");
	});
	it("parses openai model", () => {
		const result = parseKnownModel("gpt-4.0");
		expect(result.family).toBe("openai");
	});
	it("returns unknown for unrecognized model", () => {
		const result = parseKnownModel("unknown-model");
		expect(result.family).toBe("unknown");
	});
	it("strips provider prefix before parsing", () => {
		const result = parseKnownModel("openai/gpt-4.0");
		expect(result.family).toBe("openai");
	});
});

describe("isFableOrMythos", () => {
	it("returns true for fable", () => {
		expect(isFableOrMythos("fable")).toBe(true);
	});
	it("returns true for mythos", () => {
		expect(isFableOrMythos("mythos")).toBe(true);
	});
	it("returns false for opus", () => {
		expect(isFableOrMythos("opus")).toBe(false);
	});
	it("returns false for sonnet", () => {
		expect(isFableOrMythos("sonnet")).toBe(false);
	});
});

describe("isAnthropicAdaptiveGenAtLeast", () => {
	it("returns true for opus >= 4.6", () => {
		const model = parseAnthropicModel("claude-opus-4-6")!;
		expect(isAnthropicAdaptiveGenAtLeast(model, "4.6")).toBe(true);
	});
	it("returns false for opus < 4.6", () => {
		const model = parseAnthropicModel("claude-opus-4-5")!;
		expect(isAnthropicAdaptiveGenAtLeast(model, "4.6")).toBe(false);
	});
	it("returns true for sonnet >= 5", () => {
		const model = parseAnthropicModel("claude-sonnet-5-0")!;
		expect(isAnthropicAdaptiveGenAtLeast(model, "4.6")).toBe(true);
	});
	it("returns false for sonnet < 5", () => {
		const model = parseAnthropicModel("claude-sonnet-4-5")!;
		expect(isAnthropicAdaptiveGenAtLeast(model, "4.6")).toBe(false);
	});
});

describe("semverGte", () => {
	it("returns true for equal versions", () => {
		expect(semverGte("1.0", "1.0")).toBe(true);
	});
	it("returns true for greater version", () => {
		expect(semverGte("2.0", "1.0")).toBe(true);
	});
	it("returns false for lesser version", () => {
		expect(semverGte("1.0", "2.0")).toBe(false);
	});
	it("compares minor versions", () => {
		expect(semverGte("1.1", "1.0")).toBe(true);
		expect(semverGte("1.0", "1.1")).toBe(false);
	});
});

describe("semverEqual", () => {
	it("returns true for equal versions", () => {
		expect(semverEqual("1.0", "1.0")).toBe(true);
	});
	it("returns false for different versions", () => {
		expect(semverEqual("1.0", "2.0")).toBe(false);
	});
	it("returns false for different minor", () => {
		expect(semverEqual("1.0", "1.1")).toBe(false);
	});
});
