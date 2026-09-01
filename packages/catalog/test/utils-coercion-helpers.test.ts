import { describe, expect, it } from "bun:test";
import {
	cleanModelName,
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

describe("toNumber", () => {
	it("returns number for finite number", () => {
		expect(toNumber(42)).toBe(42);
	});
	it("returns undefined for NaN", () => {
		expect(toNumber(NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toNumber(Infinity)).toBeUndefined();
	});
	it("returns number for numeric string", () => {
		expect(toNumber("42")).toBe(42);
	});
	it("returns number for numeric string with whitespace", () => {
		expect(toNumber("  3.14  ")).toBe(3.14);
	});
	it("returns undefined for non-numeric string", () => {
		expect(toNumber("abc")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(toNumber("")).toBeUndefined();
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
	it("returns undefined for boolean", () => {
		expect(toNumber(true)).toBeUndefined();
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
	it("returns fallback for non-number", () => {
		expect(toPositiveNumber("abc", 10)).toBe(10);
	});
	it("returns fallback for undefined", () => {
		expect(toPositiveNumber(undefined, 10)).toBe(10);
	});
	it("returns null fallback when fallback is null", () => {
		expect(toPositiveNumber(0, null)).toBeNull();
	});
	it("returns positive string number", () => {
		expect(toPositiveNumber("5", 10)).toBe(5);
	});
	it("returns fallback for NaN", () => {
		expect(toPositiveNumber(NaN, 10)).toBe(10);
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
	it("returns record for object", () => {
		expect(toFields({ a: 1 })).toEqual({ a: 1 });
	});
	it("returns undefined for null", () => {
		expect(toFields(null)).toBeUndefined();
	});
	it("returns undefined for array", () => {
		expect(toFields([1, 2]) as unknown).toEqual([1, 2]);
	});
	it("returns undefined for string", () => {
		expect(toFields("hello")).toBeUndefined();
	});
	it("returns undefined for number", () => {
		expect(toFields(42)).toBeUndefined();
	});
});

describe("toFiniteNumber", () => {
	it("returns finite number", () => {
		expect(toFiniteNumber(42)).toBe(42);
	});
	it("returns undefined for NaN", () => {
		expect(toFiniteNumber(NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toFiniteNumber(Infinity)).toBeUndefined();
	});
	it("returns undefined for string", () => {
		expect(toFiniteNumber("42")).toBeUndefined();
	});
	it("returns zero", () => {
		expect(toFiniteNumber(0)).toBe(0);
	});
	it("returns negative", () => {
		expect(toFiniteNumber(-1)).toBe(-1);
	});
});

describe("toStringValue", () => {
	it("returns string for string", () => {
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
	it("returns trimmed string for non-empty string", () => {
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
		expect(toArray([1, 2, 3])).toEqual([1, 2, 3]);
	});
	it("returns undefined for non-array", () => {
		expect(toArray("hello")).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toArray(null)).toBeUndefined();
	});
	it("returns undefined for object", () => {
		expect(toArray({})).toBeUndefined();
	});
	it("returns empty array", () => {
		expect(toArray([])).toEqual([]);
	});
});

describe("toStringArray", () => {
	it("filters non-string entries from array", () => {
		expect(toStringArray([1, "a", true, "b"])).toEqual(["a", "b"]);
	});
	it("returns all-string array unchanged", () => {
		expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
	});
	it("returns empty array for empty input", () => {
		expect(toStringArray([])).toEqual([]);
	});
	it("returns undefined for non-array", () => {
		expect(toStringArray("hello")).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toStringArray(null)).toBeUndefined();
	});
	it("returns empty array for array with no strings", () => {
		expect(toStringArray([1, 2, true])).toEqual([]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for token containing sk-ant-oat", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api01-abc123")).toBe(false);
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
	it("preserves name without prefix", () => {
		expect(cleanModelName("Model Name")).toBe("Model Name");
	});
	it("removes (latest) tag", () => {
		expect(cleanModelName("Model Name (latest)")).toBe("Model Name");
	});
	it("removes percentage off tag", () => {
		expect(cleanModelName("Model Name (50% off)")).toBe("Model Name");
	});
	it("removes multiple noise tags", () => {
		expect(cleanModelName("Model Name (latest) (50% off)")).toBe("Model Name");
	});
	it("collapses multiple spaces", () => {
		expect(cleanModelName("Model  Name")).toBe("Model Name");
	});
	it("returns original when cleaned is empty", () => {
		expect(cleanModelName("   ")).toBe("   ");
	});
	it("removes Antigravity tag", () => {
		expect(cleanModelName("Model Name (Antigravity)")).toBe("Model Name");
	});
	it("removes retires tag", () => {
		expect(cleanModelName("Model Name (retires 2024-12-31)")).toBe("Model Name");
	});
	it("handles dollar sign tags", () => {
		expect(cleanModelName("Model Name ($$$)")).toBe("Model Name");
	});
	it("handles numeric discount tags", () => {
		expect(cleanModelName("Model Name (25% off)")).toBe("Model Name");
	});
	it("handles >N% off tags", () => {
		expect(cleanModelName("Model Name (>50% off)")).toBe("Model Name");
	});
});
