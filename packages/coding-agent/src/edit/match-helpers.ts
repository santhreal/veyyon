export function countNewlinesTo(text: string, end: number): number {
	let count = 0;
	for (let i = 0; i < end; i++) {
		if (text.charCodeAt(i) === 0x0a) count++;
	}
	return count;
}

export interface FuzzyMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

export interface MatchOutcome {
	match?: FuzzyMatch;
	closest?: FuzzyMatch;
	occurrences?: number;
	occurrenceLines?: number[];
	occurrencePreviews?: string[];
	fuzzyMatches?: number;
	dominantFuzzy?: boolean;
}

export type SequenceMatchStrategy =
	| "exact"
	| "trim-trailing"
	| "trim"
	| "comment-prefix"
	| "unicode"
	| "prefix"
	| "substring"
	| "fuzzy"
	| "fuzzy-dominant"
	| "character";

export interface SequenceSearchResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: SequenceMatchStrategy;
}

export type ContextMatchStrategy = "exact" | "trim" | "unicode" | "prefix" | "substring" | "fuzzy";

export interface ContextLineResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: ContextMatchStrategy;
}
