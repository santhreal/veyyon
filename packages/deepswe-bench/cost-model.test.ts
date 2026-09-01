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
import { costShares, priceTokens, REFERENCE_RATE_CARD, retainedTokenCost } from "./cost-model";

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
		// `delete` rather than `= undefined`: a legacy row lacks the property entirely.
		delete (legacy as Partial<ArmResult>).cacheReadTokens;
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

/**
 * `retainedTokenCost`, moved here with the function.
 *
 * It replaces charging a token once. Context is re-read on every later turn, so a token's real
 * price depends on when it enters the session, and charging the dictionary once made a dictionary
 * that loses money look like it saved it. Both ceiling scripts had their own copy of the
 * arithmetic, which is two answers to the question every saving claim in this bench is stated in.
 */
describe("retainedTokenCost", () => {
	/**
	 * A token entering on the final turn is never re-read, so it costs exactly
	 * fresh input and nothing more. This is the boundary the reread arithmetic
	 * gets wrong by one if `totalTurns - turn` is used instead of minus one.
	 */
	test("charges a last-turn token as fresh input only", () => {
		expect(retainedTokenCost(9, 10)).toBeCloseTo(REFERENCE_RATE_CARD.input / 1_000_000, 15);
	});

	/**
	 * The finding that reframed the whole effort, as arithmetic: a token entering
	 * at turn 0 of a 66-turn session is billed once as input and 65 times as
	 * cache read, roughly seventeen times its face value. This is why context
	 * size dominates the bill and why the dictionary, which sits in the prompt
	 * from turn 0, is the most expensive place to put anything.
	 */
	test("charges a turn-0 token of a 66-turn session at ~17x face value", () => {
		const unit = retainedTokenCost(0, 66);
		const face = REFERENCE_RATE_CARD.input / 1_000_000;
		expect(unit / face).toBeCloseTo(17.25, 2);
	});

	/** Cost falls monotonically the later a token enters, which is what makes late context cheaper than early context. */
	test("falls monotonically as a token enters later", () => {
		const costs = [0, 10, 20, 30].map(turn => retainedTokenCost(turn, 40));
		for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeLessThan(costs[i - 1]);
	});

	/** A turn index past the end cannot produce a negative reread count and a negative price. */
	test("never returns less than the fresh-input price", () => {
		expect(retainedTokenCost(99, 10)).toBeCloseTo(REFERENCE_RATE_CARD.input / 1_000_000, 15);
	});
});

describe("retainedTokenCost has one owner", () => {
	/**
	 * The lock. `online-codec-ceiling.ts` and `context-encode-ceiling.ts` each defined it, and both
	 * price their sweeps with it, so a copy reappearing means two sweeps can report savings on
	 * different billing models while both look like this bench's numbers.
	 */
	test("neither ceiling script defines its own", async () => {
		for (const file of ["online-codec-ceiling.ts", "context-encode-ceiling.ts"]) {
			const source = await Bun.file(new URL(file, import.meta.url)).text();

			expect(source).not.toContain("function retainedTokenCost");
			expect(source).toContain('retainedTokenCost } from "./cost-model"');
		}
	});
});
