/**
 * Ranking for settings search — the one owner of what "matches" means.
 *
 * The old path concatenated label, id, current value, description and every enum
 * value into ONE string and fuzzy-scored the blob (`getSettingItemFilterText`).
 * Three consequences, all of which the operator felt as "search in settings
 * isn't great" (2026-07-24):
 *
 *  - A hit in a long description scored like a hit in the label, so typing a
 *    common word buried the setting actually named that word under every setting
 *    that merely mentions it.
 *  - The CURRENT VALUE was searchable, so `high` matched every setting that
 *    happens to be set to `high`, and results changed as you changed values.
 *    Search is for finding a setting, not for querying its state.
 *  - Enum values were searchable too, so `off` matched nearly everything.
 *
 * Fields are now scored separately and the best field wins, with a penalty per
 * field so identity (label, id, the words a user would call it) outranks prose.
 * Lower scores rank first, matching `fuzzyRank`.
 *
 * A multi-word query is an AND of its words: every token must match some
 * field, and the item's score is the sum of the per-token bests. The one-needle
 * scorer this replaced made `auto compaction` match NOTHING — the label reads
 * "Auto-Compaction Threshold", which contains neither the space nor the word
 * pair — exactly the query a person types after seeing the label. Summing
 * keeps word order irrelevant, so `theme dark` and `dark theme` rank alike.
 */

import { hasAlphanumeric } from "@veyyon/utils";
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
	for (const keyword of item.keywords ?? []) {
		scores.push(scoreField(token, keyword, FIELD_PENALTY.keywords));
	}
	let best: number | undefined;
	for (const score of scores) {
		if (score !== undefined && (best === undefined || score < best)) best = score;
	}
	return best;
}

/**
 * Rank settings for a query. Returns only matching items, best first; headings
 * are dropped (they are chrome, and a heading that "matched" would strand a
 * section label with no rows under it).
 *
 * A query that is only punctuation returns NOTHING rather than everything.
 * `fuzzyMatch` treats such a query as matching all text with score 0, which
 * previously reported "247 matches" for a typed `.` — a count that means the
 * search failed, phrased as though it succeeded.
 */
export function rankSettingItems(items: readonly SettingItem[], query: string): SettingSearchResult[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	if (!hasAlphanumeric(trimmed)) return [];
	// Punctuation-only tokens (a stray `-` between words) cannot match anything;
	// dropping them keeps `auto - compaction` an AND of its two real words.
	const tokens = trimmed.split(/\s+/).filter(hasAlphanumeric);
	if (tokens.length === 0) return [];

	const results: SettingSearchResult[] = [];
	for (const item of items) {
		if (item.heading) continue;
		let total = 0;
		let matchedAll = true;
		for (const token of tokens) {
			const best = scoreToken(item, token);
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
	return rankSettingItems(items, query).map(result => result.item);
}
