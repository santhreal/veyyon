import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";
import {
	FIREPASS_WIRE_PREFIX,
	FIREWORKS_FAST_SUFFIX,
	isFireworksFastModelId,
	toFirepassPublicModelId,
	toFirepassWireModelId,
	toFireworksBaseModelId,
	toFireworksPublicModelId,
	toFireworksWireModelId,
} from "../src/fireworks-model-id";
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
	toPositiveNumberOrNull,
	toStringArray,
	toStringValue,
} from "../src/utils";

describe("isEffort", () => {
	it("returns true for all valid efforts", () => {
		for (const effort of THINKING_EFFORTS) {
			expect(isEffort(effort)).toBe(true);
		}
	});
	it("returns false for invalid string", () => {
		expect(isEffort("invalid")).toBe(false);
	});
	it("returns false for non-string", () => {
		expect(isEffort(42)).toBe(false);
		expect(isEffort(null)).toBe(false);
		expect(isEffort(undefined)).toBe(false);
		expect(isEffort(true)).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		const result = canonicalizeEfforts([Effort.High, Effort.Low]);
		expect(result).toEqual([Effort.Low, Effort.High]);
	});
	it("removes duplicates", () => {
		const result = canonicalizeEfforts([Effort.Low, Effort.Low, Effort.Low]);
		expect(result).toEqual([Effort.Low]);
	});
	it("removes invalid efforts", () => {
		const result = canonicalizeEfforts([Effort.Low, "invalid" as Effort, Effort.High]);
		expect(result).toEqual([Effort.Low, Effort.High]);
	});
	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});
	it("preserves already-canonical ladder", () => {
		const canonical = [Effort.Minimal, Effort.Medium, Effort.Max];
		expect(canonicalizeEfforts(canonical)).toEqual(canonical);
	});
	it("returns all efforts for full set out of order", () => {
		const reversed = [...THINKING_EFFORTS].reverse();
		expect(canonicalizeEfforts(reversed)).toEqual([...THINKING_EFFORTS]);
	});
});

describe("toNumber", () => {
	it("returns number for finite number", () => {
		expect(toNumber(42)).toBe(42);
		expect(toNumber(3.14)).toBe(3.14);
	});
	it("returns undefined for NaN", () => {
		expect(toNumber(Number.NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
	it("parses numeric string", () => {
		expect(toNumber("42")).toBe(42);
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
	it("returns undefined for boolean", () => {
		expect(toNumber(true)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toNumber(null)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(toNumber(undefined)).toBeUndefined();
	});
	it("returns undefined for object", () => {
		expect(toNumber({ a: 1 })).toBeUndefined();
	});
	it("parses negative string", () => {
		expect(toNumber("-5")).toBe(-5);
	});
});

describe("toPositiveNumber", () => {
	it("returns positive number as-is", () => {
		expect(toPositiveNumber(5, 10)).toBe(5);
	});
	it("returns fallback for zero", () => {
		expect(toPositiveNumber(0, 10)).toBe(10);
	});
	it("returns fallback for negative", () => {
		expect(toPositiveNumber(-5, 10)).toBe(10);
	});
	it("returns fallback for non-number", () => {
		expect(toPositiveNumber("hello", 10)).toBe(10);
	});
	it("returns null fallback when fallback is null", () => {
		expect(toPositiveNumber("hello", null)).toBeNull();
	});
	it("parses positive numeric string", () => {
		expect(toPositiveNumber("5", 10)).toBe(5);
	});
	it("returns fallback for NaN", () => {
		expect(toPositiveNumber(Number.NaN, 10)).toBe(10);
	});
});

describe("toPositiveNumberOrNull", () => {
	it("returns positive number", () => {
		expect(toPositiveNumberOrNull(5)).toBe(5);
	});
	it("returns null for zero", () => {
		expect(toPositiveNumberOrNull(0)).toBeNull();
	});
	it("returns null for negative", () => {
		expect(toPositiveNumberOrNull(-5)).toBeNull();
	});
	it("returns null for non-number", () => {
		expect(toPositiveNumberOrNull("hello")).toBeNull();
	});
	it("returns null for null", () => {
		expect(toPositiveNumberOrNull(null)).toBeNull();
	});
	it("parses positive string", () => {
		expect(toPositiveNumberOrNull("5")).toBe(5);
	});
});

describe("toBoolean", () => {
	it("returns boolean for true", () => {
		expect(toBoolean(true)).toBe(true);
	});
	it("returns boolean for false", () => {
		expect(toBoolean(false)).toBe(false);
	});
	it("returns undefined for non-boolean", () => {
		expect(toBoolean("true")).toBeUndefined();
		expect(toBoolean(1)).toBeUndefined();
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
	it("returns undefined for primitive", () => {
		expect(toFields(42)).toBeUndefined();
		expect(toFields("hello")).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(toFields(undefined)).toBeUndefined();
	});
	it("returns record for array (arrays are objects)", () => {
		expect(toFields([1, 2]) as unknown).toEqual([1, 2]);
	});
});

describe("toFiniteNumber", () => {
	it("returns finite number", () => {
		expect(toFiniteNumber(42)).toBe(42);
	});
	it("returns undefined for NaN", () => {
		expect(toFiniteNumber(Number.NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
	it("returns undefined for string", () => {
		expect(toFiniteNumber("42")).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toFiniteNumber(null)).toBeUndefined();
	});
});

describe("toStringValue", () => {
	it("returns string as-is", () => {
		expect(toStringValue("hello")).toBe("hello");
	});
	it("returns undefined for non-string", () => {
		expect(toStringValue(42)).toBeUndefined();
		expect(toStringValue(true)).toBeUndefined();
		expect(toStringValue(null)).toBeUndefined();
	});
	it("returns empty string for empty string", () => {
		expect(toStringValue("")).toBe("");
	});
});

describe("toNonEmptyString", () => {
	it("returns trimmed non-empty string", () => {
		expect(toNonEmptyString("  hello  ")).toBe("hello");
	});
	it("returns undefined for empty string", () => {
		expect(toNonEmptyString("")).toBeUndefined();
	});
	it("returns undefined for whitespace-only string", () => {
		expect(toNonEmptyString("   ")).toBeUndefined();
	});
	it("returns undefined for non-string", () => {
		expect(toNonEmptyString(42)).toBeUndefined();
	});
});

describe("toArray", () => {
	it("returns array as-is", () => {
		expect(toArray([1, 2, 3])).toEqual([1, 2, 3]);
	});
	it("returns undefined for non-array", () => {
		expect(toArray("hello")).toBeUndefined();
		expect(toArray({ a: 1 })).toBeUndefined();
		expect(toArray(null)).toBeUndefined();
	});
	it("returns empty array for empty array", () => {
		expect(toArray([])).toEqual([]);
	});
});

describe("toStringArray", () => {
	it("returns string array from mixed array", () => {
		expect(toStringArray([1, "a", true, "b"])).toEqual(["a", "b"]);
	});
	it("returns all-string array as-is", () => {
		expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
	});
	it("returns undefined for non-array", () => {
		expect(toStringArray("hello")).toBeUndefined();
	});
	it("returns empty array for empty array", () => {
		expect(toStringArray([])).toEqual([]);
	});
	it("returns empty array for array with no strings", () => {
		expect(toStringArray([1, 2, true])).toEqual([]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for sk-ant-oat token", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});
	it("returns true for token containing sk-ant-oat", () => {
		expect(isAnthropicOAuthToken("prefix-sk-ant-oat-suffix")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api-abc123")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAnthropicOAuthToken("")).toBe(false);
	});
});

describe("cleanModelName", () => {
	it("removes author prefix", () => {
		expect(cleanModelName("OpenAI: gpt-4o")).toBe("gpt-4o");
	});
	it("removes (latest) tag", () => {
		expect(cleanModelName("gpt-4o (latest)")).toBe("gpt-4o");
	});
	it("removes percentage off tag", () => {
		expect(cleanModelName("model (50% off)")).toBe("model");
	});
	it("removes multiple noise tags", () => {
		expect(cleanModelName("model (latest) (50% off)")).toBe("model");
	});
	it("collapses multiple spaces", () => {
		expect(cleanModelName("model    name")).toBe("model name");
	});
	it("returns original when stripping leaves empty", () => {
		expect(cleanModelName("OpenAI: ")).toBe("OpenAI: ");
	});
	it("returns unchanged name with no matches", () => {
		expect(cleanModelName("gpt-4o")).toBe("gpt-4o");
	});
	it("removes 'retires' tag", () => {
		expect(cleanModelName("model (retires 2024-12-31)")).toBe("model");
	});
});

describe("Fireworks model ID conversions", () => {
	it("toFireworksPublicModelId strips prefix and converts p to dot", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
	it("toFireworksPublicModelId handles already-public id", () => {
		expect(toFireworksPublicModelId("llama-v3.1-8b")).toBe("llama-v3.1-8b");
	});
	it("toFireworksWireModelId adds prefix and converts dot to p", () => {
		expect(toFireworksWireModelId("llama-v3.1-8b")).toBe("accounts/fireworks/models/llama-v3p1-8b");
	});
	it("toFireworksWireModelId handles already-wire id", () => {
		expect(toFireworksWireModelId("accounts/fireworks/models/llama-v3p1-8b")).toBe(
			"accounts/fireworks/models/llama-v3p1-8b",
		);
	});
	it("toFirepassPublicModelId strips prefix and converts p to dot", () => {
		expect(toFirepassPublicModelId("accounts/fireworks/routers/llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
	it("toFirepassWireModelId adds prefix and converts dot to p", () => {
		expect(toFirepassWireModelId("llama-v3.1-8b")).toBe("accounts/fireworks/routers/llama-v3p1-8b");
	});
	it("FIREPASS_WIRE_PREFIX is correct", () => {
		expect(FIREPASS_WIRE_PREFIX).toBe("accounts/fireworks/routers/");
	});
	it("isFireworksFastModelId detects -fast suffix", () => {
		expect(isFireworksFastModelId("llama-v3.1-8b-fast")).toBe(true);
	});
	it("isFireworksFastModelId returns false for non-fast", () => {
		expect(isFireworksFastModelId("llama-v3.1-8b")).toBe(false);
	});
	it("toFireworksBaseModelId strips -fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v3.1-8b-fast")).toBe("llama-v3.1-8b");
	});
	it("toFireworksBaseModelId returns unchanged for non-fast", () => {
		expect(toFireworksBaseModelId("llama-v3.1-8b")).toBe("llama-v3.1-8b");
	});
	it("FIREWORKS_FAST_SUFFIX is '-fast'", () => {
		expect(FIREWORKS_FAST_SUFFIX).toBe("-fast");
	});
	it("round-trip public -> wire -> public", () => {
		const publicId = "llama-v3.1-8b";
		const wireId = toFireworksWireModelId(publicId);
		expect(toFireworksPublicModelId(wireId)).toBe(publicId);
	});
});
