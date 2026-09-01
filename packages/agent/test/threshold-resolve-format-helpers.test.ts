import { describe, expect, it } from "bun:test";
import {
	AUTO_COMPACTION_THRESHOLD,
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	formatCompactionThreshold,
	isThresholdTokensClampedForWindow,
	parseCompactionThreshold,
	type ResolvedCompactionThreshold,
	resolveBudgetReserveTokens,
	resolveCompactionThreshold,
	resolveThresholdTokens,
	shouldCompact,
	withLegacyCompactionThreshold,
} from "../src/compaction/threshold";

const defaultSettings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };

describe("parseCompactionThreshold", () => {
	it("returns auto for undefined", () => {
		expect(parseCompactionThreshold(undefined)).toEqual({ kind: "auto" });
	});
	it("returns auto for null", () => {
		expect(parseCompactionThreshold(null)).toEqual({ kind: "auto" });
	});
	it("returns tokens for positive number", () => {
		expect(parseCompactionThreshold(5000)).toEqual({ kind: "tokens", tokens: 5000 });
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
	it("returns auto for 'AUTO' string (case insensitive)", () => {
		expect(parseCompactionThreshold("AUTO")).toEqual({ kind: "auto" });
	});
	it("returns auto for '  auto  ' string (trimmed)", () => {
		expect(parseCompactionThreshold("  auto  ")).toEqual({ kind: "auto" });
	});
	it("returns percent for '50%'", () => {
		expect(parseCompactionThreshold("50%")).toEqual({ kind: "percent", percent: 50 });
	});
	it("returns percent for '50 %' (space before %)", () => {
		expect(parseCompactionThreshold("50 %")).toEqual({ kind: "percent", percent: 50 });
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
	it("returns tokens for '10000'", () => {
		expect(parseCompactionThreshold("10000")).toEqual({ kind: "tokens", tokens: 10000 });
	});
	it("returns tokens for '10_000' (underscores stripped)", () => {
		expect(parseCompactionThreshold("10_000")).toEqual({ kind: "tokens", tokens: 10000 });
	});
	it("returns auto with invalidRaw for non-numeric string", () => {
		expect(parseCompactionThreshold("abc")).toEqual({ kind: "auto", invalidRaw: "abc" });
	});
	it("returns auto for '0' string", () => {
		expect(parseCompactionThreshold("0")).toEqual({ kind: "auto" });
	});
	it("returns auto for '-100' string", () => {
		expect(parseCompactionThreshold("-100")).toEqual({ kind: "auto" });
	});
});

describe("withLegacyCompactionThreshold", () => {
	it("returns auto when no inputs provided", () => {
		expect(withLegacyCompactionThreshold({})).toEqual({ spec: { kind: "auto" } });
	});
	it("uses threshold when provided", () => {
		const result = withLegacyCompactionThreshold({ threshold: "50%" });
		expect(result.spec).toEqual({ kind: "percent", percent: 50 });
		expect(result.legacyKey).toBeUndefined();
	});
	it("falls back to thresholdTokens when threshold is auto", () => {
		const result = withLegacyCompactionThreshold({ threshold: "auto", thresholdTokens: 5000 });
		expect(result.spec).toEqual({ kind: "tokens", tokens: 5000 });
		expect(result.legacyKey).toBe("thresholdTokens");
	});
	it("falls back to thresholdPercent when threshold and thresholdTokens are auto", () => {
		const result = withLegacyCompactionThreshold({ thresholdPercent: 75 });
		expect(result.spec).toEqual({ kind: "percent", percent: 75 });
		expect(result.legacyKey).toBe("thresholdPercent");
	});
	it("threshold takes priority over legacy", () => {
		const result = withLegacyCompactionThreshold({
			threshold: "10000",
			thresholdTokens: 5000,
			thresholdPercent: 50,
		});
		expect(result.spec).toEqual({ kind: "tokens", tokens: 10000 });
		expect(result.legacyKey).toBeUndefined();
	});
	it("invalidRaw threshold prevents fallback", () => {
		const result = withLegacyCompactionThreshold({ threshold: "abc", thresholdTokens: 5000 });
		expect(result.spec).toEqual({ kind: "auto", invalidRaw: "abc" });
	});
	it("thresholdTokens of 0 does not produce tokens spec", () => {
		const result = withLegacyCompactionThreshold({ thresholdTokens: 0 });
		expect(result.spec).toEqual({ kind: "auto" });
	});
	it("thresholdPercent of 0 does not produce percent spec", () => {
		const result = withLegacyCompactionThreshold({ thresholdPercent: 0 });
		expect(result.spec).toEqual({ kind: "auto" });
	});
	it("thresholdPercent negative does not produce percent spec", () => {
		const result = withLegacyCompactionThreshold({ thresholdPercent: -10 });
		expect(result.spec).toEqual({ kind: "auto" });
	});
});

describe("resolveCompactionThreshold", () => {
	const ctxWindow = 100_000;
	const autoTokens = () => 80_000;

	it("resolves auto origin", () => {
		const result = resolveCompactionThreshold(ctxWindow, {}, autoTokens);
		expect(result.origin).toBe("auto");
		expect(result.tokens).toBe(80_000);
		expect(result.clamped).toBe(false);
	});
	it("resolves tokens origin", () => {
		const result = resolveCompactionThreshold(ctxWindow, { threshold: "50000" }, autoTokens);
		expect(result.origin).toBe("tokens");
		expect(result.tokens).toBe(50_000);
		expect(result.configured).toBe(50_000);
		expect(result.clamped).toBe(false);
	});
	it("resolves percent origin", () => {
		const result = resolveCompactionThreshold(ctxWindow, { threshold: "50%" }, autoTokens);
		expect(result.origin).toBe("percent");
		expect(result.tokens).toBe(50_000);
		expect(result.configured).toBe(50);
		expect(result.clamped).toBe(false);
	});
	it("clamps percent to min 1", () => {
		const result = resolveCompactionThreshold(ctxWindow, { threshold: "0.5%" }, autoTokens);
		expect(result.configured).toBe(0.5);
		expect(result.clamped).toBe(true);
		expect(result.tokens).toBe(Math.floor(ctxWindow * (1 / 100)));
	});
	it("clamps percent to max 99", () => {
		const result = resolveCompactionThreshold(ctxWindow, { threshold: "150%" }, autoTokens);
		expect(result.configured).toBe(150);
		expect(result.clamped).toBe(true);
		expect(result.tokens).toBe(Math.floor(ctxWindow * (99 / 100)));
	});
	it("clamps tokens to contextWindow - 1", () => {
		const result = resolveCompactionThreshold(ctxWindow, { threshold: "200000" }, autoTokens);
		expect(result.tokens).toBeLessThan(ctxWindow);
		expect(result.clamped).toBe(true);
	});
	it("preserves legacyKey from legacy inputs", () => {
		const result = resolveCompactionThreshold(ctxWindow, { thresholdTokens: 50000 }, autoTokens);
		expect(result.legacyKey).toBe("thresholdTokens");
	});
	it("auto tokens clamped to contextWindow - 1", () => {
		const bigAuto = () => 200_000;
		const result = resolveCompactionThreshold(ctxWindow, {}, bigAuto);
		expect(result.tokens).toBe(ctxWindow - 1);
	});
});

describe("formatCompactionThreshold", () => {
	it("formats auto origin", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 80000,
			origin: "auto",
			clamped: false,
		};
		expect(formatCompactionThreshold(resolved, 100000)).toContain("80k");
		expect(formatCompactionThreshold(resolved, 100000)).toContain("auto");
	});
	it("formats percent origin", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 50000,
			origin: "percent",
			configured: 50,
			clamped: false,
		};
		const formatted = formatCompactionThreshold(resolved, 100000);
		expect(formatted).toContain("50%");
		expect(formatted).toContain("50k");
	});
	it("formats tokens origin not clamped", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 50000,
			origin: "tokens",
			configured: 50000,
			clamped: false,
		};
		expect(formatCompactionThreshold(resolved, 100000)).toContain("fixed");
	});
	it("formats tokens origin clamped", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 99000,
			origin: "tokens",
			configured: 200000,
			clamped: true,
		};
		const formatted = formatCompactionThreshold(resolved, 100000);
		expect(formatted).toContain("capped");
	});
	it("formats millions with M suffix", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 1_500_000,
			origin: "auto",
			clamped: false,
		};
		expect(formatCompactionThreshold(resolved, 2_000_000)).toContain("1.5M");
	});
	it("formats exact millions without decimal", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 2_000_000,
			origin: "auto",
			clamped: false,
		};
		expect(formatCompactionThreshold(resolved, 2_000_000)).toContain("2M");
	});
	it("formats small token counts without suffix", () => {
		const resolved: ResolvedCompactionThreshold = {
			tokens: 500,
			origin: "auto",
			clamped: false,
		};
		expect(formatCompactionThreshold(resolved, 1000)).toContain("500");
	});
});

describe("effectiveReserveTokens", () => {
	it("returns max of 15% of contextWindow and configured reserve", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: 5000 };
		expect(effectiveReserveTokens(100_000, settings)).toBe(15_000);
	});
	it("returns configured when larger than 15%", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: 20_000 };
		expect(effectiveReserveTokens(100_000, settings)).toBe(20_000);
	});
	it("uses default reserve when undefined", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: undefined };
		expect(effectiveReserveTokens(100_000, settings)).toBe(16_384);
	});
	it("returns 15% for very small context window", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: 100 };
		expect(effectiveReserveTokens(1000, settings)).toBe(150);
	});
});

describe("resolveBudgetReserveTokens", () => {
	it("returns effective reserve when valid", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: 5000 };
		expect(resolveBudgetReserveTokens(100_000, settings)).toBe(15_000);
	});
	it("returns proportional reserve when default is impossible", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: undefined };
		const result = resolveBudgetReserveTokens(10_000, settings);
		expect(result).toBe(1500);
	});
	it("returns proportional reserve when reserve exceeds window", () => {
		const settings: CompactionSettings = { ...defaultSettings, reserveTokens: 100_000 };
		expect(resolveBudgetReserveTokens(100_000, settings)).toBe(15_000);
	});
});

describe("shouldCompact", () => {
	it("returns false when disabled", () => {
		const settings: CompactionSettings = { ...defaultSettings, enabled: false };
		expect(shouldCompact(50_000, 100_000, settings)).toBe(false);
	});
	it("returns false when contextWindow is 0", () => {
		expect(shouldCompact(50, 0, defaultSettings)).toBe(false);
	});
	it("returns true when contextTokens exceeds threshold", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50%" };
		expect(shouldCompact(60_000, 100_000, settings)).toBe(true);
	});
	it("returns false when contextTokens equals threshold", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50%" };
		expect(shouldCompact(50_000, 100_000, settings)).toBe(false);
	});
	it("returns false when contextTokens below threshold", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50%" };
		expect(shouldCompact(40_000, 100_000, settings)).toBe(false);
	});
});

describe("resolveThresholdTokens", () => {
	it("returns token count for percent threshold", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50%" };
		expect(resolveThresholdTokens(100_000, settings)).toBe(50_000);
	});
	it("returns token count for tokens threshold", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "30000" };
		expect(resolveThresholdTokens(100_000, settings)).toBe(30_000);
	});
	it("returns auto threshold tokens", () => {
		const tokens = resolveThresholdTokens(100_000, defaultSettings);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(100_000);
	});
});

describe("isThresholdTokensClampedForWindow", () => {
	it("returns false for percent origin", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50%" };
		expect(isThresholdTokensClampedForWindow(100_000, settings)).toBe(false);
	});
	it("returns false for auto origin", () => {
		expect(isThresholdTokensClampedForWindow(100_000, defaultSettings)).toBe(false);
	});
	it("returns false for tokens within window", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "50000" };
		expect(isThresholdTokensClampedForWindow(100_000, settings)).toBe(false);
	});
	it("returns true for tokens exceeding window", () => {
		const settings: CompactionSettings = { ...defaultSettings, threshold: "200000" };
		expect(isThresholdTokensClampedForWindow(100_000, settings)).toBe(true);
	});
});

describe("DEFAULT_COMPACTION_SETTINGS", () => {
	it("has enabled true", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
	});
	it("has strategy summary", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.strategy).toBe("summary");
	});
	it("has threshold auto", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.threshold).toBe(AUTO_COMPACTION_THRESHOLD);
	});
	it("has keepRecentTokens 10000", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(10000);
	});
	it("has autoContinue true", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.autoContinue).toBe(true);
	});
	it("has DEFAULT_RESERVE_TOKENS 16384", () => {
		expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
	});
});
