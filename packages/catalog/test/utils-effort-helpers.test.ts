import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";
import {
	cleanModelName,
	isAnthropicOAuthToken,
	isRecord,
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

describe("toNumber", () => {
	it("returns finite number", () => {
		expect(toNumber(42)).toBe(42);
	});
	it("returns parsed numeric string", () => {
		expect(toNumber("42")).toBe(42);
	});
	it("returns parsed float string", () => {
		expect(toNumber("3.14")).toBe(3.14);
	});
	it("returns undefined for non-numeric string", () => {
		expect(toNumber("hello")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(toNumber("")).toBeUndefined();
	});
	it("returns undefined for whitespace-only string", () => {
		expect(toNumber("   ")).toBeUndefined();
	});
	it("returns undefined for NaN", () => {
		expect(toNumber(Number.NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toNumber(null)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(toNumber(undefined)).toBeUndefined();
	});
	it("returns undefined for object", () => {
		expect(toNumber({})).toBeUndefined();
	});
	it("returns negative number", () => {
		expect(toNumber(-5)).toBe(-5);
	});
	it("returns zero", () => {
		expect(toNumber(0)).toBe(0);
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
		expect(toPositiveNumber(-5, 10)).toBe(10);
	});
	it("returns fallback for undefined", () => {
		expect(toPositiveNumber(undefined, 10)).toBe(10);
	});
	it("returns positive string number", () => {
		expect(toPositiveNumber("5", 10)).toBe(5);
	});
	it("returns null fallback when provided", () => {
		expect(toPositiveNumber(0, null)).toBeNull();
	});
	it("returns positive float", () => {
		expect(toPositiveNumber(3.14, 10)).toBe(3.14);
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
	});
	it("returns undefined for number", () => {
		expect(toBoolean(1)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toBoolean(null)).toBeUndefined();
	});
});

describe("toFields", () => {
	it("returns object for plain object", () => {
		expect(toFields({ a: 1 })).toEqual({ a: 1 });
	});
	it("returns undefined for null", () => {
		expect(toFields(null)).toBeUndefined();
	});
	it("returns array for array (arrays are objects)", () => {
		expect(toFields([1, 2])).toEqual([1, 2]);
	});
	it("returns undefined for string", () => {
		expect(toFields("hello")).toBeUndefined();
	});
	it("returns undefined for number", () => {
		expect(toFields(42)).toBeUndefined();
	});
	it("returns undefined for string (duplicate removed)", () => {
		expect(toFields("hello")).toBeUndefined();
	});
});

describe("toFiniteNumber", () => {
	it("returns finite number", () => {
		expect(toFiniteNumber(42)).toBe(42);
	});
	it("returns undefined for Infinity", () => {
		expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
	it("returns undefined for NaN", () => {
		expect(toFiniteNumber(Number.NaN)).toBeUndefined();
	});
	it("returns undefined for string", () => {
		expect(toFiniteNumber("42")).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toFiniteNumber(null)).toBeUndefined();
	});
});

describe("toStringValue", () => {
	it("returns string", () => {
		expect(toStringValue("hello")).toBe("hello");
	});
	it("returns undefined for number", () => {
		expect(toStringValue(42)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toStringValue(null)).toBeUndefined();
	});
	it("returns empty string", () => {
		expect(toStringValue("")).toBe("");
	});
});

describe("toNonEmptyString", () => {
	it("returns non-empty string", () => {
		expect(toNonEmptyString("hello")).toBe("hello");
	});
	it("returns trimmed string", () => {
		expect(toNonEmptyString("  hello  ")).toBe("hello");
	});
	it("returns undefined for empty string", () => {
		expect(toNonEmptyString("")).toBeUndefined();
	});
	it("returns undefined for whitespace-only string", () => {
		expect(toNonEmptyString("   ")).toBeUndefined();
	});
	it("returns undefined for number", () => {
		expect(toNonEmptyString(42)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toNonEmptyString(null)).toBeUndefined();
	});
});

describe("toArray", () => {
	it("returns array for array", () => {
		expect(toArray([1, 2])).toEqual([1, 2]);
	});
	it("returns undefined for non-array", () => {
		expect(toArray("hello")).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toArray(null)).toBeUndefined();
	});
	it("returns empty array", () => {
		expect(toArray([])).toEqual([]);
	});
});

describe("toStringArray", () => {
	it("returns string array", () => {
		expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
	});
	it("filters non-string entries", () => {
		expect(toStringArray(["a", 1, "b", true])).toEqual(["a", "b"]);
	});
	it("returns undefined for non-array", () => {
		expect(toStringArray("hello")).toBeUndefined();
	});
	it("returns empty array for empty array", () => {
		expect(toStringArray([])).toEqual([]);
	});
	it("returns empty array for all non-string array", () => {
		expect(toStringArray([1, 2, 3])).toEqual([]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for OAuth token", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-12345")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api01-12345")).toBe(false);
	});
	it("returns false for non-anthropic key", () => {
		expect(isAnthropicOAuthToken("openai-key")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAnthropicOAuthToken("")).toBe(false);
	});
});

describe("cleanModelName", () => {
	it("removes author prefix", () => {
		expect(cleanModelName("Author: Model Name")).toBe("Model Name");
	});
	it("removes (latest) tag", () => {
		expect(cleanModelName("Model Name (latest)")).toBe("Model Name");
	});
	it("removes percentage off tag", () => {
		expect(cleanModelName("Model Name (50% off)")).toBe("Model Name");
	});
	it("removes multiple tags", () => {
		expect(cleanModelName("Model Name (latest) (50% off)")).toBe("Model Name");
	});
	it("collapses multiple spaces", () => {
		expect(cleanModelName("Model    Name")).toBe("Model Name");
	});
	it("returns original for empty result", () => {
		expect(cleanModelName("Author: ")).toBe("Author: ");
	});
	it("preserves name without prefix or tags", () => {
		expect(cleanModelName("GPT-4")).toBe("GPT-4");
	});
	it("removes Antigravity tag", () => {
		expect(cleanModelName("Model (Antigravity)")).toBe("Model");
	});
	it("removes dollar-only tag", () => {
		expect(cleanModelName("Model ($$$)")).toBe("Model");
	});
	it("removes retires tag", () => {
		expect(cleanModelName("Model (retires 2024-12-31)")).toBe("Model");
	});
});

describe("isRecord", () => {
	it("returns true for plain object", () => {
		expect(isRecord({})).toBe(true);
	});
	it("returns true for object with properties", () => {
		expect(isRecord({ a: 1 })).toBe(true);
	});
	it("returns false for null", () => {
		expect(isRecord(null)).toBe(false);
	});
	it("returns false for array", () => {
		expect(isRecord([1, 2])).toBe(false);
	});
	it("returns false for string", () => {
		expect(isRecord("hello")).toBe(false);
	});
	it("returns false for number", () => {
		expect(isRecord(42)).toBe(false);
	});
});

describe("Effort enum", () => {
	it("has Minimal value", () => {
		expect(Effort.Minimal).toBe("minimal");
	});
	it("has Low value", () => {
		expect(Effort.Low).toBe("low");
	});
	it("has Medium value", () => {
		expect(Effort.Medium).toBe("medium");
	});
	it("has High value", () => {
		expect(Effort.High).toBe("high");
	});
	it("has XHigh value", () => {
		expect(Effort.XHigh).toBe("xhigh");
	});
	it("has Max value", () => {
		expect(Effort.Max).toBe("max");
	});
});

describe("THINKING_EFFORTS", () => {
	it("has 6 efforts in order", () => {
		expect(THINKING_EFFORTS).toHaveLength(6);
		expect(THINKING_EFFORTS[0]).toBe(Effort.Minimal);
		expect(THINKING_EFFORTS[5]).toBe(Effort.Max);
	});
});

describe("isEffort", () => {
	it("returns true for valid effort", () => {
		expect(isEffort("minimal")).toBe(true);
		expect(isEffort("low")).toBe(true);
		expect(isEffort("medium")).toBe(true);
		expect(isEffort("high")).toBe(true);
		expect(isEffort("xhigh")).toBe(true);
		expect(isEffort("max")).toBe(true);
	});
	it("returns false for invalid effort", () => {
		expect(isEffort("ultra")).toBe(false);
	});
	it("returns false for non-string", () => {
		expect(isEffort(42)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isEffort(undefined)).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isEffort("")).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Low])).toEqual([Effort.Low, Effort.High]);
	});
	it("returns efforts in order when already ordered", () => {
		expect(canonicalizeEfforts([Effort.Minimal, Effort.Medium])).toEqual([Effort.Minimal, Effort.Medium]);
	});
	it("deduplicates efforts", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.High])).toEqual([Effort.High]);
	});
	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});
	it("returns all efforts in order", () => {
		expect(canonicalizeEfforts([Effort.Max, Effort.Minimal, Effort.High])).toEqual([
			Effort.Minimal,
			Effort.High,
			Effort.Max,
		]);
	});
});
