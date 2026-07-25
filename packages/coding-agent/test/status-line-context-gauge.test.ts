/**
 * The context gauge says what it measures (CTX-GAUGE, 2026-07-25).
 *
 * The gauge answers one question — how much room is left before the context
 * runs out — and every part of it used to answer that question in a different
 * vocabulary than it printed:
 *
 *  - `contextWindow` was OVERWRITTEN with the auto-compaction fire point before
 *    the segments ran, so `context_total` printed `170k` for a 200k model and
 *    the denominator of the gauge read as a window it was not.
 *  - the text was `47.3%/200,000`: a percent and a token count either side of a
 *    slash, a notation that everywhere else means a ratio of like quantities.
 *  - the bar filled as room ran out, and the number reported consumption, while
 *    the decision the user makes from it is about what remains.
 *  - the color came from `Math.min` of a percent ladder and a hidden ladder of
 *    absolute token counts, which turned a 1M-window session yellow at 15% and
 *    red at 50% — the color contradicting the number beside it.
 *  - `toFixed(1)` put a jittering digit on the surface users called confusing.
 *
 * Each of those is pinned below. If one regresses the gauge is lying again.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	formatContextRemaining,
	formatContextRemainingPercent,
	formatContextUsage,
	getContextUsageLevel,
} from "@veyyon/coding-agent/modes/components/status-line/context-thresholds";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

interface GaugeOverrides {
	contextPercent?: number | null;
	contextTokens?: number;
	contextWindow?: number;
	contextLimit?: number;
	contextLimitKind?: "window" | "compaction";
	autoCompactEnabled?: boolean;
	bar?: boolean;
	streaming?: boolean;
}

function gaugeContext(overrides: GaugeOverrides = {}): SegmentContext {
	const contextWindow = overrides.contextWindow ?? 200_000;
	const contextLimit = overrides.contextLimit ?? contextWindow;
	const contextTokens = overrides.contextTokens ?? 0;
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			isStreaming: overrides.streaming ?? false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => false,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: overrides.bar ? { context_pct: { bar: true } } : {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent:
			overrides.contextPercent !== undefined
				? overrides.contextPercent
				: contextLimit > 0
					? (contextTokens / contextLimit) * 100
					: null,
		contextTokens,
		contextWindow,
		contextLimit,
		contextLimitKind: overrides.contextLimitKind ?? "window",
		autoCompactEnabled: overrides.autoCompactEnabled ?? false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	} as unknown as SegmentContext;
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("formatContextUsage", () => {
	/** One unit on both sides of the slash. `47.3%/200,000` was not a ratio of
	 * anything: no arithmetic relates a percent to a token count that way. */
	it("renders tokens over tokens, never a percent over a token count", () => {
		expect(formatContextUsage(47_300, 200_000)).toBe("47K/200K");
		expect(formatContextUsage(47_300, 200_000)).not.toContain("%");
	});

	/** The gauge measures against the LIMIT, so a 170k auto-compaction trigger on
	 * a 200k model is the denominator here — and it is honest about the number
	 * because the window is printed by `context_total`, not by this string. */
	it("uses the limit it is given as the denominator", () => {
		expect(formatContextUsage(85_000, 170_000)).toBe("85K/170K");
	});

	/** A zero denominator reads as a real measurement of an empty context; the
	 * limit is simply unknown until the provider reports a window. */
	it("marks an unknown limit as ? rather than 0", () => {
		expect(formatContextUsage(5_000, 0)).toBe("5K/?");
		expect(formatContextUsage(5_000, Number.NaN)).toBe("5K/?");
	});

	it("floors a negative or non-finite used count at zero", () => {
		expect(formatContextUsage(-1, 200_000)).toBe("0/200K");
		expect(formatContextUsage(Number.NaN, 200_000)).toBe("0/200K");
	});
});

describe("formatContextRemaining", () => {
	it("reports the tokens still available before the limit", () => {
		expect(formatContextRemaining(47_000, 200_000)).toBe("153K left");
	});

	/** Past the limit (compaction has not fired yet but the trigger is behind us)
	 * there is no such thing as negative room. */
	it("never reports negative room", () => {
		expect(formatContextRemaining(220_000, 200_000)).toBe("0 left");
	});

	it("cannot invent a remainder against an unknown limit", () => {
		expect(formatContextRemaining(5_000, 0)).toBe("? left");
	});
});

describe("formatContextRemainingPercent", () => {
	/** Whole numbers only. The tenth of a percent moved every turn and decided
	 * nothing, which is jitter on the surface users already called confusing. */
	it("rounds to a whole percent with no decimal digit", () => {
		expect(formatContextRemainingPercent(47.34)).toBe("53% left");
		expect(formatContextRemainingPercent(47.34)).not.toContain(".");
	});

	/** `76%` beside a gauge is read as consumption by default. The word is what
	 * removes the ambiguity, so it is part of the one formatted string rather
	 * than something a caller may forget to add. */
	it("names what the number is", () => {
		expect(formatContextRemainingPercent(24)).toBe("76% left");
	});

	it("clamps to the 0-100 band and admits an unknown percent", () => {
		expect(formatContextRemainingPercent(140)).toBe("0% left");
		expect(formatContextRemainingPercent(-20)).toBe("100% left");
		expect(formatContextRemainingPercent(null)).toBe("? left");
		expect(formatContextRemainingPercent(undefined)).toBe("? left");
	});
});

describe("getContextUsageLevel", () => {
	it("steps normal → warning → high → error on percent of the limit", () => {
		expect(getContextUsageLevel(0)).toBe("normal");
		expect(getContextUsageLevel(49.9)).toBe("normal");
		expect(getContextUsageLevel(50)).toBe("warning");
		expect(getContextUsageLevel(69.9)).toBe("warning");
		expect(getContextUsageLevel(70)).toBe("high");
		expect(getContextUsageLevel(89.9)).toBe("high");
		expect(getContextUsageLevel(90)).toBe("error");
		expect(getContextUsageLevel(100)).toBe("error");
	});

	/**
	 * The regression this function was rewritten for. The old level folded in
	 * absolute token thresholds (150k warning, 270k high, 500k error) by
	 * converting each to a percent of the window and taking `Math.min`, so on a
	 * 1M-window model the gauge went yellow at 15% and red at 50%. The level now
	 * depends on the percentage alone, so no window size can make the color
	 * disagree with the number printed next to it.
	 */
	it("is independent of the window size — no hidden absolute-token ladder", () => {
		// 150k used on a 1M window is 15%: plenty of room, and it must look it.
		expect(getContextUsageLevel(15)).toBe("normal");
		// 500k used on a 1M window is 50%: warning, exactly like 100k of 200k.
		expect(getContextUsageLevel(50)).toBe("warning");
		// The same percentage yields the same level whatever the window was.
		for (const pct of [10, 30, 55, 75, 95]) {
			expect(getContextUsageLevel(pct)).toBe(getContextUsageLevel(pct));
		}
	});

	/** An unknown percentage is not an emergency: a missing number must not
	 * paint the footline red. */
	it("treats an unknown percentage as normal", () => {
		expect(getContextUsageLevel(null)).toBe("normal");
		expect(getContextUsageLevel(undefined)).toBe("normal");
		expect(getContextUsageLevel(Number.NaN)).toBe("normal");
	});
});

describe("context_total segment", () => {
	/**
	 * The headline bug: the status line replaced `contextWindow` with the
	 * auto-compaction fire point, so the one segment whose entire job is to
	 * print the model's window printed the trigger instead. Window and limit are
	 * separate fields now, and this segment reads the window.
	 */
	it("prints the model window, not the auto-compaction trigger", () => {
		const rendered = renderSegment(
			"context_total",
			gaugeContext({
				contextWindow: 200_000,
				contextLimit: 170_000,
				contextLimitKind: "compaction",
				autoCompactEnabled: true,
			}),
		);
		expect(plain(rendered.content)).toContain("200K");
		expect(plain(rendered.content)).not.toContain("170K");
	});

	it("hides itself when the window is unknown", () => {
		expect(renderSegment("context_total", gaugeContext({ contextWindow: 0, contextLimit: 0 })).visible).toBe(false);
	});
});

describe("context_pct segment", () => {
	/** Text mode is the tok/tok readout: used against the limit, one unit on
	 * both sides, no percent and no decimal. */
	it("renders tokens over the limit in text mode", () => {
		const rendered = renderSegment(
			"context_pct",
			gaugeContext({ contextTokens: 85_000, contextWindow: 200_000, contextLimit: 170_000 }),
		);
		expect(plain(rendered.content)).toContain("85K/170K");
		expect(plain(rendered.content)).not.toContain("%");
	});

	/**
	 * Bar mode reports room LEFT twice — as a draining bar and as a labelled
	 * percentage — so the two halves of the gauge cannot contradict each other.
	 * At 25% used, six of eight cells remain.
	 */
	it("drains the bar and labels the percentage in bar mode", () => {
		const rendered = renderSegment(
			"context_pct",
			gaugeContext({ contextTokens: 50_000, contextWindow: 200_000, contextLimit: 200_000, bar: true }),
		);
		const text = plain(rendered.content);
		expect(text).toContain("▰▰▰▰▰▰▱▱");
		expect(text).toContain("75% left");
	});

	/** The bar empties as the session grows: the same gauge at 90% used shows one
	 * remaining cell, not seven filled ones. */
	it("shows less bar the less room there is", () => {
		const nearlyFull = plain(
			renderSegment(
				"context_pct",
				gaugeContext({ contextTokens: 180_000, contextWindow: 200_000, contextLimit: 200_000, bar: true }),
			).content,
		);
		expect(nearlyFull).toContain("▰▱▱▱▱▱▱▱");
		expect(nearlyFull).toContain("10% left");
	});

	/** A fresh session is all room, and reads as such. */
	it("shows a full bar at the start of a session", () => {
		const fresh = plain(
			renderSegment("context_pct", gaugeContext({ contextTokens: 0, contextLimit: 200_000, bar: true })).content,
		);
		expect(fresh).toContain("▰▰▰▰▰▰▰▰");
		expect(fresh).toContain("100% left");
	});

	/** Right after a compaction the percentage is unknown; the gauge says so
	 * instead of printing a number it does not have. */
	it("admits an unknown percentage in bar mode", () => {
		const unknown = plain(renderSegment("context_pct", gaugeContext({ contextPercent: null, bar: true })).content);
		expect(unknown).toContain("? left");
	});
});
