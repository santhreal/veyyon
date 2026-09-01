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

describe("toFireworksPublicModelId", () => {
	it("strips wire prefix and converts p to dot", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/llama-v2p70b")).toBe("llama-v2.70b");
	});
	it("converts p to dot without wire prefix", () => {
		expect(toFireworksPublicModelId("llama-v2p70b")).toBe("llama-v2.70b");
	});
	it("leaves non-version p unchanged", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/mixtral-8x7b")).toBe("mixtral-8x7b");
	});
	it("handles id without any version separator", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/gpt-4")).toBe("gpt-4");
	});
	it("handles empty string", () => {
		expect(toFireworksPublicModelId("")).toBe("");
	});
});

describe("toFireworksWireModelId", () => {
	it("adds wire prefix and converts dot to p", () => {
		expect(toFireworksWireModelId("llama-v2.70b")).toBe("accounts/fireworks/models/llama-v2p70b");
	});
	it("converts dot to p without stripping existing prefix", () => {
		expect(toFireworksWireModelId("accounts/fireworks/models/llama-v2.70b")).toBe(
			"accounts/fireworks/models/llama-v2p70b",
		);
	});
	it("handles id without version separator", () => {
		expect(toFireworksWireModelId("gpt-4")).toBe("accounts/fireworks/models/gpt-4");
	});
});

describe("toFirepassPublicModelId", () => {
	it("strips firepass wire prefix and converts p to dot", () => {
		expect(toFirepassPublicModelId("accounts/fireworks/routers/llama-v2p70b")).toBe("llama-v2.70b");
	});
	it("converts p to dot without wire prefix", () => {
		expect(toFirepassPublicModelId("llama-v2p70b")).toBe("llama-v2.70b");
	});
});

describe("toFirepassWireModelId", () => {
	it("adds firepass wire prefix and converts dot to p", () => {
		expect(toFirepassWireModelId("llama-v2.70b")).toBe("accounts/fireworks/routers/llama-v2p70b");
	});
	it("does not double-prefix", () => {
		expect(toFirepassWireModelId("accounts/fireworks/routers/llama-v2.70b")).toBe(
			"accounts/fireworks/routers/llama-v2p70b",
		);
	});
});

describe("isFireworksFastModelId", () => {
	it("returns true for fast suffix", () => {
		expect(isFireworksFastModelId("llama-v2.70b-fast")).toBe(true);
	});
	it("returns false without fast suffix", () => {
		expect(isFireworksFastModelId("llama-v2.70b")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isFireworksFastModelId("")).toBe(false);
	});
});

describe("toFireworksBaseModelId", () => {
	it("strips fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v2.70b-fast")).toBe("llama-v2.70b");
	});
	it("returns unchanged without fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v2.70b")).toBe("llama-v2.70b");
	});
});

describe("FIREWORKS_FAST_SUFFIX", () => {
	it("is -fast", () => {
		expect(FIREWORKS_FAST_SUFFIX).toBe("-fast");
	});
});

describe("FIREPASS_WIRE_PREFIX", () => {
	it("is accounts/fireworks/routers/", () => {
		expect(FIREPASS_WIRE_PREFIX).toBe("accounts/fireworks/routers/");
	});
});

describe("isEffort", () => {
	it("returns true for minimal", () => {
		expect(isEffort("minimal")).toBe(true);
	});
	it("returns true for low", () => {
		expect(isEffort("low")).toBe(true);
	});
	it("returns true for medium", () => {
		expect(isEffort("medium")).toBe(true);
	});
	it("returns true for high", () => {
		expect(isEffort("high")).toBe(true);
	});
	it("returns true for xhigh", () => {
		expect(isEffort("xhigh")).toBe(true);
	});
	it("returns true for max", () => {
		expect(isEffort("max")).toBe(true);
	});
	it("returns false for unknown string", () => {
		expect(isEffort("ultra")).toBe(false);
	});
	it("returns false for number", () => {
		expect(isEffort(42)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isEffort(undefined)).toBe(false);
	});
	it("returns false for null", () => {
		expect(isEffort(null)).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Low])).toEqual([Effort.Low, Effort.High]);
	});
	it("removes duplicates", () => {
		expect(canonicalizeEfforts([Effort.Low, Effort.Low, Effort.High])).toEqual([Effort.Low, Effort.High]);
	});
	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});
	it("returns already-canonical list unchanged", () => {
		expect(canonicalizeEfforts([Effort.Minimal, Effort.Medium, Effort.Max])).toEqual([
			Effort.Minimal,
			Effort.Medium,
			Effort.Max,
		]);
	});
	it("handles full ladder", () => {
		expect(canonicalizeEfforts(THINKING_EFFORTS)).toEqual([...THINKING_EFFORTS]);
	});
	it("handles reversed full ladder", () => {
		expect(canonicalizeEfforts([...THINKING_EFFORTS].reverse())).toEqual([...THINKING_EFFORTS]);
	});
});

describe("toNumber", () => {
	it("returns finite number unchanged", () => {
		expect(toNumber(42)).toBe(42);
	});
	it("parses numeric string", () => {
		expect(toNumber("42")).toBe(42);
	});
	it("returns undefined for non-numeric string", () => {
		expect(toNumber("hello")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(toNumber("")).toBeUndefined();
	});
	it("returns undefined for whitespace string", () => {
		expect(toNumber("  ")).toBeUndefined();
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
	it("returns fallback for non-number", () => {
		expect(toPositiveNumber("hello", 10)).toBe(10);
	});
	it("returns fallback null", () => {
		expect(toPositiveNumber("hello", null)).toBeNull();
	});
	it("parses positive numeric string", () => {
		expect(toPositiveNumber("42", 10)).toBe(42);
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
	it("parses positive numeric string", () => {
		expect(toPositiveNumberOrNull("42")).toBe(42);
	});
});

describe("toBoolean", () => {
	it("returns true for true", () => {
		expect(toBoolean(true)).toBe(true);
	});
	it("returns false for false", () => {
		expect(toBoolean(false)).toBe(false);
	});
	it("returns undefined for string", () => {
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
	it("returns object as record", () => {
		expect(toFields({ a: 1 })).toEqual({ a: 1 });
	});
	it("returns array as record (arrays are objects)", () => {
		expect(toFields([1, 2]) as unknown).toEqual([1, 2]);
	});
	it("returns undefined for null", () => {
		expect(toFields(null)).toBeUndefined();
	});
	it("returns undefined for string", () => {
		expect(toFields("hello")).toBeUndefined();
	});
	it("returns undefined for number", () => {
		expect(toFields(42)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(toFields(undefined)).toBeUndefined();
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
	it("returns string unchanged", () => {
		expect(toStringValue("hello")).toBe("hello");
	});
	it("returns undefined for number", () => {
		expect(toStringValue(42)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toStringValue(null)).toBeUndefined();
	});
	it("returns undefined for boolean", () => {
		expect(toStringValue(true)).toBeUndefined();
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
	it("returns undefined for number", () => {
		expect(toNonEmptyString(42)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toNonEmptyString(null)).toBeUndefined();
	});
});

describe("toArray", () => {
	it("returns array unchanged", () => {
		expect(toArray([1, 2, 3])).toEqual([1, 2, 3]);
	});
	it("returns undefined for object", () => {
		expect(toArray({ a: 1 })).toBeUndefined();
	});
	it("returns undefined for string", () => {
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
	it("filters strings from mixed array", () => {
		expect(toStringArray(["a", 1, "b", true])).toEqual(["a", "b"]);
	});
	it("returns all strings", () => {
		expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});
	it("returns undefined for non-array", () => {
		expect(toStringArray("hello")).toBeUndefined();
	});
	it("returns empty array for empty array", () => {
		expect(toStringArray([])).toEqual([]);
	});
	it("returns empty array for array with no strings", () => {
		expect(toStringArray([1, 2, 3])).toEqual([]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for sk-ant-oat token", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api-abc123")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAnthropicOAuthToken("")).toBe(false);
	});
	it("returns true for token with sk-ant-oat embedded", () => {
		expect(isAnthropicOAuthToken("prefix-sk-ant-oat-suffix")).toBe(true);
	});
});

describe("cleanModelName", () => {
	it("strips author prefix", () => {
		expect(cleanModelName("OpenAI: GPT-4")).toBe("GPT-4");
	});
	it("strips (latest) tag", () => {
		expect(cleanModelName("GPT-4 (latest)")).toBe("GPT-4");
	});
	it("strips percentage off tag", () => {
		expect(cleanModelName("GPT-4 (50% off)")).toBe("GPT-4");
	});
	it("strips retires tag", () => {
		expect(cleanModelName("GPT-4 (retires 2024-12-31)")).toBe("GPT-4");
	});
	it("collapses multiple spaces", () => {
		expect(cleanModelName("GPT-4  Turbo")).toBe("GPT-4 Turbo");
	});
	it("returns original when cleaning leaves empty", () => {
		expect(cleanModelName("OpenAI: ")).toBe("OpenAI: ");
	});
	it("returns unchanged when no matches", () => {
		expect(cleanModelName("Llama 2")).toBe("Llama 2");
	});
	it("strips dollar sign tags", () => {
		expect(cleanModelName("GPT-4 ($$$)")).toBe("GPT-4");
	});
	it("strips Antigravity tag", () => {
		expect(cleanModelName("GPT-4 (Antigravity)")).toBe("GPT-4");
	});
});
