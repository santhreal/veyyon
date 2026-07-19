import { describe, expect, it } from "bun:test";
import type { CompactionSettings } from "@veyyon/agent-core/compaction/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "@veyyon/agent-core/compaction/compaction";

describe("compaction reserve provenance", () => {
	it("honors an explicit reserve equal to the default on a small window", () => {
		// cw=19000: proportional would be floor(19000*0.15)=2850, but the reserve
		// was explicitly configured — even though it equals DEFAULT_RESERVE_TOKENS,
		// provenance says "user chose this", so it must win.
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		const cw = 19000;
		expect(effectiveReserveTokens(cw, settings)).toBe(16384);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(16384);
		expect(resolveThresholdTokens(cw, settings)).toBe(2616); // 19000 - 16384
		expect(shouldCompact(2616, cw, settings)).toBe(false);
		expect(shouldCompact(2617, cw, settings)).toBe(true);
	});

	it("replaces a defaulted reserve with the proportional fallback on the same window", () => {
		// Identical window, but reserveTokens is unset: 16384 >= 19000 - 2850, so
		// the defaulted reserve is effectively impossible and the 15% proportional
		// reserve (2850) takes over.
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			keepRecentTokens: 20000,
		};
		const cw = 19000;
		expect(effectiveReserveTokens(cw, settings)).toBe(16384);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2850); // floor(19000 * 0.15)
		expect(resolveThresholdTokens(cw, settings)).toBe(16150); // 19000 - 2850
		expect(shouldCompact(16150, cw, settings)).toBe(false);
		expect(shouldCompact(16151, cw, settings)).toBe(true);
	});

	it("keeps defaulted provenance when spreading DEFAULT_COMPACTION_SETTINGS", () => {
		// Spreading the defaults must not materialize reserveTokens; the spread
		// settings behave exactly like the omitted-field literal above.
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: -1 };
		const cw = 19000;
		expect(settings.reserveTokens).toBeUndefined();
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2850);
		expect(resolveThresholdTokens(cw, settings)).toBe(16150);
		expect(shouldCompact(16150, cw, settings)).toBe(false);
		expect(shouldCompact(16151, cw, settings)).toBe(true);
	});

	it("clamps the proportional fallback to >= 1 and the threshold below the window on tiny windows", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			keepRecentTokens: 20000,
		};
		for (let cw = 1; cw <= 10; cw++) {
			expect(resolveBudgetReserveTokens(cw, settings)).toBeGreaterThanOrEqual(1);
			expect(resolveThresholdTokens(cw, settings)).toBeLessThan(cw);
		}
		// Spot checks: floor(6 * 0.15) = 0 clamps to 1; threshold stays at cw - 1.
		expect(resolveBudgetReserveTokens(6, settings)).toBe(1);
		expect(resolveThresholdTokens(6, settings)).toBe(5);
		// Degenerate single-token window: reserve 1, threshold 0 (still < cw).
		expect(resolveBudgetReserveTokens(1, settings)).toBe(1);
		expect(resolveThresholdTokens(1, settings)).toBe(0);
	});

	it("recovers an explicit reserve that exceeds the window to the proportional reserve", () => {
		// reserveExceedsWindow applies regardless of provenance: an explicit 90000
		// on cw=16385 is impossible, so the budget falls back to floor(16385*0.15).
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 90000,
			keepRecentTokens: 20000,
		};
		const cw = 16385;
		expect(effectiveReserveTokens(cw, settings)).toBe(90000);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2457); // floor(16385 * 0.15)
	});

	it("exposes defaulted provenance through the public constants", () => {
		// The fix rides on reserveTokens being ABSENT from the defaults: presence
		// of the field is the provenance signal, not its value.
		expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBeUndefined();
		expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
	});

	it("prefers an explicit fixed thresholdTokens, clamped to [1, window - 1]", () => {
		const cw = 10000;
		const settings: CompactionSettings = { enabled: true, thresholdTokens: 4000, keepRecentTokens: 2000 };
		// A fixed token limit wins over any percentage and is returned as-is when in range.
		expect(resolveThresholdTokens(cw, settings)).toBe(4000);
		// Over-window fixed value clamps to window - 1.
		expect(resolveThresholdTokens(cw, { ...settings, thresholdTokens: 999_999 })).toBe(9999);
		// A zero/negative fixed value is not a valid fixed limit; it falls through.
		expect(resolveThresholdTokens(cw, { ...settings, thresholdTokens: 0, thresholdPercent: 50 })).toBe(5000);
	});

	it("uses a valid thresholdPercent, clamped to [1, 99], as a fraction of the window", () => {
		const cw = 10000;
		expect(resolveThresholdTokens(cw, { enabled: true, thresholdPercent: 80, keepRecentTokens: 2000 })).toBe(8000);
		// Above 99 clamps to 99%.
		expect(resolveThresholdTokens(cw, { enabled: true, thresholdPercent: 250, keepRecentTokens: 2000 })).toBe(9900);
	});
});
