export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export interface FuzzyFilterResult<T> {
	item: T;
	score: number;
}

export interface CharacterMatch {
	matches: boolean;
	score: number;
	span: number;
}

export interface SearchWord {
	text: string;
	index: number;
	ordinal: number;
}

export interface SearchIndex {
	normalized: string;
	compact: string;
	compactWordStarts: Map<number, number>;
	words: SearchWord[];
}

export const ALPHANUMERIC_SWAP_PENALTY = 5;
export const COMPACT_PHRASE_BONUS = 1200;
export const PHRASE_BONUS = 1000;
export const EXTENSION_SUFFIXES = new Set(["s", "es", "d", "ed"]);
export const COMPACT_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"to",
	"in",
	"on",
	"at",
	"or",
	"and",
	"for",
	"is",
	"are",
	"be",
	"as",
	"by",
	"it",
	"its",
	"if",
	"them",
	"then",
	"than",
	"this",
	"that",
	"these",
	"those",
	"with",
	"when",
	"was",
	"were",
	"not",
	"no",
	"so",
	"but",
]);

export function normalizeForSearch(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export const INDEX_CACHE_MAX = 4096;
export const MAX_CACHED_TEXT_LEN = 4096;
export const indexCache = new Map<string, SearchIndex>();

export function buildSearchIndex(text: string): SearchIndex {
	if (text.length > MAX_CACHED_TEXT_LEN) return buildUncachedSearchIndex(text);

	const cached = indexCache.get(text);
	if (cached !== undefined) return cached;

	const result = buildUncachedSearchIndex(text);
	if (indexCache.size < INDEX_CACHE_MAX) {
		indexCache.set(text, result);
	}
	return result;
}

export function buildUncachedSearchIndex(text: string): SearchIndex {
	const normalized = normalizeForSearch(text);
	if (normalized.length === 0) {
		return { normalized, compact: "", compactWordStarts: new Map(), words: [] };
	}

	const words: SearchWord[] = [];
	const compactWordStarts = new Map<number, number>();
	let index = 0;
	let compactIndex = 0;
	let ordinal = 0;
	const normalizedWords = normalized.split(" ");
	for (let wi = 0; wi < normalizedWords.length; wi++) {
		const word = normalizedWords[wi]!;
		words.push({ text: word, index, ordinal });
		compactWordStarts.set(compactIndex, word.length);
		index += word.length + 1;
		compactIndex += word.length;
		ordinal++;
	}

	return { normalized, compact: normalized.replaceAll(" ", ""), compactWordStarts, words };
}

export function scoreCharacters(queryLower: string, textLower: string): CharacterMatch {
	if (queryLower.length === 0) {
		return { matches: true, score: 0, span: 0 };
	}

	if (queryLower.length > textLower.length) {
		return { matches: false, score: 0, span: 0 };
	}

	let queryIndex = 0;
	let score = 0;
	let firstMatchIndex = -1;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIndex]) {
			if (firstMatchIndex < 0) firstMatchIndex = i;

			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}
	}

	if (queryIndex < queryLower.length) {
		return { matches: false, score: 0, span: 0 };
	}

	return { matches: true, score, span: lastMatchIndex - firstMatchIndex + 1 };
}

export function buildAlphanumericSwapQueries(queryLower: string): string[] {
	const variants = new Set<string>();
	for (let i = 0; i < queryLower.length - 1; i++) {
		const current = queryLower[i];
		const next = queryLower[i + 1];
		const isAlphaNumSwap =
			(current && /[a-z]/.test(current) && next && /\d/.test(next)) ||
			(current && /\d/.test(current) && next && /[a-z]/.test(next));
		if (!isAlphaNumSwap) continue;
		const swapped = queryLower.slice(0, i) + next + current + queryLower.slice(i + 2);
		variants.add(swapped);
	}
	return Array.from(variants);
}

export function withPosition(score: number, index: number): number {
	return score + index * 0.01;
}

export function isCompactWordAligned(index: SearchIndex, start: number, length: number): boolean {
	const firstWordLength = index.compactWordStarts.get(start);
	if (firstWordLength === undefined) return false;
	if (!COMPACT_STOPWORDS.has(index.compact.slice(start, start + firstWordLength))) return true;
	const end = start + length;
	return end === index.compact.length || index.compactWordStarts.has(end);
}

export function isWordBoundaryPhrase(normalized: string, index: number, length: number): boolean {
	const before = index === 0 || normalized[index - 1] === " ";
	const afterIndex = index + length;
	const after = afterIndex === normalized.length || normalized[afterIndex] === " ";
	return before && after;
}

export function scoreTokenAgainstWord(token: string, word: SearchWord): FuzzyMatch | null {
	if (word.text === token) {
		return { matches: true, score: withPosition(-200, word.index) };
	}

	if (word.text.startsWith(token)) {
		return { matches: true, score: withPosition(-170 + (word.text.length - token.length) * 0.5, word.index) };
	}

	if (word.text.length >= 4 && token.startsWith(word.text) && EXTENSION_SUFFIXES.has(token.slice(word.text.length))) {
		return { matches: true, score: withPosition(-150 + token.length - word.text.length, word.index) };
	}

	const substringIndex = word.text.indexOf(token);
	if (substringIndex >= 0) {
		return { matches: true, score: withPosition(-20 + substringIndex, word.index) };
	}

	const characterMatch = scoreCharacters(token, word.text);
	if (!characterMatch.matches) return null;

	const maxSpan = Math.max(token.length + 2, Math.ceil(token.length * 1.8));
	if (characterMatch.span > maxSpan) return null;

	return { matches: true, score: withPosition(-40 + characterMatch.score, word.index) };
}

export function scoreAcronym(token: string, index: SearchIndex): FuzzyMatch | null {
	if (token.length < 2 || token.length > 4 || index.words.length === 0) return null;

	let queryIndex = 0;
	let firstOrdinal = -1;
	let lastOrdinal = -1;
	let firstTextIndex = 0;

	for (let wi = 0; wi < index.words.length; wi++) {
		const word = index.words[wi]!;
		if (word.text[0] !== token[queryIndex]) continue;
		if (firstOrdinal < 0) {
			firstOrdinal = word.ordinal;
			firstTextIndex = word.index;
		}
		lastOrdinal = word.ordinal;
		queryIndex++;
		if (queryIndex === token.length) break;
	}

	if (queryIndex < token.length || firstOrdinal < 0 || lastOrdinal < 0) return null;

	const wordSpan = lastOrdinal - firstOrdinal + 1;
	if (wordSpan > token.length + 2) return null;

	return { matches: true, score: withPosition(-30 + wordSpan * 4 - token.length * 2, firstTextIndex) };
}

export function scoreTokenDirect(token: string, index: SearchIndex): FuzzyMatch {
	if (token.length === 0) return { matches: true, score: 0 };

	let best: FuzzyMatch | null = null;
	const compactIndex = index.compact.indexOf(token);
	if (compactIndex >= 0 && isCompactWordAligned(index, compactIndex, token.length)) {
		best = { matches: true, score: withPosition(-140, compactIndex) };
	}
	for (let wi = 0; wi < index.words.length; wi++) {
		const match = scoreTokenAgainstWord(token, index.words[wi]!);
		if (match && (!best || match.score < best.score)) {
			best = match;
		}
	}

	const acronym = scoreAcronym(token, index);
	if (acronym && (!best || acronym.score < best.score)) {
		best = acronym;
	}

	return best ?? { matches: false, score: 0 };
}

export function scoreToken(token: string, index: SearchIndex): FuzzyMatch {
	let best = scoreTokenDirect(token, index);
	if (best.matches) return best;

	const variants = buildAlphanumericSwapQueries(token);
	for (let vi = 0; vi < variants.length; vi++) {
		const match = scoreTokenDirect(variants[vi]!, index);
		if (!match.matches) continue;
		const score = match.score + ALPHANUMERIC_SWAP_PENALTY;
		if (!best.matches || score < best.score) {
			best = { matches: true, score };
		}
	}

	return best;
}

export interface PreparedQuery {
	normalized: string;
	tokens: string[];
	compact: string;
}

export function prepareQuery(query: string): PreparedQuery | null {
	const normalized = normalizeForSearch(query);
	if (normalized.length === 0) return null;
	return { normalized, tokens: normalized.split(" "), compact: normalized.replaceAll(" ", "") };
}

export function hasDistinctWordsForRepeatedTokens(tokens: readonly string[], index: SearchIndex): boolean {
	if (tokens.length < 2) return true;
	const needed = new Map<string, number>();
	for (let ti = 0; ti < tokens.length; ti++) {
		const token = tokens[ti]!;
		needed.set(token, (needed.get(token) ?? 0) + 1);
	}
	for (const [token, count] of needed) {
		if (count < 2) continue;
		let available = 0;
		for (let wi = 0; wi < index.words.length; wi++) {
			if (scoreTokenAgainstWord(token, index.words[wi]!) !== null) available++;
			if (available >= count) break;
		}
		if (available < count) return false;
	}
	return true;
}

export function fuzzyMatchCore(pq: PreparedQuery | null, index: SearchIndex): FuzzyMatch {
	if (pq === null) {
		return { matches: true, score: 0 };
	}

	if (index.words.length === 0) {
		return { matches: false, score: 0 };
	}

	let totalScore = 0;
	const phraseIndex = index.normalized.indexOf(pq.normalized);
	if (phraseIndex >= 0 && isWordBoundaryPhrase(index.normalized, phraseIndex, pq.normalized.length)) {
		totalScore -= PHRASE_BONUS;
		totalScore += phraseIndex * 0.01;
	}

	const compactPhraseIndex = index.compact.indexOf(pq.compact);
	if (compactPhraseIndex >= 0 && isCompactWordAligned(index, compactPhraseIndex, pq.compact.length)) {
		totalScore -= COMPACT_PHRASE_BONUS;
		totalScore += compactPhraseIndex * 0.01;
	}

	for (let ti = 0; ti < pq.tokens.length; ti++) {
		const match = scoreToken(pq.tokens[ti]!, index);
		if (!match.matches) {
			return { matches: false, score: 0 };
		}
		totalScore += match.score;
	}

	if (!hasDistinctWordsForRepeatedTokens(pq.tokens, index)) {
		return { matches: false, score: 0 };
	}

	return { matches: true, score: totalScore };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const pq = prepareQuery(query);
	if (pq === null) return { matches: true, score: 0 };
	return fuzzyMatchCore(pq, buildSearchIndex(text));
}

export function isSubsequenceMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

export function subsequenceScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;
	let qi = 0;
	let gaps = 0;
	let lastMatchIdx = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) {
			if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++;
			lastMatchIdx = ti;
			qi++;
		}
	}
	if (qi !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}
