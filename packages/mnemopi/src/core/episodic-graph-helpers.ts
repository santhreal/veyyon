import type { Database } from "bun:sqlite";
import type { DatabasePath } from "../db";
import { unicodeWordTokens, WORD_TOKEN_HYPHEN_RE } from "../util/regex";
import { CONTENT_STOPWORDS } from "./stopwords";

export interface Gist {
	readonly id: string;
	readonly text: string;
	readonly timestamp: string;
	readonly participants: readonly string[];
	readonly location: string | null;
	readonly emotion: string | null;
	readonly timeScope: string | null;
}

export interface Fact {
	readonly id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly timestamp: string;
	readonly confidence: number;
	readonly temporalQualifier?: string | null;
}

export interface GraphEdge {
	readonly source: string;
	readonly target: string;
	readonly edgeType: string;
	readonly weight: number;
	readonly timestamp: string;
}

export interface RelatedMemory {
	readonly memoryId: string;
	readonly edgeType: string;
	readonly weight: number;
	readonly depth: number;
}

export interface GraphStats {
	readonly gists: number;
	readonly facts: number;
	readonly edges: number;
	readonly totalNodes: number;
}

export interface IngestOptions {
	readonly sessionId?: string;
	readonly linkExisting?: boolean;
	readonly minLinkScore?: number;
	readonly extractEntities?: boolean;
}

export interface IngestResult {
	readonly memoryId: string;
	readonly gist: Gist;
	readonly facts: readonly Fact[];
	readonly edges: readonly GraphEdge[];
}

export interface EpisodicGraphOptions {
	readonly db?: Database;
	readonly dbPath?: DatabasePath;
}

export interface CountRow {
	readonly count: number;
}

export interface GistRow {
	readonly id: string;
	readonly text: string;
	readonly timestamp: string | null;
	readonly participants_json: string | null;
	readonly location: string | null;
	readonly emotion: string | null;
	readonly time_scope: string | null;
	readonly memory_id: string | null;
}

export interface FactRow {
	readonly fact_id: string;
	readonly session_id: string | null;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly timestamp: string | null;
	readonly source_msg_id: string | null;
	readonly confidence: number | null;
}

export interface EdgeRow {
	readonly source: string;
	readonly target: string;
	readonly edge_type: string;
	readonly weight: number;
	readonly timestamp: string | null;
}

export const EXTRACT_FACTS_MAX_CONTENT_LEN = 4096;
export const MAX_FACTS_PER_MEMORY = 5;
export const DEFAULT_LINK_THRESHOLD = 0.35;

export function unique(values: Iterable<string>, limit = Number.MAX_SAFE_INTEGER): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		const value = raw.trim();
		if (value.length === 0) continue;
		const key = value.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
		if (out.length >= limit) break;
	}
	return out;
}

function parseJsonStringArray(value: string | null): string[] {
	if (value === null || value === "") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const strings: string[] = [];
		for (const item of parsed) {
			if (typeof item === "string") strings.push(item);
		}
		return strings;
	} catch {
		// A stored tag list that is not JSON has no tags to return, which is the same empty list a row with no
		// tags gives and the same one a non-array value gives above. Reading it cannot repair it, and the
		// caller treats the memory as untagged rather than skipping the memory.
		return [];
	}
}

export function rowToGist(row: GistRow): Gist {
	return {
		id: row.id,
		text: row.text,
		timestamp: row.timestamp ?? "",
		participants: parseJsonStringArray(row.participants_json),
		location: row.location,
		emotion: row.emotion,
		timeScope: row.time_scope,
	};
}

export function rowToFact(row: FactRow): Fact {
	return {
		id: row.fact_id,
		subject: row.subject,
		predicate: row.predicate,
		object: row.object,
		timestamp: row.timestamp ?? "",
		confidence: row.confidence ?? 0.5,
		temporalQualifier: null,
	};
}

export function edgeFromRow(row: EdgeRow): GraphEdge {
	return {
		source: row.source,
		target: row.target,
		edgeType: row.edge_type,
		weight: row.weight,
		timestamp: row.timestamp ?? "",
	};
}

export function clampWeight(weight: number): number {
	if (!Number.isFinite(weight)) return 1;
	if (weight < 0) return 0;
	if (weight > 1) return 1;
	return weight;
}

export function lowerSet(values: readonly (string | null)[]): Set<string> {
	const out = new Set<string>();
	for (const value of values) {
		if (value === null) continue;
		const normalized = value.trim().toLocaleLowerCase();
		if (normalized.length > 0) out.add(normalized);
	}
	return out;
}

export function contentTokenSet(text: string): Set<string> {
	const out = new Set<string>();
	for (const token of unicodeWordTokens(text.toLocaleLowerCase(), WORD_TOKEN_HYPHEN_RE)) {
		if (token.length < 3 || CONTENT_STOPWORDS.has(token)) continue;
		out.add(token);
	}
	return out;
}
