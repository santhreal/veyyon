import type { FuzzyFilterResult, FuzzyMatch, SearchIndex } from "./fuzzy-helpers";
import { buildSearchIndex, buildUncachedSearchIndex, fuzzyMatchCore, indexCache, prepareQuery } from "./fuzzy-helpers";

export { fuzzyMatch, isSubsequenceMatch, subsequenceScore } from "./fuzzy-helpers";

export class FuzzyText {
	readonly #index: SearchIndex;

	constructor(text: string) {
		this.#index = buildUncachedSearchIndex(text);
	}

	match(query: string): FuzzyMatch {
		return fuzzyMatchCore(prepareQuery(query), this.#index);
	}
}

export function fuzzyRank<T>(items: readonly T[], query: string, getText: (item: T) => string): FuzzyFilterResult<T>[] {
	if (!query.trim()) {
		const result = new Array<FuzzyFilterResult<T>>(items.length);
		for (let ii = 0; ii < items.length; ii++) result[ii] = { item: items[ii]!, score: 0 };
		return result;
	}

	const pq = prepareQuery(query);
	const results: FuzzyFilterResult<T>[] = [];
	for (let ii = 0; ii < items.length; ii++) {
		const item = items[ii]!;
		const text = getText(item);
		const match = pq === null ? { matches: true, score: 0 } : fuzzyMatchCore(pq, buildSearchIndex(text));
		if (match.matches) {
			results.push({ item, score: match.score });
		}
	}

	results.sort((a, b) => a.score - b.score);
	return results;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
	const ranked = fuzzyRank(items, query, getText);
	const result = new Array<T>(ranked.length);
	for (let ri = 0; ri < ranked.length; ri++) result[ri] = ranked[ri]!.item;
	return result;
}

export function resetFuzzyIndexCache(): void {
	indexCache.clear();
}

export function matchPositions(query: string, text: string): number[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return [];
	const t = text.toLowerCase();
	const hits = new Set<number>();
	const qTokens = q.split(/\s+/);
	for (let qi = 0; qi < qTokens.length; qi++) {
		const token = qTokens[qi]!;
		if (token.length === 0) continue;
		let at = -1;
		for (let i = t.indexOf(token); i >= 0; i = t.indexOf(token, i + 1)) {
			const boundary = i === 0 || !/[a-z0-9]/.test(t[i - 1] ?? "");
			if (boundary) {
				at = i;
				break;
			}
			if (at < 0) at = i;
		}
		if (at >= 0) {
			for (let i = 0; i < token.length; i++) hits.add(at + i);
			continue;
		}
		let qii = 0;
		for (let ti = 0; ti < t.length && qii < token.length; ti++) {
			if (t[ti] === token[qii]) {
				hits.add(ti);
				qii++;
			}
		}
	}
	const result = new Array<number>(hits.size);
	let ri = 0;
	for (const h of hits) result[ri++] = h;
	result.sort((a, b) => a - b);
	return result;
}
