import { describe, expect, it } from "bun:test";
import {
	AUTO_COMPACTION_THRESHOLD,
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	formatCompactionThreshold,
	isThresholdTokensClampedForWindow,
	type LegacyThresholdInputs,
	parseCompactionThreshold,
	resolveBudgetReserveTokens,
	resolveCompactionThreshold,
	resolveThresholdTokens,
	resolveThresholdWithOrigin,
	shouldCompact,
	withLegacyCompactionThreshold,
} from "../src/compaction/threshold";

describe("parseCompactionThreshold", () => {
	it("returns auto for undefined", () => {
		expect(parseCompactionThreshold(undefined)).toEqual({ kind: "auto" });
	});

	it("returns auto for null", () => {
		expect(parseCompactionThreshold(null)).toEqual({ kind: "auto" });
	});

	it("returns tokens for positive number", () => {
		expect(parseCompactionThreshold(50000)).toEqual({ kind: "tokens", tokens: 50000 });
	});

	it("returns auto for zero number", () => {
		expect(parseCompactionThreshold(0)).toEqual({ kind: "auto" });
	});

	it("returns auto for negative number", () => {
		expect(parseCompactionThreshold(-100)).toEqual({ kind: "auto" });
	});

	it("returns auto for NaN", () => {
		expect(parseCompactionThreshold(NaN)).toEqual({ kind: "auto" });
	});

	it("returns auto for Infinity", () => {
		expect(parseCompactionThreshold(Infinity)).toEqual({ kind: "auto" });
	});

	it("returns auto for empty string", () => {
		expect(parseCompactionThreshold("")).toEqual({ kind: "auto" });
	});

	it("returns auto for 'auto' string", () => {
		expect(parseCompactionThreshold("auto")).toEqual({ kind: "auto" });
	});

	it("returns auto for 'default' string", () => {
		expect(parseCompactionThreshold("default")).toEqual({ kind: "auto" });
	});

	it("returns auto for 'AUTO' (case-insensitive)", () => {
		expect(parseCompactionThreshold("AUTO")).toEqual({ kind: "auto" });
	});

	it("returns auto for '  auto  ' (whitespace trimmed)", () => {
		expect(parseCompactionThreshold("  auto  ")).toEqual({ kind: "auto" });
	});

	it("returns percent for '50%'", () => {
		expect(parseCompactionThreshold("50%")).toEqual({ kind: "percent", percent: 50 });
	});

	it("returns percent for '75%'", () => {
		expect(parseCompactionThreshold("75%")).toEqual({ kind: "percent", percent: 75 });
	});

	it("returns auto for '0%'", () => {
		expect(parseCompactionThreshold("0%")).toEqual({ kind: "auto" });
	});

	it("returns auto for '-5%'", () => {
		expect(parseCompactionThreshold("-5%")).toEqual({ kind: "auto" });
	});

	it("returns auto for 'abc%'", () => {
		expect(parseCompactionThreshold("abc%")).toEqual({ kind: "auto" });
	});

	it("returns tokens for numeric string", () => {
		expect(parseCompactionThreshold("50000")).toEqual({ kind: "tokens", tokens: 50000 });
	});

	it("returns tokens for string with underscores", () => {
		expect(parseCompactionThreshold("50_000")).toEqual({ kind: "tokens", tokens: 50000 });
	});

	it("returns auto with invalidRaw for non-numeric string", () => {
		const result = parseCompactionThreshold("abc");
		expect(result.kind).toBe("auto");
		expect(result).toHaveProperty("invalidRaw", "abc");
	});

	it("returns auto for '0' string", () => {
		expect(parseCompactionThreshold("0")).toEqual({ kind: "auto" });
	});

	it("returns auto for '-100' string", () => {
		expect(parseCompactionThreshold("-100")).toEqual({ kind: "auto" });
	});

	it("returns percent for '  50  %  ' (whitespace within)", () => {
		expect(parseCompactionThreshold("  50  %  ")).toEqual({ kind: "percent", percent: 50 });
	});
});

describe("withLegacyCompactionThreshold", () => {
	it("uses threshold when not auto", () => {
		const result = withLegacyCompactionThreshold({ threshold: "50%" });
		expect(result.spec).toEqual({ kind: "percent", percent: 50 });
		expect(result.legacyKey).toBeUndefined();
	});

	it("uses threshold when it has invalidRaw", () => {
		const result = withLegacyCompactionThreshold({ threshold: "abc" });
		expect(result.spec.kind).toBe("auto");
		expect(result.spec).toHaveProperty("invalidRaw", "abc");
		expect(result.legacyKey).toBeUndefined();
	});

	it("falls back to thresholdTokens when threshold is auto", () => {
		const result = withLegacyCompactionThreshold({ threshold: "auto", thresholdTokens: 50000 });
		expect(result.spec).toEqual({ kind: "tokens", tokens: 50000 });
		expect(result.legacyKey).toBe("thresholdTokens");
	});

	it("falls back to thresholdPercent when threshold and thresholdTokens are auto", () => {
		const result = withLegacyCompactionThreshold({
			threshold: "auto",
			thresholdPercent: 75,
		});
		expect(result.spec).toEqual({ kind: "percent", percent: 75 });
		expect(result.legacyKey).toBe("thresholdPercent");
	});

	it("returns auto when all inputs are missing", () => {
		const result = withLegacyCompactionThreshold({});
		expect(result.spec).toEqual({ kind: "auto" });
		expect(result.legacyKey).toBeUndefined();
	});

	it("returns auto when thresholdTokens is invalid", () => {
		const result = withLegacyCompactionThreshold({ threshold: undefined, thresholdTokens: -1 });
		expect(result.spec).toEqual({ kind: "auto" });
		expect(result.legacyKey).toBeUndefined();
	});

	it("returns auto when thresholdPercent is invalid", () => {
		const result = withLegacyCompactionThreshold({ thresholdPercent: -5 });
		expect(result.spec).toEqual({ kind: "auto" });
		expect(result.legacyKey).toBeUndefined();
	});

	it("returns auto when thresholdPercent is NaN", () => {
		const result = withLegacyCompactionThreshold({ thresholdPercent: NaN });
		expect(result.spec).toEqual({ kind: "auto" });
		expect(result.legacyKey).toBeUndefined();
	});

	it("prefers threshold over legacy fields", () => {
		const result = withLegacyCompactionThreshold({
			threshold: "30%",
			thresholdTokens: 50000,
			thresholdPercent: 75,
		});
		expect(result.spec).toEqual({ kind: "percent", percent: 30 });
		expect(result.legacyKey).toBeUndefined();
	});
});

describe("resolveCompactionThreshold", () => {
	const inputs: LegacyThresholdInputs = { threshold: "50%" };

	it("resolves percent threshold", () => {
		const result = resolveCompactionThreshold(200000, inputs, () => 180000);
		expect(result.origin).toBe("percent");
		expect(result.tokens).toBe(100000);
		expect(result.configured).toBe(50);
		expect(result.clamped).toBe(false);
	});

	it("clamps percent to min 1", () => {
		const result = resolveCompactionThreshold(200000, { threshold: "0.5%" }, () => 180000);
		expect(result.origin).toBe("percent");
		expect(result.tokens).toBe(2000);
		expect(result.clamped).toBe(true);
	});

	it("clamps percent to max 99", () => {
		const result = resolveCompactionThreshold(200000, { threshold: "150%" }, () => 180000);
		expect(result.origin).toBe("percent");
		expect(result.tokens).toBe(198000);
		expect(result.clamped).toBe(true);
	});

	it("resolves tokens threshold", () => {
		const result = resolveCompactionThreshold(200000, { threshold: 50000 }, () => 180000);
		expect(result.origin).toBe("tokens");
		expect(result.tokens).toBe(50000);
		expect(result.configured).toBe(50000);
		expect(result.clamped).toBe(false);
	});

	it("clamps tokens to context window minus 1", () => {
		const result = resolveCompactionThreshold(200000, { threshold: 300000 }, () => 180000);
		expect(result.origin).toBe("tokens");
		expect(result.tokens).toBeLessThan(200000);
		expect(result.clamped).toBe(true);
	});

	it("resolves auto threshold", () => {
		const result = resolveCompactionThreshold(200000, { threshold: "auto" }, () => 180000);
		expect(result.origin).toBe("auto");
		expect(result.tokens).toBe(180000);
		expect(result.clamped).toBe(false);
	});

	it("preserves invalidRaw in auto resolution", () => {
		const result = resolveCompactionThreshold(200000, { threshold: "abc" }, () => 180000);
		expect(result.origin).toBe("auto");
		expect(result.invalidRaw).toBe("abc");
	});

	it("preserves legacyKey from withLegacyCompactionThreshold", () => {
		const result = resolveCompactionThreshold(200000, { thresholdTokens: 50000 }, () => 180000);
		expect(result.legacyKey).toBe("thresholdTokens");
		expect(result.origin).toBe("tokens");
	});

	it("clamps auto tokens to context window minus 1", () => {
		const result = resolveCompactionThreshold(200000, { threshold: "auto" }, () => 250000);
		expect(result.tokens).toBe(199999);
	});
});

describe("formatCompactionThreshold", () => {
	it("formats percent origin", () => {
		const resolved = resolveCompactionThreshold(200000, { threshold: "50%" }, () => 180000);
		const formatted = formatCompactionThreshold(resolved, 200000);
		expect(formatted).toContain("100k");
		expect(formatted).toContain("50%");
		expect(formatted).toContain("200k");
	});

	it("formats tokens origin (not clamped)", () => {
		const resolved = resolveCompactionThreshold(200000, { threshold: 50000 }, () => 180000);
		const formatted = formatCompactionThreshold(resolved, 200000);
		expect(formatted).toContain("50k");
		expect(formatted).toContain("fixed");
	});

	it("formats tokens origin (clamped)", () => {
		const resolved = resolveCompactionThreshold(200000, { threshold: 300000 }, () => 180000);
		const formatted = formatCompactionThreshold(resolved, 200000);
		expect(formatted).toContain("capped");
		expect(formatted).toContain("200k");
	});

	it("formats auto origin", () => {
		const resolved = resolveCompactionThreshold(200000, { threshold: "auto" }, () => 180000);
		const formatted = formatCompactionThreshold(resolved, 200000);
		expect(formatted).toContain("auto");
		expect(formatted).toContain("200k");
	});

	it("formats million-scale tokens", () => {
		const resolved = resolveCompactionThreshold(2_000_000, { threshold: "50%" }, () => 1_800_000);
		const formatted = formatCompactionThreshold(resolved, 2_000_000);
		expect(formatted).toContain("M");
	});

	it("formats small token counts without k suffix", () => {
		const resolved = resolveCompactionThreshold(500, { threshold: "50%" }, () => 400);
		const formatted = formatCompactionThreshold(resolved, 500);
		expect(formatted).toMatch(/\b250\b/);
	});
});

describe("effectiveReserveTokens", () => {
	it("returns 15% of context window when larger than default", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
		expect(effectiveReserveTokens(200000, settings)).toBe(30000);
	});

	it("returns default when 15% is smaller", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
		expect(effectiveReserveTokens(50000, settings)).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("uses custom reserveTokens when provided", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 5000 };
		expect(effectiveReserveTokens(200000, settings)).toBe(30000);
	});

	it("uses custom reserveTokens when larger than 15%", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 50000 };
		expect(effectiveReserveTokens(200000, settings)).toBe(50000);
	});
});

describe("resolveBudgetReserveTokens", () => {
	it("returns effective reserve when valid", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
		expect(resolveBudgetReserveTokens(200000, settings)).toBe(30000);
	});

	it("returns proportional reserve when default reserve is impossible", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: undefined };
		// Very small context window where default reserve would be impossible
		expect(resolveBudgetReserveTokens(100, settings)).toBe(15);
	});

	it("returns proportional reserve when reserve exceeds window", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 200000 };
		expect(resolveBudgetReserveTokens(200000, settings)).toBe(30000);
	});

	it("returns custom reserve when it is reasonable", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 10000 };
		expect(resolveBudgetReserveTokens(200000, settings)).toBe(30000);
	});
});

describe("shouldCompact", () => {
	it("returns false when compaction is disabled", () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: false };
		expect(shouldCompact(100000, 200000, settings)).toBe(false);
	});

	it("returns false when context window is 0", () => {
		expect(shouldCompact(100, 0, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});

	it("returns false when context tokens are below threshold", () => {
		expect(shouldCompact(50000, 200000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});

	it("returns true when context tokens exceed threshold", () => {
		// Default auto threshold = 200000 - reserve(30000) = 170000
		expect(shouldCompact(180000, 200000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
	});

	it("returns false when context tokens equal threshold", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50%" };
		// 50% of 200000 = 100000, shouldCompact uses > not >=
		expect(shouldCompact(100000, 200000, settings)).toBe(false);
	});

	it("returns true when context tokens just exceed threshold", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50%" };
		expect(shouldCompact(100001, 200000, settings)).toBe(true);
	});
});

describe("resolveThresholdWithOrigin", () => {
	it("resolves with auto origin for default settings", () => {
		const result = resolveThresholdWithOrigin(200000, DEFAULT_COMPACTION_SETTINGS);
		expect(result.origin).toBe("auto");
		expect(result.tokens).toBeGreaterThan(0);
	});

	it("resolves with percent origin for percent threshold", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50%" };
		const result = resolveThresholdWithOrigin(200000, settings);
		expect(result.origin).toBe("percent");
		expect(result.tokens).toBe(100000);
	});

	it("resolves with tokens origin for fixed token threshold", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50000" };
		const result = resolveThresholdWithOrigin(200000, settings);
		expect(result.origin).toBe("tokens");
		expect(result.tokens).toBe(50000);
	});
});

describe("resolveThresholdTokens", () => {
	it("returns just the token count", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50%" };
		expect(resolveThresholdTokens(200000, settings)).toBe(100000);
	});

	it("returns auto threshold tokens", () => {
		const tokens = resolveThresholdTokens(200000, DEFAULT_COMPACTION_SETTINGS);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(200000);
	});
});

describe("isThresholdTokensClampedForWindow", () => {
	it("returns false for auto origin", () => {
		expect(isThresholdTokensClampedForWindow(200000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});

	it("returns false for percent origin", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50%" };
		expect(isThresholdTokensClampedForWindow(200000, settings)).toBe(false);
	});

	it("returns false for tokens origin that is not clamped", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "50000" };
		expect(isThresholdTokensClampedForWindow(200000, settings)).toBe(false);
	});

	it("returns true for tokens origin that is clamped", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, threshold: "300000" };
		expect(isThresholdTokensClampedForWindow(200000, settings)).toBe(true);
	});
});

describe("DEFAULT_COMPACTION_SETTINGS", () => {
	it("has enabled set to true", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
	});

	it("has strategy set to summary", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.strategy).toBe("summary");
	});

	it("has threshold set to auto", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.threshold).toBe(AUTO_COMPACTION_THRESHOLD);
	});

	it("has keepRecentTokens set to 10000", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(10000);
	});

	it("has autoContinue set to true", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.autoContinue).toBe(true);
	});

	it("has midTurnEnabled set to true", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.midTurnEnabled).toBe(true);
	});
});
