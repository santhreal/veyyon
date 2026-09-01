import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";
import {
	cleanModelName,
	discoveryFetch,
	isAnthropicOAuthToken,
	toArray,
	toBoolean,
	toFields,
	toFiniteNumber,
	toNonEmptyString,
	toNumber,
	toPositiveNumber,
	toStringArray,
	toStringValue,
} from "../src/utils";
import { stripEffortTierSuffix } from "../src/variant-collapse";

describe("isEffort", () => {
	it("returns true for each effort level", () => {
		for (const effort of THINKING_EFFORTS) {
			expect(isEffort(effort)).toBe(true);
		}
	});

	it("returns false for non-string", () => {
		expect(isEffort(42)).toBe(false);
		expect(isEffort(null)).toBe(false);
		expect(isEffort(undefined)).toBe(false);
		expect(isEffort(true)).toBe(false);
	});

	it("returns false for invalid string", () => {
		expect(isEffort("invalid")).toBe(false);
		expect(isEffort("")).toBe(false);
		expect(isEffort("MINIMAL")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isEffort("")).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		const result = canonicalizeEfforts([Effort.High, Effort.Low, Effort.Medium]);
		expect(result).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});

	it("returns all efforts in canonical order", () => {
		const result = canonicalizeEfforts([
			Effort.Max,
			Effort.Minimal,
			Effort.XHigh,
			Effort.Low,
			Effort.High,
			Effort.Medium,
		]);
		expect(result).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});

	it("deduplicates efforts", () => {
		const result = canonicalizeEfforts([Effort.Low, Effort.Low, Effort.High]);
		expect(result).toEqual([Effort.Low, Effort.High]);
	});

	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});

	it("preserves single effort", () => {
		expect(canonicalizeEfforts([Effort.Medium])).toEqual([Effort.Medium]);
	});
});

describe("stripEffortTierSuffix", () => {
	it("strips -minimal suffix", () => {
		expect(stripEffortTierSuffix("model-minimal")).toBe("model");
	});

	it("strips -low suffix", () => {
		expect(stripEffortTierSuffix("model-low")).toBe("model");
	});

	it("strips -medium suffix", () => {
		expect(stripEffortTierSuffix("model-medium")).toBe("model");
	});

	it("strips -high suffix", () => {
		expect(stripEffortTierSuffix("model-high")).toBe("model");
	});

	it("strips -xhigh suffix", () => {
		expect(stripEffortTierSuffix("model-xhigh")).toBe("model");
	});

	it("strips -max suffix", () => {
		expect(stripEffortTierSuffix("model-max")).toBe("model");
	});

	it("strips -none suffix", () => {
		expect(stripEffortTierSuffix("model-none")).toBe("model");
	});

	it("strips -thinking suffix", () => {
		expect(stripEffortTierSuffix("model-thinking")).toBe("model");
	});

	it("returns undefined when no suffix", () => {
		expect(stripEffortTierSuffix("model")).toBeUndefined();
	});

	it("handles empty string", () => {
		expect(stripEffortTierSuffix("")).toBeUndefined();
	});

	it("does not strip suffix in middle", () => {
		expect(stripEffortTierSuffix("model-high-pro")).toBeUndefined();
	});
});

describe("toNumber", () => {
	it("returns number for valid number", () => {
		expect(toNumber(42)).toBe(42);
	});

	it("returns number for zero", () => {
		expect(toNumber(0)).toBe(0);
	});

	it("returns undefined for NaN", () => {
		expect(toNumber(NaN)).toBeUndefined();
	});

	it("returns undefined for Infinity", () => {
		expect(toNumber(Infinity)).toBeUndefined();
	});

	it("returns undefined for -Infinity", () => {
		expect(toNumber(-Infinity)).toBeUndefined();
	});

	it("parses numeric string", () => {
		expect(toNumber("42")).toBe(42);
	});

	it("parses float string", () => {
		expect(toNumber("3.14")).toBe(3.14);
	});

	it("parses negative string", () => {
		expect(toNumber("-5")).toBe(-5);
	});

	it("returns undefined for non-numeric string", () => {
		expect(toNumber("abc")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(toNumber("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(toNumber("   ")).toBeUndefined();
	});

	it("returns undefined for null", () => {
		expect(toNumber(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(toNumber(undefined)).toBeUndefined();
	});

	it("returns undefined for boolean", () => {
		expect(toNumber(true)).toBeUndefined();
	});

	it("returns undefined for object", () => {
		expect(toNumber({})).toBeUndefined();
	});
});

describe("toPositiveNumber", () => {
	it("returns positive number", () => {
		expect(toPositiveNumber(5, 10)).toBe(5);
	});

	it("returns fallback for zero", () => {
		expect(toPositiveNumber(0, 10)).toBe(10);
	});

	it("returns fallback for negative", () => {
		expect(toPositiveNumber(-1, 10)).toBe(10);
	});

	it("returns fallback for NaN", () => {
		expect(toPositiveNumber(NaN, 10)).toBe(10);
	});

	it("returns fallback for undefined", () => {
		expect(toPositiveNumber(undefined, 10)).toBe(10);
	});

	it("returns positive string number", () => {
		expect(toPositiveNumber("5", 10)).toBe(5);
	});

	it("returns fallback for non-numeric string", () => {
		expect(toPositiveNumber("abc", 10)).toBe(10);
	});

	it("returns null fallback when fallback is null", () => {
		expect(toPositiveNumber(-1, null)).toBeNull();
	});

	it("returns positive float", () => {
		expect(toPositiveNumber(0.1, 10)).toBe(0.1);
	});
});

describe("toBoolean", () => {
	it("returns true for true", () => {
		expect(toBoolean(true)).toBe(true);
	});

	it("returns false for false", () => {
		expect(toBoolean(false)).toBe(false);
	});

	it("returns undefined for non-boolean", () => {
		expect(toBoolean("true")).toBeUndefined();
		expect(toBoolean(1)).toBeUndefined();
		expect(toBoolean(null)).toBeUndefined();
		expect(toBoolean(undefined)).toBeUndefined();
	});
});

describe("toFields", () => {
	it("returns object for object", () => {
		const obj = { key: "value" };
		expect(toFields(obj)).toBe(obj);
	});

	it("returns object for array (arrays are objects)", () => {
		const arr = [1, 2] as unknown as Record<string, unknown>;
		expect(toFields(arr)).toBe(arr);
	});

	it("returns undefined for null", () => {
		expect(toFields(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(toFields(undefined)).toBeUndefined();
	});

	it("returns undefined for string", () => {
		expect(toFields("string")).toBeUndefined();
	});

	it("returns undefined for number", () => {
		expect(toFields(42)).toBeUndefined();
	});
});

describe("toFiniteNumber", () => {
	it("returns finite number", () => {
		expect(toFiniteNumber(42)).toBe(42);
	});

	it("returns undefined for Infinity", () => {
		expect(toFiniteNumber(Infinity)).toBeUndefined();
	});

	it("returns undefined for NaN", () => {
		expect(toFiniteNumber(NaN)).toBeUndefined();
	});

	it("returns undefined for string", () => {
		expect(toFiniteNumber("42")).toBeUndefined();
	});

	it("returns zero", () => {
		expect(toFiniteNumber(0)).toBe(0);
	});

	it("returns negative number", () => {
		expect(toFiniteNumber(-5)).toBe(-5);
	});
});

describe("toStringValue", () => {
	it("returns string for string", () => {
		expect(toStringValue("hello")).toBe("hello");
	});

	it("returns undefined for non-string", () => {
		expect(toStringValue(42)).toBeUndefined();
		expect(toStringValue(true)).toBeUndefined();
		expect(toStringValue(null)).toBeUndefined();
		expect(toStringValue(undefined)).toBeUndefined();
	});

	it("returns empty string", () => {
		expect(toStringValue("")).toBe("");
	});
});

describe("toNonEmptyString", () => {
	it("returns trimmed non-empty string", () => {
		expect(toNonEmptyString("  hello  ")).toBe("hello");
	});

	it("returns string without whitespace", () => {
		expect(toNonEmptyString("hello")).toBe("hello");
	});

	it("returns undefined for empty string", () => {
		expect(toNonEmptyString("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(toNonEmptyString("   ")).toBeUndefined();
	});

	it("returns undefined for non-string", () => {
		expect(toNonEmptyString(42)).toBeUndefined();
		expect(toNonEmptyString(null)).toBeUndefined();
	});
});

describe("toArray", () => {
	it("returns array for array", () => {
		const arr = [1, 2, 3];
		expect(toArray(arr)).toBe(arr);
	});

	it("returns undefined for non-array", () => {
		expect(toArray("string")).toBeUndefined();
		expect(toArray(42)).toBeUndefined();
		expect(toArray({})).toBeUndefined();
		expect(toArray(null)).toBeUndefined();
		expect(toArray(undefined)).toBeUndefined();
	});

	it("returns empty array", () => {
		expect(toArray([])).toEqual([]);
	});
});

describe("toStringArray", () => {
	it("returns string array from mixed array", () => {
		expect(toStringArray(["a", 1, "b", true])).toEqual(["a", "b"]);
	});

	it("returns all strings from string array", () => {
		expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("returns empty array from non-string array", () => {
		expect(toStringArray([1, 2, 3])).toEqual([]);
	});

	it("returns undefined for non-array", () => {
		expect(toStringArray("string")).toBeUndefined();
		expect(toStringArray(42)).toBeUndefined();
		expect(toStringArray(null)).toBeUndefined();
	});

	it("returns empty array from empty array", () => {
		expect(toStringArray([])).toEqual([]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for token containing sk-ant-oat", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});

	it("returns true for token with sk-ant-oat embedded", () => {
		expect(isAnthropicOAuthToken("prefix-sk-ant-oat-suffix")).toBe(true);
	});

	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api01-abc123")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isAnthropicOAuthToken("")).toBe(false);
	});

	it("returns false for non-Anthropic key", () => {
		expect(isAnthropicOAuthToken("sk-openai-abc123")).toBe(false);
	});
});

describe("cleanModelName", () => {
	it("removes author prefix", () => {
		expect(cleanModelName("Author: Model Name")).toBe("Model Name");
	});

	it("removes (latest) tag", () => {
		expect(cleanModelName("GPT-4 (latest)")).toBe("GPT-4");
	});

	it("removes (Antigravity) tag", () => {
		expect(cleanModelName("Model (Antigravity)")).toBe("Model");
	});

	it("removes percentage off tag", () => {
		expect(cleanModelName("Model (50% off)")).toBe("Model");
	});

	it("removes dollar-only tag", () => {
		expect(cleanModelName("Model ($$$)")).toBe("Model");
	});

	it("removes retires tag", () => {
		expect(cleanModelName("Model (retires 2024-12-31)")).toBe("Model");
	});

	it("collapses multiple spaces", () => {
		expect(cleanModelName("Model  Name")).toBe("Model Name");
	});

	it("returns original when cleaning results in empty", () => {
		expect(cleanModelName("   ")).toBe("   ");
	});

	it("handles name without tags", () => {
		expect(cleanModelName("Claude 3.5 Sonnet")).toBe("Claude 3.5 Sonnet");
	});

	it("removes author prefix and tags together", () => {
		expect(cleanModelName("Author: Model (latest)")).toBe("Model");
	});

	it("handles empty string", () => {
		expect(cleanModelName("")).toBe("");
	});
});

describe("discoveryFetch", () => {
	it("returns override fetch when provided", () => {
		const customFetch = (() => {}) as unknown as typeof fetch;
		expect(discoveryFetch(customFetch)).toBe(customFetch);
	});

	it("returns a fetch function when no override", () => {
		const result = discoveryFetch();
		expect(typeof result).toBe("function");
	});
});
