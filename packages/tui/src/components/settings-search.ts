/** Field-weighted ranking for settings search. Lower scores rank first. */

import { hasAlphanumeric } from "@veyyon/utils/regex";
import { fuzzyMatch } from "../fuzzy";
import type { SettingItem } from "./settings-list";

/**
 * Per-field penalties added to a field's fuzzy score. The gaps are wide on
 * purpose: any label hit must beat any description hit, however good the prose
 * match is, because a fuzzy score varies by a few points while these differ by
 * hundreds.
 */
const FIELD_PENALTY = {
	label: 0,
	keywords: 10,
	id: 20,
	group: 120,
	description: 400,
} as const;

/** Substring hits are what a user believes they typed, so they outrank any
 *  subsequence hit; a prefix is stronger still (`them` -> `theme.dark`). */
const SUBSTRING_BONUS = 2_000;
const PREFIX_BONUS = 3_000;

export interface SettingSearchResult {
	item: SettingItem;
	score: number;
}

function scoreField(query: string, text: string | undefined, penalty: number): number | undefined {
	if (!text) return undefined;
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const at = haystack.indexOf(needle);
	if (at === 0) return penalty - PREFIX_BONUS;
	if (at > 0) return penalty - SUBSTRING_BONUS;
	const match = fuzzyMatch(query, text);
	return match.matches ? penalty + match.score : undefined;
}

/** The best one token can do across every field of an item, or no match. */
function scoreToken(item: SettingItem, token: string): number | undefined {
	const scores: (number | undefined)[] = [
		scoreField(token, item.label, FIELD_PENALTY.label),
		scoreField(token, item.id, FIELD_PENALTY.id),
		scoreField(token, item.group, FIELD_PENALTY.group),
		scoreField(token, item.description, FIELD_PENALTY.description),
	];
	const keywords = item.keywords;
	if (keywords) {
		for (let ki = 0; ki < keywords.length; ki++) {
			scores.push(scoreField(token, keywords[ki]!, FIELD_PENALTY.keywords));
		}
	}
	let best: number | undefined;
	for (let si = 0; si < scores.length; si++) {
		const score = scores[si];
		if (score !== undefined && (best === undefined || score < best)) best = score;
	}
	return best;
}

/** Rank settings items for a query. Returns matching items, best first. */
export function rankSettingItems(items: readonly SettingItem[], query: string): SettingSearchResult[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	if (!hasAlphanumeric(trimmed)) return [];
	// Punctuation-only tokens (a stray `-` between words) cannot match anything;
	// dropping them keeps `auto - compaction` an AND of its two real words.
	const tokens = trimmed.split(/\s+/).filter(hasAlphanumeric);
	if (tokens.length === 0) return [];

	const results: SettingSearchResult[] = [];
	for (let ii = 0; ii < items.length; ii++) {
		const item = items[ii]!;
		if (item.heading) continue;
		let total = 0;
		let matchedAll = true;
		for (let ti = 0; ti < tokens.length; ti++) {
			const best = scoreToken(item, tokens[ti]!);
			if (best === undefined) {
				matchedAll = false;
				break;
			}
			total += best;
		}
		if (matchedAll) results.push({ item, score: total });
	}

	// Ties break on label so the order is stable between renders rather than
	// depending on the input array's order.
	results.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
	return results;
}

/** Matching items only, best first. */
export function filterSettingItems(items: readonly SettingItem[], query: string): SettingItem[] {
	const ranked = rankSettingItems(items, query);
	const result = new Array<SettingItem>(ranked.length);
	for (let ri = 0; ri < ranked.length; ri++) result[ri] = ranked[ri]!.item;
	return result;
}
