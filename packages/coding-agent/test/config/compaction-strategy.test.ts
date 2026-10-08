import { describe, expect, it } from "bun:test";
import {
	compactionStrategyToEngineAction,
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
	resolveCompactionEngineAction,
	toAgentCompactionSettings,
} from "../../src/config/compaction-strategy";

/**
 * Every persisted strategy token selects the same in-place summary engine action. `off` is no
 * longer a run-time state: the settings migration turns it into `compaction.enabled: false`, so
 * normalization folds it into `summary` like every other token.
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

describe("normalize folds the retired 'off' token", () => {
	it("maps 'off' to summary, because `compaction.enabled` is the only off switch", () => {
		expect(normalizeCompactionStrategy("off")).toBe("summary");
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
