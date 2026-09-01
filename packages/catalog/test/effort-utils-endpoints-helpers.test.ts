import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";
import {
	ANTHROPIC_API_ENDPOINT,
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	CLOUD_CODE_ENDPOINT,
	CURSOR_API_ENDPOINT,
	DEVIN_AUTH_ENDPOINT,
	DEVIN_CASCADE_ENDPOINT,
	DEVIN_WEBAPP_URL,
	GEMINI_DEVELOPER_API_ENDPOINT,
	GITLAB_SAAS_URL,
	OPENROUTER_API_ENDPOINT,
} from "../src/provider-endpoints";
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

describe("Effort", () => {
	it("Minimal is minimal", () => {
		expect(Effort.Minimal as string).toBe("minimal");
	});
	it("Low is low", () => {
		expect(Effort.Low as string).toBe("low");
	});
	it("Medium is medium", () => {
		expect(Effort.Medium as string).toBe("medium");
	});
	it("High is high", () => {
		expect(Effort.High as string).toBe("high");
	});
	it("XHigh is xhigh", () => {
		expect(Effort.XHigh as string).toBe("xhigh");
	});
	it("Max is max", () => {
		expect(Effort.Max as string).toBe("max");
	});
});

describe("THINKING_EFFORTS", () => {
	it("has 6 efforts in order", () => {
		expect(THINKING_EFFORTS as readonly string[]).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("isEffort", () => {
	it("returns true for valid efforts", () => {
		expect(isEffort("minimal")).toBe(true);
		expect(isEffort("low")).toBe(true);
		expect(isEffort("medium")).toBe(true);
		expect(isEffort("high")).toBe(true);
		expect(isEffort("xhigh")).toBe(true);
		expect(isEffort("max")).toBe(true);
	});
	it("returns false for invalid efforts", () => {
		expect(isEffort("none")).toBe(false);
		expect(isEffort("off")).toBe(false);
		expect(isEffort("")).toBe(false);
	});
	it("returns false for non-strings", () => {
		expect(isEffort(42 as unknown)).toBe(false);
		expect(isEffort(null as unknown)).toBe(false);
		expect(isEffort(undefined as unknown)).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Low])).toEqual([Effort.Low, Effort.High]);
	});
	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});
	it("deduplicates efforts", () => {
		expect(canonicalizeEfforts([Effort.Low, Effort.Low])).toEqual([Effort.Low]);
	});
	it("preserves all valid efforts", () => {
		expect(canonicalizeEfforts([Effort.Minimal, Effort.Max])).toEqual([Effort.Minimal, Effort.Max]);
	});
});

describe("toNumber", () => {
	it("returns number for valid number", () => {
		expect(toNumber(42)).toBe(42);
	});
	it("returns number for numeric string", () => {
		expect(toNumber("42")).toBe(42);
	});
	it("returns undefined for non-numeric string", () => {
		expect(toNumber("hello")).toBeUndefined();
	});
	it("returns undefined for NaN", () => {
		expect(toNumber(NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(toNumber(Infinity)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(toNumber(null)).toBeUndefined();
	});
	it("returns undefined for boolean", () => {
		expect(toNumber(true)).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(toNumber("")).toBeUndefined();
	});
	it("returns undefined for whitespace-only string", () => {
		expect(toNumber("   ")).toBeUndefined();
	});
	it("handles negative numbers", () => {
		expect(toNumber(-5)).toBe(-5);
		expect(toNumber("-5")).toBe(-5);
	});
	it("handles decimal numbers", () => {
		expect(toNumber(3.14)).toBe(3.14);
		expect(toNumber("3.14")).toBe(3.14);
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
	it("returns fallback for NaN", () => {
		expect(toPositiveNumber(NaN, 10)).toBe(10);
	});
	it("returns null fallback", () => {
		expect(toPositiveNumber(0, null)).toBeNull();
	});
	it("returns positive string number", () => {
		expect(toPositiveNumber("5", 10)).toBe(5);
	});
	it("returns fallback for undefined", () => {
		expect(toPositiveNumber(undefined, 10)).toBe(10);
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
	it("returns undefined for non-object", () => {
		expect(toFields("hello")).toBeUndefined();
		expect(toFields(42)).toBeUndefined();
	});
	it("returns record for array", () => {
		expect(toFields([1, 2]) as unknown).toEqual([1, 2]);
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
	it("returns undefined for non-number", () => {
		expect(toFiniteNumber("42")).toBeUndefined();
		expect(toFiniteNumber(null)).toBeUndefined();
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
	});
	it("returns empty string", () => {
		expect(toStringValue("")).toBe("");
	});
});

describe("toNonEmptyString", () => {
	it("returns string for non-empty string", () => {
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
	it("trims whitespace", () => {
		expect(toNonEmptyString("  hello  ")).toBe("hello");
	});
});

describe("toArray", () => {
	it("returns array for array", () => {
		expect(toArray([1, 2])).toEqual([1, 2]);
	});
	it("returns undefined for non-array", () => {
		expect(toArray({ a: 1 })).toBeUndefined();
		expect(toArray("hello")).toBeUndefined();
		expect(toArray(null)).toBeUndefined();
	});
	it("returns empty array", () => {
		expect(toArray([])).toEqual([]);
	});
});

describe("toStringArray", () => {
	it("returns string array for mixed array", () => {
		expect(toStringArray(["a", 1, "b"])).toEqual(["a", "b"]);
	});
	it("returns undefined for non-array", () => {
		expect(toStringArray("hello")).toBeUndefined();
		expect(toStringArray(null)).toBeUndefined();
	});
	it("returns empty array for empty input", () => {
		expect(toStringArray([])).toEqual([]);
	});
	it("filters out non-strings", () => {
		expect(toStringArray([1, 2, 3])).toEqual([]);
	});
	it("returns all strings", () => {
		expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});
});

describe("isAnthropicOAuthToken", () => {
	it("returns true for token containing sk-ant-oat", () => {
		expect(isAnthropicOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isAnthropicOAuthToken("sk-ant-api-key")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAnthropicOAuthToken("")).toBe(false);
	});
	it("returns false for non-anthropic key", () => {
		expect(isAnthropicOAuthToken("openai-key")).toBe(false);
	});
});

describe("cleanModelName", () => {
	it("removes author prefix", () => {
		expect(cleanModelName("Author: Model Name")).toBe("Model Name");
	});
	it("removes (latest) tag", () => {
		expect(cleanModelName("GPT-4 (latest)")).toBe("GPT-4");
	});
	it("removes percentage off tag", () => {
		expect(cleanModelName("Model (50% off)")).toBe("Model");
	});
	it("removes Antigravity tag", () => {
		expect(cleanModelName("Model (Antigravity)")).toBe("Model");
	});
	it("removes retires tag", () => {
		expect(cleanModelName("Model (retires 2024-12-31)")).toBe("Model");
	});
	it("collapses multiple spaces", () => {
		expect(cleanModelName("Model  Name")).toBe("Model Name");
	});
	it("returns original for empty result", () => {
		expect(cleanModelName("   ")).toBe("   ");
	});
	it("handles plain name", () => {
		expect(cleanModelName("Claude 3.5 Sonnet")).toBe("Claude 3.5 Sonnet");
	});
	it("removes dollar sign tags", () => {
		expect(cleanModelName("Model ($$$)")).toBe("Model");
	});
	it("removes numeric discount tags", () => {
		expect(cleanModelName("Model (25% off)")).toBe("Model");
	});
	it("removes >N% off tags", () => {
		expect(cleanModelName("Model (>50% off)")).toBe("Model");
	});
});

describe("provider-endpoints constants", () => {
	it("CLOUD_CODE_ENDPOINT", () => {
		expect(CLOUD_CODE_ENDPOINT).toBe("https://cloudcode-pa.googleapis.com");
	});
	it("ANTIGRAVITY_PRIMARY_ENDPOINT", () => {
		expect(ANTIGRAVITY_PRIMARY_ENDPOINT).toBe("https://daily-cloudcode-pa.googleapis.com");
	});
	it("ANTIGRAVITY_SANDBOX_ENDPOINT", () => {
		expect(ANTIGRAVITY_SANDBOX_ENDPOINT).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com");
	});
	it("ANTIGRAVITY_ENDPOINTS has 2 entries", () => {
		expect(ANTIGRAVITY_ENDPOINTS).toHaveLength(2);
		expect(ANTIGRAVITY_ENDPOINTS[0]).toBe(ANTIGRAVITY_PRIMARY_ENDPOINT);
		expect(ANTIGRAVITY_ENDPOINTS[1]).toBe(ANTIGRAVITY_SANDBOX_ENDPOINT);
	});
	it("GITLAB_SAAS_URL", () => {
		expect(GITLAB_SAAS_URL).toBe("https://gitlab.com");
	});
	it("DEVIN_CASCADE_ENDPOINT", () => {
		expect(DEVIN_CASCADE_ENDPOINT).toBe("https://server.codeium.com");
	});
	it("DEVIN_AUTH_ENDPOINT", () => {
		expect(DEVIN_AUTH_ENDPOINT).toBe("https://api.devin.ai");
	});
	it("DEVIN_WEBAPP_URL", () => {
		expect(DEVIN_WEBAPP_URL).toBe("https://app.devin.ai");
	});
	it("GEMINI_DEVELOPER_API_ENDPOINT", () => {
		expect(GEMINI_DEVELOPER_API_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta");
	});
	it("ANTHROPIC_API_ENDPOINT", () => {
		expect(ANTHROPIC_API_ENDPOINT).toBe("https://api.anthropic.com");
	});
	it("CURSOR_API_ENDPOINT", () => {
		expect(CURSOR_API_ENDPOINT).toBe("https://api2.cursor.sh");
	});
	it("OPENROUTER_API_ENDPOINT", () => {
		expect(OPENROUTER_API_ENDPOINT).toBe("https://openrouter.ai/api/v1");
	});
});
