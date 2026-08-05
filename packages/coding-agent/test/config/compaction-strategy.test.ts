import { describe, expect, it } from "bun:test";
import {
	compactionStrategyToEngineAction,
	isCompactionStrategyOff,
	isThresholdCompactionDisabled,
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
	resolveCompactionEngineAction,
	toAgentCompactionSettings,
} from "../../src/config/compaction-strategy";

/**
 * Every persisted strategy token now selects the same in-place summary engine
 * action. The raw `off` token remains a separate migration-era kill switch:
 * normalization erases it, while the enablement predicates deliberately inspect
 * it before normalization.
 */

describe("compactionStrategyToEngineAction", () => {
	it("always maps the canonical strategy to context-full", () => {
		expect(compactionStrategyToEngineAction("summary")).toBe("context-full");
	});
});

describe("resolveCompactionEngineAction normalizes before mapping", () => {
	it("routes every legacy and unknown token to in-place summary", () => {
		for (const strategy of ["snap", "shake", "context-full", "handoff", "off", "garbage", undefined]) {
			expect(resolveCompactionEngineAction(strategy)).toBe("context-full");
		}
	});
});

describe("normalize does not preserve the 'off' kill switch", () => {
	it("folds 'off' into summary, so the disable check must read the raw token", () => {
		// This is the load-bearing contract: normalize erases "off", so the disable
		// gates below read the raw strategy instead of the normalized enum.
		expect(normalizeCompactionStrategy("off")).toBe("summary");
	});
});

describe("isCompactionStrategyOff", () => {
	it("is true only for the exact 'off' token", () => {
		expect(isCompactionStrategyOff("off")).toBe(true);
		expect(isCompactionStrategyOff("summary")).toBe(false);
		expect(isCompactionStrategyOff("handoff")).toBe(false);
		expect(isCompactionStrategyOff(undefined)).toBe(false);
	});
});

describe("isThresholdCompactionDisabled", () => {
	it("is disabled when the feature is off OR the strategy is 'off'", () => {
		expect(isThresholdCompactionDisabled(false, "summary")).toBe(true);
		expect(isThresholdCompactionDisabled(true, "off")).toBe(true);
		expect(isThresholdCompactionDisabled(false, "off")).toBe(true);
	});

	it("is enabled when the feature is on and the strategy is not 'off'", () => {
		expect(isThresholdCompactionDisabled(true, "summary")).toBe(false);
		expect(isThresholdCompactionDisabled(true, "handoff")).toBe(false);
		expect(isThresholdCompactionDisabled(true, undefined)).toBe(false);
	});
});

describe("migrateCompactionStrategyValue", () => {
	it("migrates every string value to summary and returns undefined for non-strings", () => {
		expect(migrateCompactionStrategyValue("snap")).toBe("summary");
		expect(migrateCompactionStrategyValue("handoff")).toBe("summary");
		expect(migrateCompactionStrategyValue(42)).toBeUndefined();
		expect(migrateCompactionStrategyValue(null)).toBeUndefined();
		expect(migrateCompactionStrategyValue(undefined)).toBeUndefined();
	});
});

describe("toAgentCompactionSettings", () => {
	it("normalizes the strategy while carrying every other field through unchanged", () => {
		const result = toAgentCompactionSettings({
			enabled: true,
			strategy: "snap",
			// Both retired threshold keys plus the current one: the adapter must carry
			// all three through untouched, since the migration off the retired pair is
			// the settings layer's job, not this adapter's.
			threshold: "80%",
			thresholdPercent: 80,
			thresholdTokens: 1000,
			reserveTokens: 500,
			keepRecentTokens: 200,
			midTurnEnabled: false,
			handoffSaveToDisk: true,
			autoContinue: true,
			remoteEndpoint: undefined,
			idleEnabled: false,
			idleThresholdTokens: 0,
			idleTimeoutSeconds: 0,
			supersedeReads: true,
			dropUseless: true,
		});
		expect(result.strategy).toBe("summary");
		expect(result.threshold).toBe("80%");
		expect(result.thresholdPercent).toBe(80);
		expect(result.thresholdTokens).toBe(1000);
		expect(result.keepRecentTokens).toBe(200);
		expect(result.enabled).toBe(true);
	});
});
