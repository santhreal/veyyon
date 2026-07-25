/**
 * Where the context runs out has ONE owner, and both surfaces that print it use it.
 *
 * WHY THIS SUITE EXISTS. Three places answered "will auto-compaction fire, and at what token
 * count", each with its own spelling of the predicate: the status line asked
 * `enabled && !isCompactionStrategyOff(strategy)`, the `/context` panel hand-rolled
 * `enabled && strategy !== "off"`, and `AgentSession.autoCompactionEnabled` used the canonical
 * `isThresholdCompactionDisabled`. They agreed only by luck. A change to what counts as "off"
 * would have had to land in three files and would have landed in one, and the two user-facing
 * surfaces would then have disagreed about whether a fire point exists at all.
 *
 * `resolveContextLimit` is that owner now. These tests pin its answer directly, and pin the
 * `/context` panel's auto-compaction buffer — which is derived from it — including the case that
 * exposed the divergence: with `strategy: "off"` the panel used to substitute
 * `effectiveReserveTokens` and label it "Autocompact buffer", showing the operator a reserve that
 * nothing would enforce while the status line correctly denominated against the whole window.
 *
 * The gauge's own end of this is pinned in `status-line-context-gauge-producer.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CompactionSettings } from "@veyyon/agent-core/compaction";
import { resolveContextLimit } from "@veyyon/coding-agent/config/compaction-strategy";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { computeContextBreakdown } from "@veyyon/coding-agent/modes/utils/context-usage";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

const WINDOW = 200_000;

function compaction(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return { enabled: true, strategy: "summary", threshold: "85%", ...overrides } as CompactionSettings;
}

describe("resolveContextLimit", () => {
	it("returns the compaction fire point when auto-compaction will fire", () => {
		expect(resolveContextLimit(WINDOW, compaction())).toEqual({ tokens: 170_000, kind: "compaction" });
	});

	it("returns the window when compaction is disabled", () => {
		// Nothing will fire, so the context runs out at the window. A stale fire point
		// here understates the room by the whole reserve.
		expect(resolveContextLimit(WINDOW, compaction({ enabled: false }))).toEqual({
			tokens: WINDOW,
			kind: "window",
		});
	});

	it("returns the window for the legacy off strategy, which is the spelling that diverged", () => {
		// `strategy: "off"` is the case the three callers spelled three ways.
		expect(resolveContextLimit(WINDOW, compaction({ strategy: "off" as never }))).toEqual({
			tokens: WINDOW,
			kind: "window",
		});
	});

	it("honours an absolute token threshold", () => {
		// The threshold is Tier A config and may be an absolute amount rather than a
		// percentage. The owner reads the resolver rather than deriving a percentage.
		expect(resolveContextLimit(WINDOW, compaction({ threshold: "120000" as never }))).toEqual({
			tokens: 120_000,
			kind: "compaction",
		});
	});

	it("keeps an over-window absolute threshold as a fire point, clamped to window - 1", () => {
		// The resolver deliberately honours an absolute amount up to `window - 1` rather
		// than reinterpreting it, and reports the clamp separately
		// (`isThresholdTokensClampedForWindow`) so the operator learns their
		// model-independent amount was capped for this smaller model. So a 500k threshold
		// on a 200k window still fires, at 199,999 — this is a fire point, not a window,
		// and calling it `window` would hide a configuration the operator should fix.
		expect(resolveContextLimit(WINDOW, compaction({ threshold: "500000" as never }))).toEqual({
			tokens: 199_999,
			kind: "compaction",
		});
	});

	it("reports nothing usable when the window is unknown", () => {
		// No model, or a model with no declared window. Zero is not a limit to measure
		// against, and `kind` must not claim a fire point that was never computed.
		expect(resolveContextLimit(0, compaction())).toEqual({ tokens: 0, kind: "window" });
		expect(resolveContextLimit(Number.NaN, compaction())).toEqual({ tokens: 0, kind: "window" });
	});

	it("never reports a limit above the window, for any threshold spelling", () => {
		// The invariant every caller relies on: the limit is a point inside the window, so
		// `window - limit` is a buffer and never negative. Both origins are covered here
		// with their real resolved values, because the guarantee comes from the resolver's
		// clamping (percent caps at 99%, absolute at window - 1) and this is what pins it
		// from the caller's side.
		const resolved = ["1%", "50%", "99%", "100%", "250%", "1", "199999", "200000", "999999"].map(
			threshold => resolveContextLimit(WINDOW, compaction({ threshold: threshold as never })).tokens,
		);

		expect(resolved).toEqual([2_000, 100_000, 198_000, 198_000, 198_000, 1, 199_999, 199_999, 199_999]);
		for (const tokens of resolved) {
			expect(tokens).toBeGreaterThan(0);
			expect(tokens).toBeLessThan(WINDOW);
		}
	});
});

function panelSession(compactionSettings: CompactionSettings): AgentSession {
	return {
		model: { id: "test-model", name: "Test", contextWindow: WINDOW },
		messages: [{ role: "user", content: "hi" }],
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		settings: { getGroup: () => compactionSettings },
	} as unknown as AgentSession;
}

describe("the /context panel's auto-compaction buffer", () => {
	it("is the room between the fire point and the window", () => {
		const breakdown = computeContextBreakdown(panelSession(compaction()));

		expect(breakdown.contextWindow).toBe(WINDOW);
		expect(breakdown.autoCompactBufferTokens).toBe(30_000);
	});

	it("is zero when the strategy is off, instead of an invented reserve", () => {
		// THE bug this suite was written for. The panel used to see a zero buffer, note
		// that `compaction.enabled` was still set, and substitute `effectiveReserveTokens`
		// — drawing a labelled "Autocompact buffer" band for a mechanism that will never
		// run, and disagreeing with the status line, which denominates against the whole
		// window in this exact configuration.
		const breakdown = computeContextBreakdown(panelSession(compaction({ strategy: "off" as never })));

		expect(breakdown.autoCompactBufferTokens).toBe(0);
	});

	it("is zero when compaction is disabled outright", () => {
		const breakdown = computeContextBreakdown(panelSession(compaction({ enabled: false })));

		expect(breakdown.autoCompactBufferTokens).toBe(0);
	});

	it("counts the whole window as usable when nothing will fire", () => {
		// The consequence for the operator: with compaction off, free space is the
		// window minus what is used, with nothing withheld.
		const breakdown = computeContextBreakdown(panelSession(compaction({ strategy: "off" as never })));

		expect(breakdown.freeTokens).toBe(WINDOW - breakdown.usedTokens);
	});

	it("withholds exactly the buffer from free space when compaction will fire", () => {
		const breakdown = computeContextBreakdown(panelSession(compaction()));

		expect(breakdown.freeTokens).toBe(WINDOW - breakdown.usedTokens - 30_000);
	});

	it("agrees with the owner for an absolute threshold", () => {
		// Same input, two surfaces, one answer. The panel derives the buffer from the
		// owner rather than re-deriving the fire point, which is what let the two drift.
		const settings = compaction({ threshold: "120000" as never });
		const breakdown = computeContextBreakdown(panelSession(settings));

		expect(breakdown.autoCompactBufferTokens).toBe(WINDOW - resolveContextLimit(WINDOW, settings).tokens);
		expect(breakdown.autoCompactBufferTokens).toBe(80_000);
	});
});
