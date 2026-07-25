import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	isThresholdTokensClampedForWindow,
	resolveThresholdTokens,
	resolveThresholdWithOrigin,
} from "@veyyon/agent-core/compaction/compaction";
import {
	AUTO_COMPACTION_THRESHOLD,
	formatCompactionThreshold,
	parseCompactionThreshold,
	resolveCompactionThreshold,
	withLegacyCompactionThreshold,
} from "@veyyon/agent-core/compaction/threshold";

/**
 * The compaction trigger has ONE setting, and an existing config keeps its old
 * trigger point.
 *
 * `compaction.thresholdTokens` and `compaction.thresholdPercent` were two
 * settings on one axis, both labelled "Compaction Threshold" in the UI, both
 * defaulting to `-1`, with their precedence recorded only in a comment. An
 * operator could not tell which was in force, and setting one silently did
 * nothing when the other was already set (operator review 2026-07-24). The
 * collapse to `compaction.threshold` must not move anyone's trigger, and the
 * resolver must now REPORT where its number came from so no choice is applied
 * silently.
 */

const WINDOW = 200_000;

/**
 * A settings object with the reserve pinned above the 15%-of-window floor
 * (`effectiveReserveTokens`), so the auto threshold below is plain arithmetic
 * rather than a restatement of the reserve policy.
 */
const withReserve = (over: Partial<CompactionSettings> = {}): CompactionSettings => ({
	...DEFAULT_COMPACTION_SETTINGS,
	reserveTokens: 40_000,
	...over,
});

describe("parsing a threshold value", () => {
	it("reads auto, blank and the retired `default` label as auto", () => {
		// The submenu wrote the literal `default` for the -1 sentinel, and a
		// hand-edited TOML may leave the key empty; neither may become a token count.
		for (const raw of [AUTO_COMPACTION_THRESHOLD, "", "  ", "default", "AUTO", undefined, null]) {
			expect(parseCompactionThreshold(raw)).toEqual({ kind: "auto" });
		}
	});

	it("reads a percent from the value itself, so the unit is never ambiguous", () => {
		expect(parseCompactionThreshold("85%")).toEqual({ kind: "percent", percent: 85 });
		expect(parseCompactionThreshold(" 85 % ")).toEqual({ kind: "percent", percent: 85 });
	});

	it("reads a bare number as an absolute token amount", () => {
		expect(parseCompactionThreshold("170000")).toEqual({ kind: "tokens", tokens: 170_000 });
		expect(parseCompactionThreshold("170_000")).toEqual({ kind: "tokens", tokens: 170_000 });
		expect(parseCompactionThreshold(170_000)).toEqual({ kind: "tokens", tokens: 170_000 });
	});

	it("treats a non-positive number as auto, which is what the -1 sentinel meant", () => {
		expect(parseCompactionThreshold(-1)).toEqual({ kind: "auto" });
		expect(parseCompactionThreshold("-1")).toEqual({ kind: "auto" });
		expect(parseCompactionThreshold(0)).toEqual({ kind: "auto" });
		expect(parseCompactionThreshold("0%")).toEqual({ kind: "auto" });
	});

	it("keeps unparseable text so the caller can say so instead of quietly using auto", () => {
		// A silent revert to auto is the difference between compacting at 170k and
		// at 180k, invisibly — exactly the class of fallback that is banned.
		expect(parseCompactionThreshold("eighty percent")).toEqual({ kind: "auto", invalidRaw: "eighty percent" });
		expect(parseCompactionThreshold("170k")).toEqual({ kind: "auto", invalidRaw: "170k" });
	});
});

describe("migrating off the two retired keys", () => {
	it("prefers the current key over both retired ones", () => {
		const { spec, legacyKey } = withLegacyCompactionThreshold({
			threshold: "70%",
			thresholdTokens: 150_000,
			thresholdPercent: 90,
		});
		expect(spec).toEqual({ kind: "percent", percent: 70 });
		expect(legacyKey).toBeUndefined();
	});

	it("keeps the retired absolute amount ahead of the retired percent", () => {
		// This is the exact precedence the old resolver had. Reversing it would
		// silently move the trigger of every config that set both.
		const { spec, legacyKey } = withLegacyCompactionThreshold({
			threshold: AUTO_COMPACTION_THRESHOLD,
			thresholdTokens: 150_000,
			thresholdPercent: 90,
		});
		expect(spec).toEqual({ kind: "tokens", tokens: 150_000 });
		expect(legacyKey).toBe("thresholdTokens");
	});

	it("falls through to the retired percent when the absolute amount is the sentinel", () => {
		const { spec, legacyKey } = withLegacyCompactionThreshold({
			threshold: AUTO_COMPACTION_THRESHOLD,
			thresholdTokens: -1,
			thresholdPercent: 80,
		});
		expect(spec).toEqual({ kind: "percent", percent: 80 });
		expect(legacyKey).toBe("thresholdPercent");
	});

	it("is auto when all three are unset or sentinels", () => {
		expect(withLegacyCompactionThreshold({ thresholdTokens: -1, thresholdPercent: -1 })).toEqual({
			spec: { kind: "auto" },
		});
		expect(withLegacyCompactionThreshold({})).toEqual({ spec: { kind: "auto" } });
	});

	it("does not let a retired key rescue an unparseable current value", () => {
		// Reaching past a typo to a retired key would hide the typo forever.
		const { spec } = withLegacyCompactionThreshold({ threshold: "eighty", thresholdPercent: 80 });
		expect(spec).toEqual({ kind: "auto", invalidRaw: "eighty" });
	});

	it("never mutates the inputs it reads", () => {
		const inputs = { threshold: AUTO_COMPACTION_THRESHOLD, thresholdTokens: 150_000, thresholdPercent: 90 };
		withLegacyCompactionThreshold(inputs);
		expect(inputs).toEqual({ threshold: AUTO_COMPACTION_THRESHOLD, thresholdTokens: 150_000, thresholdPercent: 90 });
	});
});

describe("resolving a threshold to tokens with its origin", () => {
	it("reports an absolute amount as fixed, unclamped, with the configured value", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "170000" }, () => 180_000);
		expect(resolved).toEqual({
			tokens: 170_000,
			origin: "tokens",
			configured: 170_000,
			clamped: false,
			legacyKey: undefined,
		});
	});

	it("honors an oversized absolute amount up to window - 1 and flags the clamp", () => {
		// Honored-and-reported, never reinterpreted: the operator asked for a
		// model-independent amount, so they are told it did not fit THIS model.
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "500000" }, () => 180_000);
		expect(resolved.tokens).toBe(WINDOW - 1);
		expect(resolved.configured).toBe(500_000);
		expect(resolved.clamped).toBe(true);
	});

	it("scales a percent against the window and reports the percent configured", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "85%" }, () => 180_000);
		expect(resolved.tokens).toBe(170_000);
		expect(resolved.origin).toBe("percent");
		expect(resolved.configured).toBe(85);
		expect(resolved.clamped).toBe(false);
	});

	it("clamps a hand-edited percent into [1, 99] so compaction cannot be disabled by it", () => {
		const over = resolveCompactionThreshold(WINDOW, { threshold: "250%" }, () => 180_000);
		expect(over.tokens).toBe(198_000);
		expect(over.clamped).toBe(true);

		const under = resolveCompactionThreshold(WINDOW, { threshold: "0.4%" }, () => 180_000);
		expect(under.tokens).toBe(2_000);
		expect(under.clamped).toBe(true);
	});

	it("takes auto from the caller and still caps it below the window", () => {
		// The reserve policy lives with the reserve; this module only chooses units.
		expect(resolveCompactionThreshold(WINDOW, {}, () => 180_000).tokens).toBe(180_000);
		expect(resolveCompactionThreshold(WINDOW, {}, () => WINDOW + 5).tokens).toBe(WINDOW - 1);
		expect(resolveCompactionThreshold(WINDOW, {}, () => -50).tokens).toBe(0);
	});

	it("carries the retired key through to the caller so a migration notice can name it", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { thresholdPercent: 80 }, () => 180_000);
		expect(resolved.tokens).toBe(160_000);
		expect(resolved.legacyKey).toBe("thresholdPercent");
	});

	it("carries unparseable text through with the auto tokens", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "lots" }, () => 180_000);
		expect(resolved.tokens).toBe(180_000);
		expect(resolved.origin).toBe("auto");
		expect(resolved.invalidRaw).toBe("lots");
	});
});

/**
 * The three clamps in this resolver are the shared `clamp`/`clampLow` from
 * `@veyyon/utils/math` rather than hand-written `Math.min(Math.max(...))` pairs, and
 * the two helpers are NOT interchangeable here: one of the three ranges can invert.
 * That matters because a threshold decides when the conversation gets summarized, so
 * the wrong bound either compacts on every turn or never compacts at all.
 *
 * These also record where the validation actually lives. Every non-finite and
 * non-positive value is rejected by `parseCompactionThreshold`, at the boundary, for
 * the current key and both retired ones — so the clamps never see one, and the shared
 * helpers' own non-finite guards are defence in depth rather than the live path.
 */
describe("the bounds of a resolved threshold", () => {
	/** The boundary, stated where a reader of the clamps will look for it: a NaN or
	 * infinite amount never reaches them, because the parser sends it to auto first. */
	it("rejects a non-finite configured amount at the parse boundary, not at the clamp", () => {
		for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const resolved = resolveCompactionThreshold(WINDOW, { thresholdTokens: amount }, () => 180_000);
			expect(resolved.origin, String(amount)).toBe("auto");
			expect(resolved.tokens, String(amount)).toBe(180_000);
		}
	});

	/** Same for zero and negatives, which is the `-1` sentinel the retired keys wrote. */
	it("rejects a non-positive configured amount at the parse boundary", () => {
		expect(resolveCompactionThreshold(WINDOW, { thresholdTokens: 0 }, () => 180_000).origin).toBe("auto");
		expect(resolveCompactionThreshold(WINDOW, { thresholdTokens: -1 }, () => 180_000).origin).toBe("auto");
		expect(resolveCompactionThreshold(WINDOW, { thresholdPercent: -40 }, () => 180_000).origin).toBe("auto");
	});

	/** The auto amount comes from the CALLER, so it is the one number the resolver does
	 * not get to validate first, and it is bounded on both ends. */
	it("bounds the caller's auto amount at both ends", () => {
		expect(resolveCompactionThreshold(WINDOW, {}, () => WINDOW + 5).tokens).toBe(WINDOW - 1);
		expect(resolveCompactionThreshold(WINDOW, {}, () => -50).tokens).toBe(0);
		expect(resolveCompactionThreshold(WINDOW, {}, () => Number.NaN).tokens).toBe(0);
	});

	/**
	 * THE reason the absolute path uses `clampLow` rather than `clamp`. A degenerate
	 * window inverts the range (`low = 1`, `high = contextWindow - 1 = 0`), and the LOW
	 * bound has to win: a threshold of zero or less is above every possible context
	 * size, so compaction would fire on every single turn.
	 */
	it("keeps the threshold at least 1 when the window cannot hold one", () => {
		expect(resolveCompactionThreshold(1, { threshold: "5000" }, () => 1).tokens).toBe(1);
		expect(resolveCompactionThreshold(0, { threshold: "5000" }, () => 1).tokens).toBe(1);
	});

	/** The percent range is fixed and can never invert, so the ordinary `clamp` is the
	 * right helper there. Both ends are reachable: `0.4%` from below, `9900%` from
	 * above. Pinned so a later edit does not swap the helpers assuming they agree. */
	it("clamps a percent against the fixed [1, 99] range at both ends", () => {
		expect(resolveCompactionThreshold(WINDOW, { threshold: "0.4%" }, () => 1).tokens).toBe(2_000);
		expect(resolveCompactionThreshold(WINDOW, { threshold: "9900%" }, () => 1).tokens).toBe(198_000);
	});

	/** The ordinary case, restated beside the corners: replacing the inline clamps
	 * changed nothing about what a normal configured threshold resolves to. */
	it("leaves an in-range amount exactly as configured", () => {
		expect(resolveCompactionThreshold(WINDOW, { threshold: "170000" }, () => 1).tokens).toBe(170_000);
		expect(resolveCompactionThreshold(WINDOW, { threshold: "1" }, () => 1).tokens).toBe(1);
		expect(resolveCompactionThreshold(WINDOW, { threshold: "85%" }, () => 1).tokens).toBe(170_000);
	});
});

describe("resolveThresholdTokens over real compaction settings", () => {
	it("subtracts the reserve for auto", () => {
		expect(resolveThresholdTokens(WINDOW, withReserve())).toBe(160_000);
	});

	it("uses the 15%-of-window reserve floor when the configured reserve is smaller", () => {
		// The floor is reserve policy and stays with the reserve; the collapse must
		// not have moved it into the unit-choosing resolver.
		expect(resolveThresholdTokens(WINDOW, withReserve({ reserveTokens: 20_000 }))).toBe(170_000);
	});

	it("returns the same tokens the origin-carrying resolver does", () => {
		// The plain function must stay a thin wrapper; two answers for one question
		// is how the two-key confusion started.
		for (const threshold of [AUTO_COMPACTION_THRESHOLD, "85%", "170000", "500000", "bogus"]) {
			const settings = withReserve({ threshold });
			expect(resolveThresholdTokens(WINDOW, settings)).toBe(resolveThresholdWithOrigin(WINDOW, settings).tokens);
		}
	});

	it("keeps a pre-collapse config compacting at exactly the same point", () => {
		// Two configs written before the collapse, resolved after it.
		expect(resolveThresholdTokens(WINDOW, withReserve({ threshold: undefined, thresholdTokens: 150_000 }))).toBe(
			150_000,
		);
		expect(
			resolveThresholdTokens(
				WINDOW,
				withReserve({ threshold: undefined, thresholdTokens: -1, thresholdPercent: 80 }),
			),
		).toBe(160_000);
	});

	it("reports the clamp only for an oversized absolute amount", () => {
		expect(isThresholdTokensClampedForWindow(WINDOW, withReserve({ threshold: "500000" }))).toBe(true);
		expect(isThresholdTokensClampedForWindow(WINDOW, withReserve({ threshold: "170000" }))).toBe(false);
		// A clamped PERCENT is not a clamped token amount: the notice text names an
		// absolute value, so firing it for a percent would print nonsense.
		expect(isThresholdTokensClampedForWindow(WINDOW, withReserve({ threshold: "250%" }))).toBe(false);
		expect(isThresholdTokensClampedForWindow(WINDOW, withReserve())).toBe(false);
	});

	it("still clamps a retired oversized absolute amount", () => {
		expect(
			isThresholdTokensClampedForWindow(WINDOW, withReserve({ threshold: undefined, thresholdTokens: 500_000 })),
		).toBe(true);
	});

	it("defaults to auto, so a fresh install has no unit ambiguity to resolve", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.threshold).toBe(AUTO_COMPACTION_THRESHOLD);
	});
});

describe("describing a resolved threshold to the operator", () => {
	it("names the percent and the window it applied to", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "85%" }, () => 180_000);
		expect(formatCompactionThreshold(resolved, WINDOW)).toBe("170k (85% of 200k)");
	});

	it("says fixed for an absolute amount that fit", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "170000" }, () => 180_000);
		expect(formatCompactionThreshold(resolved, WINDOW)).toBe("170k (fixed)");
	});

	it("says both the configured amount and the cap when it did not fit", () => {
		const resolved = resolveCompactionThreshold(WINDOW, { threshold: "500000" }, () => 180_000);
		expect(formatCompactionThreshold(resolved, WINDOW)).toBe("200k (fixed 500k, capped to this model's 200k window)");
	});

	it("explains auto rather than printing a bare number", () => {
		const resolved = resolveCompactionThreshold(WINDOW, {}, () => 180_000);
		expect(formatCompactionThreshold(resolved, WINDOW)).toBe("180k (auto: 200k window minus reserve)");
	});
});
