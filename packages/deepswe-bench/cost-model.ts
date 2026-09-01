export interface RateCard {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly source: string;
}

export const REFERENCE_RATE_CARD: RateCard = {
	input: 0.3,
	cacheRead: 0.075,
	cacheWrite: 0.3833,
	output: 2.5,
	source: "published Google Gemini Flash rates (input $0.30/M, cached input $0.075/M, output $2.50/M)",
};

export function retainedTokenCost(turn: number, totalTurns: number): number {
	const rereads = Math.max(0, totalTurns - turn - 1);
	return (REFERENCE_RATE_CARD.input + REFERENCE_RATE_CARD.cacheRead * rereads) / 1_000_000;
}

export interface TokenMix {
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
}

export interface CostBreakdown {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly total: number;
}

export function priceTokens(mix: TokenMix, rates: RateCard = REFERENCE_RATE_CARD): CostBreakdown {
	const input = (rates.input / 1_000_000) * mix.inputTokens;
	const cacheRead = (rates.cacheRead / 1_000_000) * mix.cacheReadTokens;
	const cacheWrite = (rates.cacheWrite / 1_000_000) * mix.cacheWriteTokens;
	const output = (rates.output / 1_000_000) * mix.outputTokens;
	return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

export function costShares(cost: CostBreakdown): Omit<CostBreakdown, "total"> {
	if (cost.total <= 0) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	return {
		input: cost.input / cost.total,
		cacheRead: cost.cacheRead / cost.total,
		cacheWrite: cost.cacheWrite / cost.total,
		output: cost.output / cost.total,
	};
}
