/**
 * The cost instrument, pinned.
 *
 * WHY THIS SUITE EXISTS. For every run the bench has made, the `cost USD`
 * column was a constant zero, because the provider is an unpriced subscription
 * proxy. That is not a rendering nit: it meant the bench could not answer "is
 * this arm cheaper", which is the only question the work it measures is trying
 * to settle. An optimization effort aimed itself at output tokens for weeks on
 * the strength of a token table, and the first time the tokens were actually
 * priced, output turned out to be a fifth of the bill at most.
 *
 * These tests lock the two properties that make the replacement instrument
 * worth trusting: the four billing lines are never collapsed, and the ratio
 * between them (the only thing any comparison here depends on) cannot drift
 * without a test failing.
 */

import { describe, expect, test } from "bun:test";
import { type ArmResult, emptyArmResult, renderReferenceCostSection, summarizeCell } from "./aggregate";
import { costShares, priceTokens, REFERENCE_RATE_CARD } from "./cost-model";

describe("the reference cost section refuses to price what it cannot attribute", () => {
	/**
	 * A row written before the cache read/write split has no such property at
	 * all. An `!== null` guard passes `undefined` as measurable, `sum()` then
	 * reads it as 0, and the section prints `$0.0000` in the cache-read column
	 * for a run that did millions of cache reads. That is a fabricated number in
	 * the exact column the section exists to report, and it looks like a real,
	 * astonishingly cheap result. The guard must therefore catch `undefined` as
	 * well as `null`.
	 */
	test("withholds the table for rows that predate the cache split", () => {
		const legacy = { ...emptyArmResult("old", "t", 0), inputTokens: 1000, outputTokens: 500, cacheTokens: 900_000 };
		// biome-ignore lint/performance/noDelete: reproduces a legacy row, which lacks the property entirely.
		delete (legacy as Partial<ArmResult>).cacheReadTokens;
		// biome-ignore lint/performance/noDelete: same.
		delete (legacy as Partial<ArmResult>).cacheWriteTokens;
		expect(summarizeCell([legacy]).refCostMeasurable).toBe(false);
		expect(renderReferenceCostSection([legacy], ["old"])).toContain("Not computed for old");
	});

	/** A complete row is priced, so the withholding path cannot swallow good data. */
	test("prices a row that carries the split", () => {
		const row: ArmResult = {
			...emptyArmResult("new", "t", 0),
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const s = summarizeCell([row]);
		expect(s.refCostMeasurable).toBe(true);
		expect(s.refCost.input).toBeCloseTo(0.3, 10);
	});
});

describe("REFERENCE_RATE_CARD", () => {
	/**
	 * The ratios, not the absolute rates, decide every conclusion this bench
	 * draws. Scaling all four lines by a constant moves every arm's cost by the
	 * same factor and flips no verdict; changing one line relative to the others
	 * can invert one. So the ratios are asserted as exact values rather than left
	 * to whatever someone later pastes in from a pricing page.
	 */
	test("prices a cache read at a quarter of fresh input and output at 8.3x it", () => {
		expect(REFERENCE_RATE_CARD.cacheRead / REFERENCE_RATE_CARD.input).toBeCloseTo(0.25, 10);
		expect(REFERENCE_RATE_CARD.output / REFERENCE_RATE_CARD.input).toBeCloseTo(8.333, 3);
	});

	/**
	 * A cache write costs MORE than a fresh input token. This is the sign that
	 * makes "just cache everything" wrong as a blanket strategy, and the reason
	 * the write line is tracked separately rather than folded into reads: an
	 * optimization that thrashes the cache pays the expensive line repeatedly
	 * while a summed "cache tokens" figure would barely move.
	 */
	test("prices a cache write above fresh input, so thrashing is visibly a loss", () => {
		expect(REFERENCE_RATE_CARD.cacheWrite).toBeGreaterThan(REFERENCE_RATE_CARD.input);
	});

	/**
	 * Any figure derived from these rates is a counterfactual and gets printed
	 * next to its provenance. An empty source string would let a reference cost
	 * be mistaken for a billed one, which is the exact confusion the whole module
	 * exists to prevent.
	 */
	test("carries a non-empty source string for every number derived from it", () => {
		expect(REFERENCE_RATE_CARD.source.length).toBeGreaterThan(20);
	});
});

describe("priceTokens", () => {
	/**
	 * The arithmetic, on the real measured mix from the trial that redirected the
	 * whole effort (`runs/argot-smoke-0724`, encode arm): 724,697 fresh input,
	 * 6,506,157 cache read, 0 cache write, 67,199 output. Asserted as exact
	 * dollar values rather than as "greater than zero", so a units error (per
	 * thousand instead of per million) fails here instead of silently changing
	 * every conclusion downstream by 1000x.
	 */
	test("prices the trace that redirected the effort, line by line", () => {
		const cost = priceTokens({
			inputTokens: 724_697,
			cacheReadTokens: 6_506_157,
			cacheWriteTokens: 0,
			outputTokens: 67_199,
		});
		expect(cost.input).toBeCloseTo(0.2174, 4);
		expect(cost.cacheRead).toBeCloseTo(0.488, 3);
		expect(cost.cacheWrite).toBe(0);
		expect(cost.output).toBeCloseTo(0.168, 3);
		expect(cost.total).toBeCloseTo(0.8734, 3);
	});

	/**
	 * The finding this instrument was built to make unmissable, asserted as a
	 * number: on that real trace, output is a MINORITY of the bill. A codec whose
	 * entire reach is the output line therefore has a hard ceiling of roughly a
	 * fifth of cost even if it compressed output to nothing. If this assertion
	 * ever fails because the shares moved, the target of the optimization work
	 * should be reconsidered, which is precisely why it is a test and not a
	 * comment.
	 */
	test("shows output is under a quarter of the bill on that trace", () => {
		const shares = costShares(
			priceTokens({
				inputTokens: 724_697,
				cacheReadTokens: 6_506_157,
				cacheWriteTokens: 0,
				outputTokens: 67_199,
			}),
		);
		expect(shares.output).toBeLessThan(0.25);
		expect(shares.cacheRead).toBeGreaterThan(shares.output);
		expect(shares.input).toBeGreaterThan(shares.output);
	});

	/**
	 * The tradeoff this table exists to catch, stated as a test. An arm that cuts
	 * output by 8% (argot's best measured result) while adding a single 50k-token
	 * cache miss must come out MORE expensive overall. Before the split, both
	 * arms' cache tokens went into one column and this regression was invisible.
	 */
	test("scores an 8% output saving bought with one cache miss as a net loss", () => {
		const baseline = priceTokens({
			inputTokens: 100_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
			outputTokens: 50_000,
		});
		const traded = priceTokens({
			inputTokens: 150_000,
			cacheReadTokens: 950_000,
			cacheWriteTokens: 0,
			outputTokens: 46_000,
		});
		expect(traded.output).toBeLessThan(baseline.output);
		expect(traded.total).toBeGreaterThan(baseline.total);
	});

	/** Zero tokens price to zero on every line, with no NaN and no throw. */
	test("prices an empty mix as zero without producing NaN", () => {
		const cost = priceTokens({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
		expect(cost).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
	});

	/**
	 * `total` is the sum of the four lines and nothing else. A total that drifted
	 * from its components (by double-counting cache, say) would make every delta
	 * in the report unattributable while still looking plausible.
	 */
	test("keeps total exactly equal to the sum of its four lines", () => {
		const cost = priceTokens({
			inputTokens: 12_345,
			cacheReadTokens: 678_901,
			cacheWriteTokens: 2_345,
			outputTokens: 6_789,
		});
		expect(cost.total).toBeCloseTo(cost.input + cost.cacheRead + cost.cacheWrite + cost.output, 12);
	});

	/**
	 * A caller-supplied rate card must actually be used. Passing a card and
	 * getting the default back would silently price every experiment at the wrong
	 * provider, and the numbers would still look reasonable.
	 */
	test("honours a caller-supplied rate card instead of the default", () => {
		const doubled = priceTokens(
			{ inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			{ ...REFERENCE_RATE_CARD, input: 0.6 },
		);
		expect(doubled.input).toBeCloseTo(0.6, 10);
	});
});

describe("costShares", () => {
	/** Shares of a real mix sum to 1, so the report's percentages account for the whole bill. */
	test("returns shares that sum to one", () => {
		const shares = costShares(
			priceTokens({ inputTokens: 5_000, cacheReadTokens: 40_000, cacheWriteTokens: 1_000, outputTokens: 900 }),
		);
		expect(shares.input + shares.cacheRead + shares.cacheWrite + shares.output).toBeCloseTo(1, 10);
	});

	/**
	 * An all-errored arm has no tokens and therefore no shares. Dividing by its
	 * zero total would print `NaN%` across the report; the guard returns zeros so
	 * an empty arm degrades to an obviously-empty row instead of corrupting the
	 * table.
	 */
	test("returns zeros rather than NaN for an empty arm", () => {
		expect(costShares({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })).toEqual({
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
		});
	});
});
