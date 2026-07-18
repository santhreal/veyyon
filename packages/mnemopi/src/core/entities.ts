import { levenshteinDistance } from "@veyyon/utils";
import { ENTITY_STOPWORDS } from "./stopwords";

// Backed by the canonical entity/mention stopword set in stopwords.ts, which is
// the union of this list and the annotations.ts noisy-mention list. See
// stopwords.ts for the divergence it fixed. Re-exported under the historical
// name so existing importers keep working.
export const ENTITY_EXTRACTION_STOP_WORDS: ReadonlySet<string> = ENTITY_STOPWORDS;
/** Maximum raw text size for regex-only entity extraction. */
export const REGEX_EXTRACTION_MAX_INPUT_CHARS = 50_000;

const ENTITY_PATTERNS: readonly RegExp[] = [
	/@(\w{2,30})/g,
	/#(\w{2,30})/g,
	/"([^"]{2,50})"/g,
	/'([^']{2,50})'/g,
	/\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){1,4})\b/g,
	/\b([A-Z][a-zA-Z]{1,20})\b/g,
];

function chars(value: string): string[] {
	return Array.from(value);
}

// Canonical implementation lives in @veyyon/utils (UTF-16 code-unit
// granularity — an astral char counts as two edits, acceptable for entity
// similarity); re-exported for existing importers of this module.
export { levenshteinDistance };
export function similarity(s1: string, s2: string): number {
	const s1Lower = s1.toLowerCase().trim();
	const s2Lower = s2.toLowerCase().trim();
	if (s1Lower === s2Lower) return 1.0;

	const maxLen = Math.max(chars(s1Lower).length, chars(s2Lower).length);
	if (maxLen === 0) return 1.0;

	if (s1Lower.startsWith(s2Lower) || s2Lower.startsWith(s1Lower)) {
		const longer = Math.max(chars(s1Lower).length, chars(s2Lower).length);
		const shorter = Math.min(chars(s1Lower).length, chars(s2Lower).length);
		if (shorter / longer < 0.3) return 0.0;
		return 0.7 + (shorter / longer) * 0.3;
	}

	if (s1Lower.includes(s2Lower) || s2Lower.includes(s1Lower)) {
		const longer = Math.max(chars(s1Lower).length, chars(s2Lower).length);
		const shorter = Math.min(chars(s1Lower).length, chars(s2Lower).length);
		return 0.5 + (shorter / longer) * 0.3;
	}

	const dist = levenshteinDistance(s1Lower, s2Lower);
	return 1.0 - dist / maxLen;
}

function isPureNumber(entity: string): boolean {
	const normalized = entity.replaceAll(".", "").replaceAll(",", "");
	return normalized.length > 0 && /^\d+$/.test(normalized);
}

export function extractEntitiesRegex(text: string): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	if (text.length > REGEX_EXTRACTION_MAX_INPUT_CHARS) return [];

	const entities = new Set<string>();
	for (const sourcePattern of ENTITY_PATTERNS) {
		const pattern = new RegExp(sourcePattern.source, sourcePattern.flags);
		for (const match of text.matchAll(pattern)) {
			const captured = match[1];
			if (captured === undefined) continue;
			const entity = captured.trim();
			if (entity.length < 2) continue;

			const words = entity.split(/\s+/).filter(word => word.length > 0);
			if (words.length === 1 && ENTITY_EXTRACTION_STOP_WORDS.has(entity.toLowerCase())) continue;
			if (words.some(word => ENTITY_EXTRACTION_STOP_WORDS.has(word.toLowerCase()))) continue;
			if (isPureNumber(entity)) continue;

			const first = entity[0];
			if (words.length === 1 && first !== undefined && first >= "a" && first <= "z") {
				const groupStart = match.index + match[0].indexOf(captured);
				const prefixChar = groupStart > 0 ? text[groupStart - 1] : undefined;
				if (prefixChar !== "@" && prefixChar !== "#") continue;
			}

			entities.add(entity);
		}
	}

	const result = Array.from(entities).sort();
	const filtered = new Set<string>();
	for (const entity of result) {
		let isSubstring = false;
		for (const other of result) {
			if (other === entity || !other.includes(entity)) continue;
			if (entity.startsWith("@") || entity.startsWith("#")) continue;
			if (other.startsWith("@") || other.startsWith("#")) continue;
			isSubstring = true;
			break;
		}
		if (!isSubstring) filtered.add(entity);
	}
	return Array.from(filtered).sort();
}
export type SimilarEntity = readonly [entity: string, score: number];

export function findSimilarEntities(
	entity: string,
	knownEntities: readonly string[],
	threshold = 0.8,
): SimilarEntity[] {
	const matches: SimilarEntity[] = [];
	for (const known of knownEntities) {
		if (known === entity) {
			matches.push([known, 1.0]);
			continue;
		}
		const score = similarity(entity, known);
		if (score >= threshold) matches.push([known, score]);
	}
	matches.sort((left, right) => right[1] - left[1]);
	return matches;
}
export function entityExtractionPerformance(text: string, iterations = 1000): number {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) extractEntitiesRegex(text);
	return (performance.now() - start) / iterations;
}
