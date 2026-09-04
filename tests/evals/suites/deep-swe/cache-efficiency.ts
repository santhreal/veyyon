/**
 * Prompt cache efficiency, hit rates, and rebilled fresh token overhead.
 *
 * Measures how much of the prompt bill is content already sent to the provider
 * and re-read at the fresh-input rate anyway.
 */

import type { CostBreakdown, RateCard } from "./cost-model";
import { PREFIX_CATEGORIES, sessionPrefixSteps, type TranscriptRecord } from "./prefix-mass";

/** How much of a turn's prompt was served from cache, against how much of it was genuinely new. */
export interface CacheEfficiency {
	/** Prompt tokens billed at the fresh-input rate across every turn. */
	readonly uncachedTokens: number;
	/**
	 * Prompt tokens served from the prefix cache across every turn. These are the
	 * only real hits: they are the one prompt line billed below the input rate.
	 */
	readonly cachedTokens: number;
	/**
	 * Prompt tokens billed as cache writes across every turn.
	 */
	readonly cacheWriteTokens: number;
	/**
	 * Tokens that were new on the turn they were charged for, estimated from the
	 * transcript's own growth at the measured character rate.
	 */
	readonly newContentTokens: number;
	/** Fresh-rate tokens beyond that floor, i.e. content re-read at 4x its cached price. */
	readonly rebilledTokens: number;
}

/** Everything billed at or above the input rate, which is everything that is not a hit. */
export function freshTokens(efficiency: CacheEfficiency): number {
	return efficiency.uncachedTokens + efficiency.cacheWriteTokens;
}

/**
 * The share of prompt tokens actually served from cache.
 *
 * Writes are in the denominator and not the numerator, because a write is a
 * token paid at a premium, not one the cache saved.
 */
export function cacheHitRate(efficiency: CacheEfficiency): number {
	const prompt = efficiency.cachedTokens + freshTokens(efficiency);
	return prompt > 0 ? efficiency.cachedTokens / prompt : 0;
}

/**
 * The average price actually paid per fresh token, blending input and write rates.
 */
export function freshRate(efficiency: CacheEfficiency, rates: RateCard): number {
	const fresh = freshTokens(efficiency);
	if (fresh <= 0) return rates.input;
	return (efficiency.uncachedTokens * rates.input + efficiency.cacheWriteTokens * rates.cacheWrite) / fresh;
}

/**
 * Measure how much of the prompt bill is content the provider had already been
 * sent, and re-read at the fresh-input rate anyway.
 */
export function cacheEfficiency(records: TranscriptRecord[], charsPerToken: number): CacheEfficiency {
	let uncachedTokens = 0;
	let cachedTokens = 0;
	let cacheWriteTokens = 0;
	let newContentTokens = 0;
	let rebilledTokens = 0;
	const usages: { input: number; read: number; write: number }[] = [];
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		const usage = record.message.usage as Record<string, number> | undefined;
		if (!usage) continue;
		usages.push({ input: usage.input ?? 0, read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 });
	}
	let visible = 0;
	let lastVisible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const usage = usages[turn++];
			if (!usage) continue;
			const added = Math.max(0, (visible - lastVisible) / charsPerToken);
			lastVisible = visible;
			const fresh = usage.input + usage.write;
			uncachedTokens += usage.input;
			cachedTokens += usage.read;
			cacheWriteTokens += usage.write;
			newContentTokens += Math.min(added, fresh);
			rebilledTokens += Math.max(0, fresh - added);
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return { uncachedTokens, cachedTokens, cacheWriteTokens, newContentTokens, rebilledTokens };
}

/**
 * What the re-billed tokens cost above what they would have cost as cache hits,
 * as a fraction of the total bill.
 */
export function rebilledCostShare(efficiency: CacheEfficiency, cost: CostBreakdown, rates: RateCard): number {
	if (cost.total <= 0) return 0;
	const overpaid = (efficiency.rebilledTokens * (freshRate(efficiency, rates) - rates.cacheRead)) / 1_000_000;
	return overpaid / cost.total;
}
