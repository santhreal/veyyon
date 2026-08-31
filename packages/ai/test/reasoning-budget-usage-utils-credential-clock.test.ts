import { afterEach, describe, expect, it } from "bun:test";
import { Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import {
	CREDENTIAL_CLOCK_TOLERANCE_MS,
	epochSecondsToMs,
	isRecordFromFutureClock,
	msToEpochSeconds,
} from "../src/credential-clock";
import {
	ANTHROPIC_THINKING_BUDGETS,
	BEDROCK_CLAUDE_THINKING_BUDGETS,
	GOOGLE_THINKING_BUDGETS,
	resolveThinkingBudget,
} from "../src/reasoning-budget";
import { resolveUsedFraction, type UsageLimit } from "../src/usage";
import {
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	normalizeToolCallId,
	resolveCacheRetention,
	truncateResponseItemId,
} from "../src/utils";

const EFFORTS = THINKING_EFFORTS;

describe("resolveThinkingBudget", () => {
	it("returns default for each effort level", () => {
		for (const effort of EFFORTS) {
			expect(resolveThinkingBudget(effort, ANTHROPIC_THINKING_BUDGETS)).toBe(ANTHROPIC_THINKING_BUDGETS[effort]);
		}
	});

	it("custom overrides default", () => {
		expect(resolveThinkingBudget(Effort.Low, ANTHROPIC_THINKING_BUDGETS, { [Effort.Low]: 999 })).toBe(999);
	});

	it("model overrides default when no custom", () => {
		expect(
			resolveThinkingBudget(Effort.Medium, ANTHROPIC_THINKING_BUDGETS, undefined, { [Effort.Medium]: 777 }),
		).toBe(777);
	});

	it("custom takes precedence over model", () => {
		expect(
			resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, { [Effort.High]: 100 }, { [Effort.High]: 200 }),
		).toBe(100);
	});

	it("undefined custom and model falls back to default", () => {
		expect(resolveThinkingBudget(Effort.Minimal, ANTHROPIC_THINKING_BUDGETS, undefined, undefined)).toBe(1024);
	});

	it("partial custom does not affect other efforts", () => {
		expect(resolveThinkingBudget(Effort.Low, ANTHROPIC_THINKING_BUDGETS, { [Effort.High]: 100 })).toBe(4096);
	});

	it("Bedrock budgets differ from Anthropic at low", () => {
		expect(BEDROCK_CLAUDE_THINKING_BUDGETS.low).toBe(2048);
		expect(ANTHROPIC_THINKING_BUDGETS.low).toBe(4096);
	});

	it("Google xhigh is 24576", () => {
		expect(GOOGLE_THINKING_BUDGETS.xhigh).toBe(24_576);
	});

	it("all schedules have all effort levels", () => {
		for (const effort of EFFORTS) {
			expect(ANTHROPIC_THINKING_BUDGETS[effort]).toBeDefined();
			expect(BEDROCK_CLAUDE_THINKING_BUDGETS[effort]).toBeDefined();
			expect(GOOGLE_THINKING_BUDGETS[effort]).toBeDefined();
		}
	});

	it("budgets are positive integers", () => {
		for (const effort of EFFORTS) {
			expect(ANTHROPIC_THINKING_BUDGETS[effort]).toBeGreaterThan(0);
			expect(Number.isInteger(ANTHROPIC_THINKING_BUDGETS[effort])).toBe(true);
		}
	});

	it("budgets are monotonically non-decreasing", () => {
		const values = EFFORTS.map(e => ANTHROPIC_THINKING_BUDGETS[e]);
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
		}
	});
});

describe("resolveUsedFraction", () => {
	it("returns usedFraction when present", () => {
		const limit: UsageLimit = {
			amount: { usedFraction: 0.5, unit: "percent" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.5);
	});

	it("computes used/limit when both present", () => {
		const limit: UsageLimit = {
			amount: { used: 50, limit: 100, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.5);
	});

	it("returns undefined when used present but limit missing", () => {
		const limit: UsageLimit = {
			amount: { used: 50, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("returns undefined when limit present but used missing", () => {
		const limit: UsageLimit = {
			amount: { limit: 100, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("returns undefined when limit is 0", () => {
		const limit: UsageLimit = {
			amount: { used: 50, limit: 0, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("returns undefined when limit is negative", () => {
		const limit: UsageLimit = {
			amount: { used: 50, limit: -10, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("computes percent from used when unit is percent", () => {
		const limit: UsageLimit = {
			amount: { used: 75, unit: "percent" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.75);
	});

	it("computes from remainingFraction", () => {
		const limit: UsageLimit = {
			amount: { remainingFraction: 0.3, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.7);
	});

	it("clamps remainingFraction to 0 when > 1", () => {
		const limit: UsageLimit = {
			amount: { remainingFraction: 1.5, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0);
	});

	it("usedFraction takes precedence over used/limit", () => {
		const limit: UsageLimit = {
			amount: { usedFraction: 0.9, used: 50, limit: 100, unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.9);
	});

	it("used/limit takes precedence over percent", () => {
		const limit: UsageLimit = {
			amount: { used: 30, limit: 60, unit: "percent" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBe(0.5);
	});

	it("returns undefined when no usable fields", () => {
		const limit: UsageLimit = {
			amount: { unit: "tokens" },
		} as UsageLimit;
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});
});

describe("normalizeSystemPrompts", () => {
	it("returns empty array for undefined", () => {
		expect(normalizeSystemPrompts(undefined)).toEqual([]);
	});

	it("returns empty array for null", () => {
		expect(normalizeSystemPrompts(null)).toEqual([]);
	});

	it("wraps single string in array", () => {
		expect(normalizeSystemPrompts("hello")).toEqual(["hello"]);
	});

	it("returns array as-is (well-formed)", () => {
		expect(normalizeSystemPrompts(["a", "b"])).toEqual(["a", "b"]);
	});

	it("filters out empty strings", () => {
		expect(normalizeSystemPrompts(["a", "", "b"])).toEqual(["a", "b"]);
	});

	it("filters out whitespace-only strings", () => {
		expect(normalizeSystemPrompts(["a", "   ", "b"])).toEqual(["a", "b"]);
	});

	it("returns empty for empty array", () => {
		expect(normalizeSystemPrompts([])).toEqual([]);
	});

	it("returns empty for non-string non-array", () => {
		expect(normalizeSystemPrompts(42 as unknown as string)).toEqual([]);
	});

	it("preserves whitespace within non-empty prompts", () => {
		expect(normalizeSystemPrompts(["  hello world  "])).toEqual(["  hello world  "]);
	});
});

describe("normalizeToolCallId", () => {
	it("returns alphanumeric id unchanged", () => {
		expect(normalizeToolCallId("call_123")).toBe("call_123");
	});

	it("replaces special characters with underscore", () => {
		expect(normalizeToolCallId("call.123!@#")).toBe("call_123___");
	});

	it("preserves hyphens", () => {
		expect(normalizeToolCallId("call-123")).toBe("call-123");
	});

	it("truncates to 64 characters", () => {
		const long = "a".repeat(100);
		expect(normalizeToolCallId(long).length).toBe(64);
	});

	it("preserves short ids", () => {
		expect(normalizeToolCallId("abc")).toBe("abc");
	});

	it("handles empty string", () => {
		expect(normalizeToolCallId("")).toBe("");
	});
});

describe("truncateResponseItemId", () => {
	it("returns short id unchanged", () => {
		expect(truncateResponseItemId("short_id", "call")).toBe("short_id");
	});

	it("truncates long id with hash prefix", () => {
		const long = "x".repeat(100);
		const result = truncateResponseItemId(long, "call");
		expect(result.startsWith("call_")).toBe(true);
		expect(result.length).toBeLessThan(long.length);
	});

	it("returns id at exactly 64 chars unchanged", () => {
		const exact = "a".repeat(64);
		expect(truncateResponseItemId(exact, "call")).toBe(exact);
	});

	it("truncates id at 65 chars", () => {
		const over = "a".repeat(65);
		const result = truncateResponseItemId(over, "fc");
		expect(result.startsWith("fc_")).toBe(true);
	});
});

describe("normalizeResponsesToolCallId", () => {
	it("splits pipe-separated id", () => {
		const result = normalizeResponsesToolCallId("call_abc|fc_xyz");
		expect(result.callId).toBe("call_abc");
		expect(result.itemId).toBe("fc_xyz");
	});

	it("uses default fc prefix for itemId", () => {
		const result = normalizeResponsesToolCallId("call_abc|fc_xyz");
		expect(result.itemId.startsWith("fc_")).toBe(true);
	});

	it("uses ctc prefix when specified", () => {
		const result = normalizeResponsesToolCallId("call_abc|ctc_xyz", "ctc");
		expect(result.itemId.startsWith("ctc_")).toBe(true);
	});

	it("generates callId from hash when no pipe", () => {
		const result = normalizeResponsesToolCallId("simple_id");
		expect(result.callId).toBeDefined();
		expect(result.itemId).toBeDefined();
	});

	it("generates itemId with fc prefix from hash when no pipe", () => {
		const result = normalizeResponsesToolCallId("simple_id");
		expect(result.itemId.startsWith("fc_")).toBe(true);
	});

	it("preserves call_ prefix when no pipe", () => {
		const result = normalizeResponsesToolCallId("call_abc123");
		expect(result.callId).toBe("call_abc123");
	});

	it("produces deterministic output for same input", () => {
		const r1 = normalizeResponsesToolCallId("test_id");
		const r2 = normalizeResponsesToolCallId("test_id");
		expect(r1).toEqual(r2);
	});
});

describe("resolveCacheRetention", () => {
	const originalRetention = process.env.VEYYON_CACHE_RETENTION;

	afterEach(() => {
		if (originalRetention === undefined) delete process.env.VEYYON_CACHE_RETENTION;
		else process.env.VEYYON_CACHE_RETENTION = originalRetention;
	});

	it("returns explicit value when provided", () => {
		expect(resolveCacheRetention("long")).toBe("long");
	});

	it("returns explicit short when provided", () => {
		expect(resolveCacheRetention("short")).toBe("short");
	});

	it("returns long when env var is set to long", () => {
		process.env.VEYYON_CACHE_RETENTION = "long";
		expect(resolveCacheRetention()).toBe("long");
	});

	it("returns short by default when env var not set", () => {
		delete process.env.VEYYON_CACHE_RETENTION;
		expect(resolveCacheRetention()).toBe("short");
	});
});

describe("isRecordFromFutureClock", () => {
	it("returns false for undefined writtenAt", () => {
		expect(isRecordFromFutureClock(undefined, 1000)).toBe(false);
	});

	it("returns false for NaN writtenAt", () => {
		expect(isRecordFromFutureClock(NaN, 1000)).toBe(false);
	});

	it("returns false for Infinity writtenAt", () => {
		expect(isRecordFromFutureClock(Infinity, 1000)).toBe(false);
	});

	it("returns false when writtenAt is in the past", () => {
		expect(isRecordFromFutureClock(500, 1000)).toBe(false);
	});

	it("returns false when writtenAt is within tolerance", () => {
		expect(isRecordFromFutureClock(1000 + CREDENTIAL_CLOCK_TOLERANCE_MS, 1000)).toBe(false);
	});

	it("returns true when writtenAt exceeds tolerance", () => {
		expect(isRecordFromFutureClock(1000 + CREDENTIAL_CLOCK_TOLERANCE_MS + 1, 1000)).toBe(true);
	});

	it("returns false when writtenAt equals now", () => {
		expect(isRecordFromFutureClock(1000, 1000)).toBe(false);
	});
});

describe("epochSecondsToMs", () => {
	it("converts seconds to milliseconds", () => {
		expect(epochSecondsToMs(100)).toBe(100_000);
	});

	it("returns undefined for undefined input", () => {
		expect(epochSecondsToMs(undefined)).toBeUndefined();
	});

	it("returns undefined for NaN", () => {
		expect(epochSecondsToMs(NaN)).toBeUndefined();
	});

	it("returns undefined for Infinity", () => {
		expect(epochSecondsToMs(Infinity)).toBeUndefined();
	});

	it("handles 0", () => {
		expect(epochSecondsToMs(0)).toBe(0);
	});

	it("handles negative seconds", () => {
		expect(epochSecondsToMs(-1)).toBe(-1000);
	});

	it("handles fractional seconds", () => {
		expect(epochSecondsToMs(1.5)).toBe(1500);
	});
});

describe("msToEpochSeconds", () => {
	it("converts milliseconds to seconds (floor)", () => {
		expect(msToEpochSeconds(1500)).toBe(1);
	});

	it("handles 0", () => {
		expect(msToEpochSeconds(0)).toBe(0);
	});

	it("handles exact second", () => {
		expect(msToEpochSeconds(1000)).toBe(1);
	});

	it("handles large values", () => {
		expect(msToEpochSeconds(1_600_000_000_000)).toBe(1_600_000_000);
	});

	it("floors fractional milliseconds", () => {
		expect(msToEpochSeconds(999)).toBe(0);
	});

	it("handles negative values", () => {
		expect(msToEpochSeconds(-1000)).toBe(-1);
	});
});
