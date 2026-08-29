import type { Database } from "bun:sqlite";
import { isRecord } from "@veyyon/utils";
import { type Env, polyphonicRecallEnabled } from "../config";
import type { DatabasePath } from "../db";
import { unicodeWordTokens, WORD_TOKEN_HYPHEN_RE } from "../util/regex";
import type { JsonValue, Metadata, RecallResult } from "./beam/types";
import type { EpisodicGraph } from "./episodic-graph";
import type { VeracityConsolidator } from "./veracity-consolidation";

export type PolyphonicVoice = "vector" | "graph" | "fact" | "temporal";

export interface VoiceRecallResult {
	readonly memoryId: string;
	readonly score: number;
	readonly voice: PolyphonicVoice;
	readonly metadata: Metadata;
}

export interface PolyphonicResult {
	readonly memoryId: string;
	combinedScore: number;
	readonly voiceScores: Partial<Record<PolyphonicVoice, number>>;
	readonly metadata: Metadata;
}

export interface PolyphonicMemoryResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	score: number;
	combined_score: number;
	voice_scores: Partial<Record<PolyphonicVoice, number>>;
	metadata: Metadata;
	tier: "working" | "episodic";
}

export interface PolyphonicRecallOptions {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly contextBudget?: number;
}

export interface PolyphonicEngineOptions {
	readonly dbPath?: DatabasePath;
	readonly db?: Database;
	readonly graph?: EpisodicGraph;
	readonly consolidator?: VeracityConsolidator;
	readonly sessionId?: string | null;
	readonly channelId?: string | null;
}

export interface MemoryHydrationRow {
	readonly id: string;
	readonly content: string;
	readonly source: string | null;
	readonly timestamp: string | null;
	readonly session_id: string;
	readonly importance: number;
	readonly metadata_json: string | null;
	readonly veracity: string;
	readonly memory_type: string | null;
	readonly recall_count: number | null;
	readonly last_recalled: string | null;
	readonly valid_until: string | null;
	readonly superseded_by: string | null;
	readonly scope: string | null;
	readonly author_id: string | null;
	readonly author_type: string | null;
	readonly channel_id: string | null;
	readonly trust_tier: string | null;
	readonly created_at: string;
	readonly rowid?: number;
	readonly summary_of?: string;
	readonly tier?: number;
	readonly tier_name: "working" | "episodic";
}

export interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly embedding_tier: "working" | "episodic";
}

export interface TemporalRow {
	readonly id: string;
	readonly timestamp: string | null;
	readonly importance: number;
}

export const RRF_K = 60;
export const POLYPHONIC_VOICES: readonly PolyphonicVoice[] = ["vector", "graph", "fact", "temporal"];

export function polyphonicRecallIsEnabled(env: Env = process.env): boolean {
	return polyphonicRecallEnabled(env);
}
export function metadataValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(metadataValue);
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		const record = value as Record<string, unknown>;
		for (const key in record) {
			out[key] = metadataValue(record[key]);
		}
		return out;
	}
	return String(value);
}

export function parseMetadata(raw: string | null): Metadata {
	if (raw === null || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed)) {
			return metadataValue(parsed) as Metadata;
		}
	} catch {
		// Malformed metadata must not make recall fail.
	}
	return {};
}

export function normalizeVector(vector: readonly number[] | Float32Array): Float32Array | null {
	if (vector.length === 0) return null;
	let normSq = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i];
		if (value === undefined || !Number.isFinite(value)) return null;
		normSq += value * value;
	}
	if (normSq === 0) return null;
	const norm = Math.sqrt(normSq);
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
	return out;
}

export function cosineAgainstUnit(unit: Float32Array, raw: unknown): number | null {
	if (!Array.isArray(raw) || raw.length !== unit.length) return null;
	let normSq = 0;
	let dot = 0;
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		normSq += value * value;
		const unitValue = unit[i];
		if (unitValue === undefined) return null;
		dot += unitValue * value;
	}
	if (normSq === 0) return null;
	return dot / Math.sqrt(normSq);
}

export function extractEntities(text: string): string[] {
	const seen = new Set<string>();
	const matches = text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
	for (const match of matches) {
		const entity = match[0];
		if (entity.length > 0) seen.add(entity);
	}
	return [...seen];
}

export function queryWords(query: string): string[] {
	const seen = new Set<string>();
	for (const word of unicodeWordTokens(query.toLowerCase(), WORD_TOKEN_HYPHEN_RE)) {
		if (word.length >= 3) seen.add(word);
	}
	return [...seen];
}

export function looksTemporal(query: string): boolean {
	const lower = query.toLowerCase();
	return ["yesterday", "today", "recent", "last", "latest", "this week", "this month", "ago", "before"].some(keyword =>
		lower.includes(keyword),
	);
}
