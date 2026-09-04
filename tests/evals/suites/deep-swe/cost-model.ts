/**
 * What a bench run WOULD cost on a metered API.
 *
 * WHY THIS EXISTS. The bench's `cost` column reads veyyon's own accounting
 * (`usage.cost.total`, computed by `calculateCost` in `@veyyon/catalog`), and
 * that number is a constant zero for every run so far. It is zero correctly:
 * the runs go through the antigravity proxy, whose catalog entry is `unpriced`,
 * and catalog is right to refuse to invent a price for a model nobody told it
 * the price of. The consequence is that the bench could measure output tokens
 * to four digits and could not measure cost at all, which made "is this arm
 * cheaper?" an unanswerable question and let an optimization that cut output
 * tokens look like a win while it silently cost more somewhere else.
 *
 * The failure that motivated this file: argot's whole design target is output
 * tokens, and on a real trace output was a small minority of billable volume.
 * One trial (`runs/argot-smoke-0724`, the encode arm) spent 724,697 uncached
 * input tokens, 6,506,157 cache-read tokens, and 67,199 output tokens. Output
 * is under one percent of the tokens that moved. Priced, it is a fifth of the
 * bill at most. An instrument that reports only output tokens reports the
 * smallest term and hides the two large ones.
 *
 * This module does NOT duplicate catalog's pricing. Catalog answers "what did
 * this actually cost", and for an unpriced provider the honest answer is that
 * it does not know. This answers a different question, the one a bench needs:
 * "what would this token mix cost at published rates". Both numbers are
 * reported, and they are never mixed.
 */

/**
 * Per-million-token USD rates.
 *
 * Four separate rates, never collapsed. A cached input token and a fresh one
 * differ by 4x, and an output token costs 8x a fresh input token. Any metric
 * that adds them together, or that folds cache reads and cache writes into one
 * "cache" figure, cannot tell a real saving apart from a shift between lines.
 */
export interface RateCard {
	/** Fresh input: prompt tokens the provider had to read, cache miss. */
	readonly input: number;
	/** Cache read: prompt tokens served from a prefix cache hit. */
	readonly cacheRead: number;
	/** Cache write: tokens billed for populating the cache. */
	readonly cacheWrite: number;
	/** Output, inclusive of reasoning tokens, which bill as output. */
	readonly output: number;
	/** Human-readable provenance, printed with any number derived from it. */
	readonly source: string;
}

/**
 * The rate card the bench prices against.
 *
 * These are the published Google rates for the Flash tier the bench's model
 * belongs to. They are stated here, in one place, with their source, because a
 * reference price that lives in a comment or a spreadsheet drifts silently and
 * then every "percent cheaper" claim built on it is unfalsifiable.
 *
 * What matters for every comparison this bench makes is the RATIO between the
 * four lines, not their absolute size: cache read is a quarter of fresh input,
 * and output is a little over eight times it. Swapping in a different tier's
 * absolute numbers moves every arm's cost by the same factor and changes no
 * conclusion. Swapping in a different RATIO can invert one, which is exactly
 * why the ratio is pinned by a test.
 */
export const REFERENCE_RATE_CARD: RateCard = {
	input: 0.3,
	cacheRead: 0.075,
	cacheWrite: 0.3833,
	output: 2.5,
	source: "published Google Gemini Flash rates (input $0.30/M, cached input $0.075/M, output $2.50/M)",
};

/**
 * What one token costs, in dollars, if it enters the context at `turn` of
 * `totalTurns` and stays for the rest of the session.
 *
 * It is billed once as fresh input on the turn it appears, then as a cache read
 * on every subsequent turn. This is the number that makes context compression
 * worth far more than output compression: at 66 turns, a token added early
 * costs about eighteen times its face value.
 *
 * It lives here, beside the rate card it reads and `priceTokens`, because both
 * ceiling scripts price their sweeps with it and each had its own copy. Two
 * definitions of how retention is billed is two answers to the question every
 * saving claim in this bench is expressed in.
 */
export function retainedTokenCost(turn: number, totalTurns: number): number {
	const rereads = Math.max(0, totalTurns - turn - 1);
	return (REFERENCE_RATE_CARD.input + REFERENCE_RATE_CARD.cacheRead * rereads) / 1_000_000;
}

/** The token counts a priced comparison needs, kept separate on purpose. */
export interface TokenMix {
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
}

/**
 * A priced token mix, broken out by line so a regression is attributable.
 *
 * `total` alone cannot answer "why did this arm get more expensive". The
 * components can: an arm that cuts `output` by 8% and adds one full cache miss
 * shows a smaller output line and a much larger input line, and the sign of
 * `total` then follows from arithmetic rather than from hope.
 */
export interface CostBreakdown {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly total: number;
}

/**
 * Price a token mix at a rate card.
 *
 * Missing counts are treated as zero rather than as unknown, because a session
 * that reports no `cacheWrite` field genuinely wrote no cache. A session with
 * no usage at all is filtered out before it reaches here (see `isHardError`).
 */
export function priceTokens(mix: TokenMix, rates: RateCard = REFERENCE_RATE_CARD): CostBreakdown {
	const input = (rates.input / 1_000_000) * mix.inputTokens;
	const cacheRead = (rates.cacheRead / 1_000_000) * mix.cacheReadTokens;
	const cacheWrite = (rates.cacheWrite / 1_000_000) * mix.cacheWriteTokens;
	const output = (rates.output / 1_000_000) * mix.outputTokens;
	return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

/**
 * Each line's share of the total, as a fraction in [0, 1].
 *
 * This is the number that decides where optimization effort belongs. Reporting
 * it next to every cost figure is what stops another effort from spending weeks
 * on the smallest line: if `output` is 0.19, then halving output tokens buys at
 * most 9.5% of the bill, and no amount of tuning changes that ceiling.
 *
 * A zero total yields zero shares rather than `NaN`, so a report that includes
 * an empty arm still prints.
 */
export function costShares(cost: CostBreakdown): Omit<CostBreakdown, "total"> {
	if (cost.total <= 0) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	return {
		input: cost.input / cost.total,
		cacheRead: cost.cacheRead / cost.total,
		cacheWrite: cost.cacheWrite / cost.total,
		output: cost.output / cost.total,
	};
}
