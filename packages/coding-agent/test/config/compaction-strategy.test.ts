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
 * compaction-strategy.ts folds every legacy or persisted compaction token into the
 * two surviving strategies (`handoff` | `summary`) and picks the engine action that
 * auto-compaction runs. Only normalizeCompactionStrategy/migrateCompactionStrategyValue
 * had coverage; the five functions that translate a strategy into an ENGINE ACTION and
 * gate whether compaction runs did not. Those decide, at runtime, whether a session
 * hands off to a fresh session or summarizes in place, so their branches are pinned:
 *   - a handoff strategy only produces the "handoff" action when the trigger is NOT an
 *     overflow and handoff is not suppressed; overflow and suppressHandoff both force
 *     "context-full" (you cannot start a fresh session when the window already overflowed);
 *   - "summary" always maps to "context-full";
 *   - resolveCompactionEngineAction normalizes first, so a legacy token like "snap" or a
 *     bare "off" resolves through "summary" to "context-full";
 *   - the "off" kill switch lives OUTSIDE the strategy enum (normalize turns "off" into
 *     "summary"); isCompactionStrategyOff / isThresholdCompactionDisabled read the raw
 *     token, so a regression that routed "off" through normalize would silently re-enable
 *     a disabled compactor;
 *   - toAgentCompactionSettings replaces the strategy with its normalized form while
 *     carrying every other profile field through unchanged.
 */

describe("compactionStrategyToEngineAction", () => {
	it("maps handoff to the handoff action for non-overflow triggers", () => {
		expect(compactionStrategyToEngineAction("handoff")).toBe("handoff");
		expect(compactionStrategyToEngineAction("handoff", { reason: "threshold" })).toBe("handoff");
		expect(compactionStrategyToEngineAction("handoff", { reason: "idle" })).toBe("handoff");
		expect(compactionStrategyToEngineAction("handoff", { reason: "incomplete" })).toBe("handoff");
	});

	it("forces context-full when the trigger is overflow or handoff is suppressed", () => {
		expect(compactionStrategyToEngineAction("handoff", { reason: "overflow" })).toBe("context-full");
		expect(compactionStrategyToEngineAction("handoff", { suppressHandoff: true })).toBe("context-full");
	});

	it("always maps summary to context-full regardless of trigger", () => {
		expect(compactionStrategyToEngineAction("summary")).toBe("context-full");
		expect(compactionStrategyToEngineAction("summary", { reason: "threshold" })).toBe("context-full");
	});
});

describe("resolveCompactionEngineAction normalizes before mapping", () => {
	it("routes a legacy summary token through summary to context-full", () => {
		expect(resolveCompactionEngineAction("snap")).toBe("context-full");
		expect(resolveCompactionEngineAction("shake")).toBe("context-full");
		expect(resolveCompactionEngineAction("context-full")).toBe("context-full");
	});

	it("keeps a stored handoff as the handoff action for non-overflow triggers", () => {
		expect(resolveCompactionEngineAction("handoff")).toBe("handoff");
		expect(resolveCompactionEngineAction("handoff", { reason: "overflow" })).toBe("context-full");
	});

	it("treats an unknown or 'off' token as summary (context-full), since 'off' is a separate gate", () => {
		expect(resolveCompactionEngineAction("off")).toBe("context-full");
		expect(resolveCompactionEngineAction(undefined)).toBe("context-full");
		expect(resolveCompactionEngineAction("garbage")).toBe("context-full");
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
	it("normalizes a string value and returns undefined for non-strings", () => {
		expect(migrateCompactionStrategyValue("snap")).toBe("summary");
		expect(migrateCompactionStrategyValue("handoff")).toBe("handoff");
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
			thresholdPercent: 80,
			thresholdTokens: 1000,
			reserveTokens: 500,
			keepRecentTokens: 200,
			midTurnEnabled: false,
			handoffSaveToDisk: true,
			autoContinue: true,
			remoteEnabled: false,
			remoteEndpoint: undefined,
			remoteStreamingV2Enabled: false,
			v2RetainedMessageBudget: 10,
			idleEnabled: false,
			idleThresholdTokens: 0,
			idleTimeoutSeconds: 0,
			supersedeReads: true,
			dropUseless: true,
		});
		expect(result.strategy).toBe("summary");
		expect(result.thresholdPercent).toBe(80);
		expect(result.keepRecentTokens).toBe(200);
		expect(result.enabled).toBe(true);
	});
});
