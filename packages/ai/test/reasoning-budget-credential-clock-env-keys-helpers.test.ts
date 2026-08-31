import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import {
	CREDENTIAL_CLOCK_TOLERANCE_MS,
	epochSecondsToMs,
	isRecordFromFutureClock,
	msToEpochSeconds,
} from "../src/credential-clock";
import { AUTHENTICATED_API_KEY_SENTINEL, PROVIDER_ENV_KEY_OVERRIDES } from "../src/provider-env-keys";
import {
	ANTHROPIC_THINKING_BUDGETS,
	BEDROCK_CLAUDE_THINKING_BUDGETS,
	GOOGLE_THINKING_BUDGETS,
	resolveThinkingBudget,
} from "../src/reasoning-budget";

describe("ANTHROPIC_THINKING_BUDGETS", () => {
	it("has budget for minimal", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.minimal).toBe(1024);
	});
	it("has budget for low", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.low).toBe(4096);
	});
	it("has budget for medium", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.medium).toBe(8192);
	});
	it("has budget for high", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.high).toBe(16_384);
	});
	it("has budget for xhigh", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.xhigh).toBe(32_768);
	});
	it("has budget for max", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.max).toBe(32_768);
	});
	it("xhigh and max are the same", () => {
		expect(ANTHROPIC_THINKING_BUDGETS.xhigh).toBe(ANTHROPIC_THINKING_BUDGETS.max);
	});
});

describe("BEDROCK_CLAUDE_THINKING_BUDGETS", () => {
	it("has budget for minimal", () => {
		expect(BEDROCK_CLAUDE_THINKING_BUDGETS.minimal).toBe(1024);
	});
	it("has lower low budget than anthropic", () => {
		expect(BEDROCK_CLAUDE_THINKING_BUDGETS.low).toBe(2048);
		expect(BEDROCK_CLAUDE_THINKING_BUDGETS.low).toBeLessThan(ANTHROPIC_THINKING_BUDGETS.low);
	});
	it("has budget for max", () => {
		expect(BEDROCK_CLAUDE_THINKING_BUDGETS.max).toBe(32_768);
	});
});

describe("GOOGLE_THINKING_BUDGETS", () => {
	it("has budget for minimal", () => {
		expect(GOOGLE_THINKING_BUDGETS.minimal).toBe(1024);
	});
	it("has budget for xhigh with 24576 ceiling", () => {
		expect(GOOGLE_THINKING_BUDGETS.xhigh).toBe(24_576);
	});
	it("has budget for max", () => {
		expect(GOOGLE_THINKING_BUDGETS.max).toBe(32_768);
	});
	it("xhigh differs from anthropic", () => {
		expect(GOOGLE_THINKING_BUDGETS.xhigh).not.toBe(ANTHROPIC_THINKING_BUDGETS.xhigh);
	});
});

describe("resolveThinkingBudget", () => {
	it("returns default when no custom or model", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS)).toBe(16_384);
	});
	it("returns custom when provided", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, { high: 99_999 })).toBe(99_999);
	});
	it("returns model when provided and no custom", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, undefined, { high: 50_000 })).toBe(50_000);
	});
	it("custom takes priority over model", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, { high: 99_999 }, { high: 50_000 })).toBe(
			99_999,
		);
	});
	it("returns default when custom does not have the effort", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, { low: 100 })).toBe(16_384);
	});
	it("returns model when custom does not have the effort but model does", () => {
		expect(resolveThinkingBudget(Effort.High, ANTHROPIC_THINKING_BUDGETS, { low: 100 }, { high: 50_000 })).toBe(
			50_000,
		);
	});
	it("returns default for minimal effort", () => {
		expect(resolveThinkingBudget(Effort.Minimal, ANTHROPIC_THINKING_BUDGETS)).toBe(1024);
	});
});

describe("CREDENTIAL_CLOCK_TOLERANCE_MS", () => {
	it("is 5000", () => {
		expect(CREDENTIAL_CLOCK_TOLERANCE_MS).toBe(5_000);
	});
});

describe("isRecordFromFutureClock", () => {
	it("returns false when writtenAt is in past", () => {
		expect(isRecordFromFutureClock(1000, 2000)).toBe(false);
	});
	it("returns false when writtenAt equals now", () => {
		expect(isRecordFromFutureClock(2000, 2000)).toBe(false);
	});
	it("returns false when writtenAt is within tolerance", () => {
		expect(isRecordFromFutureClock(2000 + CREDENTIAL_CLOCK_TOLERANCE_MS - 1, 2000)).toBe(false);
	});
	it("returns true when writtenAt is beyond tolerance", () => {
		expect(isRecordFromFutureClock(2000 + CREDENTIAL_CLOCK_TOLERANCE_MS + 1, 2000)).toBe(true);
	});
	it("returns false for undefined writtenAt", () => {
		expect(isRecordFromFutureClock(undefined, 2000)).toBe(false);
	});
	it("returns false for NaN writtenAt", () => {
		expect(isRecordFromFutureClock(NaN, 2000)).toBe(false);
	});
	it("returns false for Infinity writtenAt", () => {
		expect(isRecordFromFutureClock(Infinity, 2000)).toBe(false);
	});
});

describe("epochSecondsToMs", () => {
	it("converts seconds to ms", () => {
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
	it("handles zero", () => {
		expect(epochSecondsToMs(0)).toBe(0);
	});
	it("handles fractional seconds", () => {
		expect(epochSecondsToMs(1.5)).toBe(1500);
	});
});

describe("msToEpochSeconds", () => {
	it("converts ms to seconds", () => {
		expect(msToEpochSeconds(100_000)).toBe(100);
	});
	it("floors fractional seconds", () => {
		expect(msToEpochSeconds(1500)).toBe(1);
	});
	it("handles zero", () => {
		expect(msToEpochSeconds(0)).toBe(0);
	});
	it("handles 999ms as 0 seconds", () => {
		expect(msToEpochSeconds(999)).toBe(0);
	});
});

describe("AUTHENTICATED_API_KEY_SENTINEL", () => {
	it("is the sentinel string", () => {
		expect(AUTHENTICATED_API_KEY_SENTINEL).toBe("<authenticated>");
	});
});

describe("PROVIDER_ENV_KEY_OVERRIDES", () => {
	it("has anthropic override", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.anthropic).toBeDefined();
	});
	it("has amazon-bedrock override", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES["amazon-bedrock"]).toBeDefined();
	});
	it("has google-vertex override", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES["google-vertex"]).toBeDefined();
	});
	it("has azure-openai-responses as string key", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES["azure-openai-responses"]).toBe("AZURE_OPENAI_API_KEY");
	});
	it("has brave as string key", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.brave).toBe("BRAVE_API_KEY");
	});
	it("has perplexity as string key", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.perplexity).toBe("PERPLEXITY_API_KEY");
	});
	it("has tavily as string key", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.tavily).toBe("TAVILY_API_KEY");
	});
});
