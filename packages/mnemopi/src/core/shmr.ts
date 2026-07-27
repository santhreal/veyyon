import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { batched, clampLow, logger } from "@veyyon/utils";
import {
	shmrBatchSize,
	shmrHarmonyThreshold,
	shmrMaxIterations,
	shmrMinClusterSize,
	shmrSimilarityThreshold,
} from "../config";
import { SQLITE_IN_CLAUSE_BATCH, sqlPlaceholders, tableExists } from "../util/sqlite";
import * as embeddings from "./embeddings";
import { cosineSimilarity, decodeEmbeddingJson } from "./vector-math";

export { cosineSimilarity };

// Read through `../config`, the one owner of every MNEMOPI_* knob, rather than parsing the
// same five names here. Each accessor falls back to its default instead of seeding NaN,
// which matters most for the thresholds: a NaN threshold makes every `>= threshold`
// comparison false, so clustering and harmonization would quietly produce nothing.
export const SHMR_BATCH_SIZE = shmrBatchSize();
export const SHMR_MAX_ITERATIONS = shmrMaxIterations();
export const SHMR_SIMILARITY_THRESHOLD = shmrSimilarityThreshold();
export const SHMR_HARMONY_THRESHOLD = shmrHarmonyThreshold();
export const SHMR_MIN_CLUSTER_SIZE = shmrMinClusterSize();
/**
 * The width of the SHA1 bag-of-words fallback vector, and of nothing else.
 *
 * It used to be called `EMBEDDING_DIM`, the same name `core/embeddings.ts` and
 * `core/binary-vectors.ts` use for the CONFIGURED MODEL'S width. Two meanings under one
 * name is how the mixed-space bug below survived review: reading `EMBEDDING_DIM` here it
 * looks as though the hash vectors and the provider's vectors are the same width, so
 * comparing them looks harmless. They are not the same width and they are not the same
 * space. This number is a property of `hashEmbedding` alone, chosen because 384 slots is
 * enough for a word-frequency sketch, and it moves independently of any model.
 */
const HASH_EMBEDDING_DIM = 384;

// Same as `core/embeddings.ts`: the dense `Float32Array` this module builds, defined once
// in `../types` and re-exported under the name this module has always used.
import type { DenseVector as Vector } from "../types";

export type { DenseVector as Vector } from "../types";
export interface ShmrItem {
	readonly fact_id?: string;
	readonly subject?: string;
	readonly predicate?: string;
	readonly object?: string;
	readonly content?: string;
	readonly confidence?: number;
	readonly timestamp?: string;
	readonly source?: string;
	readonly embedding?: Vector;
}
export interface Belief {
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly action?: "create" | "update" | "dampen";
	readonly target_fact_id?: string | null;
	readonly rationale?: string;
}
export interface HarmonizeStats {
	readonly clusters_found: number;
	readonly beliefs_generated: number;
	readonly contradictions_resolved: number;
	readonly harmony_score_avg: number;
	readonly duration_ms: number;
	readonly status: "insufficient_candidates" | "harmonized" | "no_convergence";
}

type BeamLike = {
	readonly conn?: Database;
	readonly db?: Database;
	readonly session_id?: string;
	readonly sessionId?: string;
};

type FactRow = {
	fact_id: string;
	subject: string;
	predicate: string;
	object: string;
	confidence: number | null;
	timestamp: string | null;
};
type EpisodeRow = {
	id: string;
	content: string;
	importance: number | null;
	created_at: string | null;
};
type BeliefRow = {
	belief_id: string;
	subject: string | null;
	predicate: string | null;
	object: string;
	confidence: number | null;
	provenance: string | null;
	created_at: string | null;
};

export const FACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS harmonic_beliefs (
	belief_id TEXT PRIMARY KEY,
	subject TEXT,
	predicate TEXT,
	object TEXT NOT NULL,
	confidence REAL DEFAULT 0.5,
	provenance TEXT,
	cluster_id TEXT,
	iteration INTEGER DEFAULT 0,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memory_resonance_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT,
	cluster_count INTEGER,
	beliefs_generated INTEGER,
	contradictions_resolved INTEGER,
	harmony_score_avg REAL,
	duration_ms INTEGER,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_beliefs_subject ON harmonic_beliefs(subject);
CREATE INDEX IF NOT EXISTS idx_beliefs_predicate ON harmonic_beliefs(predicate);
CREATE INDEX IF NOT EXISTS idx_beliefs_confidence ON harmonic_beliefs(confidence);
`;

export function initSchema(db: Database): void {
	db.exec(FACTS_SCHEMA_SQL);
}
function hashEmbedding(text: string): Vector {
	const out = new Float32Array(HASH_EMBEDDING_DIM);
	const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const word of words) {
		const digest = createHash("sha1").update(word).digest();
		const slot = digest.readUInt16BE(0) % HASH_EMBEDDING_DIM;
		out[slot] = (out[slot] ?? 0) + 1;
	}
	return out;
}

/** The text SHMR embeds for an item: its object, or its content when it has no object. */
function itemText(item: ShmrItem | undefined): string {
	return item?.object ?? item?.content ?? "";
}

/**
 * Refuse to compare vectors that are not in one embedding space.
 *
 * A cosine between a 384-slot word-frequency sketch and a 1024-dimension bge vector is a
 * number, not a similarity, and `cosineSimilarity` will happily produce one: it zero-pads
 * the shorter side to the longer side's length. That is why the mixing was invisible.
 * Widths agreeing does not prove the spaces agree, but widths disagreeing PROVES they do
 * not, so this is the cheap check that catches the real cases: a store holding rows from
 * two different models, or provider vectors mixed with the hash fallback.
 */
function assertOneEmbeddingSpace(vectors: readonly Vector[], context: string): void {
	const first = vectors[0];
	if (first === undefined) return;
	for (const vector of vectors) {
		if (vector.length === first.length) continue;
		throw new Error(
			`mnemopi shmr: ${context} mixes embedding widths (${first.length} and ${vector.length}). ` +
				"Vectors from different models, or provider vectors mixed with the hash fallback, cannot be " +
				"compared. Re-embed the affected rows with one model, or clear memory_embeddings so they are " +
				"re-embedded together.",
		);
	}
}

/**
 * Embed a batch of texts, returning exactly one vector per text, all in one space.
 *
 * When the provider is unavailable or fails, the WHOLE batch degrades to the
 * deterministic SHA1 bag-of-words hash. It degrades as a batch on purpose: a per-text
 * fallback would return some provider vectors and some hash vectors from a single call,
 * and comparing those is meaningless. Every degrade is logged, never silent, because the
 * only symptom otherwise is recall quietly getting worse.
 */
export async function embedBatch(texts: readonly string[]): Promise<Vector[]> {
	return (await embedBatchTracked(texts)).vectors;
}

/**
 * `embedBatch`, plus whether the hash fallback was taken.
 *
 * Callers that hold vectors from an earlier call need to know, and they cannot infer it
 * from the width: the default model, `BAAI/bge-small-en-v1.5`, is itself 384 dimensions,
 * exactly the hash sketch's width. Guessing from the width would call every default-model
 * batch a degrade.
 */
async function embedBatchTracked(texts: readonly string[]): Promise<{ vectors: Vector[]; degraded: boolean }> {
	if (texts.length === 0) return { vectors: [], degraded: false };
	let matrix: embeddings.EmbeddingMatrix | null = null;
	try {
		matrix = await embeddings.embed(texts);
	} catch (error) {
		logger.warn("mnemopi shmr embedding provider failed; recall degraded to hash embeddings for this batch", {
			error: String(error),
		});
	}
	if (matrix !== null && matrix.length !== texts.length) {
		// Used to fall through to the hash unannounced. A provider that returns the wrong
		// number of vectors is a defect in that provider, and swallowing it means the
		// degrade is attributed to nothing.
		logger.warn("mnemopi shmr embedding provider returned the wrong number of vectors; recall degraded to hash", {
			requested: texts.length,
			returned: matrix.length,
		});
		matrix = null;
	}
	if (matrix !== null) {
		assertOneEmbeddingSpace(matrix, "the embedding provider's own output");
		return { vectors: matrix, degraded: false };
	}
	return { vectors: texts.map(hashEmbedding), degraded: true };
}

export async function embed(text: string): Promise<Vector> {
	// `embedBatch` returns one vector per text or throws, so the empty case cannot happen.
	const [vector] = await embedBatch([text]);
	if (vector === undefined) throw new Error("mnemopi shmr: embedBatch returned no vector for a single text");
	return vector;
}

/**
 * Resolve one vector per item, all in one embedding space.
 *
 * Caller-provided embeddings (`item.embedding`, which `harmonize` seeds from the stored
 * `memory_embeddings` rows) are kept when the items that still need embedding can be
 * embedded by the provider, because both then come from the same model.
 *
 * WHEN THE PROVIDER IS UNAVAILABLE, EVERY ITEM IS RE-HASHED, INCLUDING THE ONES THAT
 * ARRIVED WITH A REAL VECTOR. That is the fix for a live mixed-space bug: this used to
 * keep the stored provider vectors and hash-fill only the rest, so `clusterBySimilarity`
 * compared 1024-dimension bge vectors against 384-slot word sketches, zero-padded to
 * match, and clustered on the resulting noise. Nothing threw and nothing logged. Losing
 * the provider vectors for one pass is a real cost, and it is the smaller one: a
 * consistent weaker space still clusters, a mixed space does not.
 */
async function resolveItemVectors(items: readonly ShmrItem[]): Promise<Vector[]> {
	const vectors: (Vector | undefined)[] = items.map(item => item.embedding);
	const missingIndices: number[] = [];
	const missingTexts: string[] = [];
	for (let i = 0; i < items.length; i++) {
		if (vectors[i] !== undefined) continue;
		missingIndices.push(i);
		missingTexts.push(itemText(items[i]));
	}
	if (missingIndices.length === 0) {
		const provided = vectors as Vector[];
		assertOneEmbeddingSpace(provided, "the caller's own item embeddings");
		return provided;
	}

	const { vectors: fresh, degraded } = await embedBatchTracked(missingTexts);
	const someWereProvided = missingIndices.length < items.length;
	if (degraded && someWereProvided) {
		logger.warn("mnemopi shmr re-hashed every item so one pass stays in one embedding space", {
			provided: items.length - missingIndices.length,
			hashed: missingIndices.length,
		});
		return items.map(item => hashEmbedding(itemText(item)));
	}

	for (let k = 0; k < missingIndices.length; k++) {
		const index = missingIndices[k];
		const vector = fresh[k];
		if (index === undefined || vector === undefined) {
			throw new Error("mnemopi shmr: embedBatch returned fewer vectors than texts");
		}
		vectors[index] = vector;
	}
	const resolved = vectors as Vector[];
	assertOneEmbeddingSpace(resolved, "the caller's item embeddings and the freshly embedded ones");
	return resolved;
}

export async function clusterBySimilarity(items: readonly ShmrItem[], threshold: number): Promise<ShmrItem[][]> {
	if (items.length === 0) return [];
	const vectors = await resolveItemVectors(items);
	const adjacency: number[][] = Array.from({ length: items.length }, () => []);
	for (let i = 0; i < items.length; i++) {
		const leftEmbedding = vectors[i];
		if (leftEmbedding === undefined) continue;
		for (let j = i + 1; j < items.length; j++) {
			const rightEmbedding = vectors[j];
			if (rightEmbedding === undefined) continue;
			if (cosineSimilarity(leftEmbedding, rightEmbedding) >= threshold) {
				adjacency[i]?.push(j);
				adjacency[j]?.push(i);
			}
		}
	}
	const visited = new Set<number>();
	const clusters: ShmrItem[][] = [];
	for (let i = 0; i < items.length; i++) {
		if (visited.has(i)) continue;
		const cluster: ShmrItem[] = [];
		const stack = [i];
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined || visited.has(node)) continue;
			visited.add(node);
			const item = items[node];
			if (item !== undefined) cluster.push(item);
			for (const next of adjacency[node] ?? []) if (!visited.has(next)) stack.push(next);
		}
		clusters.push(cluster);
	}
	return clusters;
}

export function formatClusterForLlm(cluster: readonly ShmrItem[]): string {
	const lines = ["=== MEMORY CLUSTER ==="];
	for (let i = 0; i < cluster.length; i++) {
		const item = cluster[i];
		if (item === undefined) continue;
		lines.push(
			`[${i}] (${item.source ?? "fact"}, conf=${(item.confidence ?? 0.5).toFixed(2)}) ${item.subject ?? "unknown"} | ${item.predicate ?? "stated"} | ${item.object ?? item.content ?? ""}`,
		);
	}
	return lines.join("\n");
}

export function extractJsonFromLlmOutput(text: string): Belief[] {
	const candidates = [text];
	const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
	if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
	const bare = /\[\s*\{[\s\S]*?\}\s*\]/.exec(text);
	if (bare?.[0] !== undefined) candidates.push(bare[0]);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (Array.isArray(parsed)) return parsed.filter(isBeliefLike).map(normalizeBelief);
			if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { beliefs?: unknown }).beliefs))
				return (parsed as { beliefs: unknown[] }).beliefs.filter(isBeliefLike).map(normalizeBelief);
		} catch {}
	}
	return [];
}

function isBeliefLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && typeof (value as { object?: unknown }).object === "string";
}

function normalizeBelief(value: Record<string, unknown>): Belief {
	const confidence =
		typeof value.confidence === "number" && Number.isFinite(value.confidence)
			? clampLow(value.confidence, 0.1, 1)
			: 0.5;
	const action = value.action === "update" || value.action === "dampen" ? value.action : "create";
	return {
		subject: typeof value.subject === "string" ? value.subject : "entity",
		predicate: typeof value.predicate === "string" ? value.predicate : "related_to",
		object: value.object as string,
		confidence,
		action,
		target_fact_id: typeof value.target_fact_id === "string" ? value.target_fact_id : null,
		rationale: typeof value.rationale === "string" ? value.rationale : undefined,
	};
}

function deterministicBeliefs(cluster: readonly ShmrItem[]): Belief[] {
	const byTriple = new Map<string, { count: number; confidence: number; item: ShmrItem }>();
	for (const item of cluster) {
		const subject = item.subject ?? "memory";
		const predicate = item.predicate ?? "contains";
		const object = item.object ?? item.content ?? "";
		const key = `${subject}\u0000${predicate}\u0000${object.toLowerCase()}`;
		const existing = byTriple.get(key);
		if (existing === undefined) byTriple.set(key, { count: 1, confidence: item.confidence ?? 0.5, item });
		else {
			existing.count++;
			existing.confidence += item.confidence ?? 0.5;
		}
	}
	const beliefs: Belief[] = [];
	for (const value of byTriple.values()) {
		if (value.count < 2 && cluster.length > 1) continue;
		beliefs.push({
			subject: value.item.subject ?? "memory",
			predicate: value.item.predicate ?? "contains",
			object: value.item.object ?? value.item.content ?? "",
			confidence: Math.min(
				0.95,
				Math.max(0.5, value.confidence / value.count + Math.min(0.2, (value.count - 1) * 0.1)),
			),
			action: "create",
			rationale: "Deterministic corroboration within semantic cluster",
		});
	}
	if (beliefs.length > 0) return beliefs.slice(0, 5);
	const first = cluster[0];
	if (first === undefined) return [];
	return [
		{
			subject: first.subject ?? "memory",
			predicate: first.predicate ?? "contains",
			object: first.object ?? first.content ?? "",
			confidence: Math.max(0.5, first.confidence ?? 0.5),
			action: "create",
			rationale: "Deterministic representative belief",
		},
	];
}

/**
 * Score how well a cluster's beliefs sit at the centre of the cluster itself.
 *
 * The items and the beliefs are embedded in ONE call. They used to be two: the items
 * through `resolveItemVectors` and the beliefs through a separate `embedBatch`. Two calls
 * can make two different decisions about the hash fallback, so a provider that failed
 * between them left the beliefs as word sketches and the items as provider vectors, and
 * the score was a cosine across two unrelated spaces. Embedding both together makes the
 * degrade decision cover both or neither.
 */
export async function computeHarmonyScore(beliefs: readonly Belief[], cluster: readonly ShmrItem[]): Promise<number> {
	if (beliefs.length === 0 || cluster.length === 0) return 0;
	const beliefTexts = beliefs.map(belief => `${belief.predicate} ${belief.object}`);
	const together = await embedBatch([...cluster.map(itemText), ...beliefTexts]);
	const itemVectors = together.slice(0, cluster.length);
	const beliefVectors = together.slice(cluster.length);
	assertOneEmbeddingSpace(together, "a cluster's items and its beliefs");

	// One space means one width, so the centroid is that width. It used to be built at
	// `max(vector.length)`, which is only ever needed when the widths disagree: the code
	// was shaped around the mixed-space bug rather than refusing it.
	const dim = itemVectors[0]?.length ?? 0;
	const centroid = new Float32Array(dim);
	for (const vector of itemVectors)
		for (let i = 0; i < vector.length; i++) centroid[i] = (centroid[i] ?? 0) + (vector[i] ?? 0) / cluster.length;
	let total = 0;
	for (let k = 0; k < beliefs.length; k++) {
		const belief = beliefs[k];
		const vector = beliefVectors[k];
		if (belief === undefined || vector === undefined) continue;
		total += cosineSimilarity(vector, centroid) * belief.confidence;
	}
	return total / beliefs.length;
}

export function applyBeliefs(
	db: Database,
	beliefs: readonly Belief[],
	cluster: readonly ShmrItem[],
	clusterId: string,
): void {
	initSchema(db);
	const now = new Date().toISOString();
	for (const belief of beliefs) {
		const confidence = clampLow(belief.confidence, 0.1, 1);
		if (belief.action === "dampen" && belief.target_fact_id)
			db.run("UPDATE facts SET confidence = MAX(0.1, confidence - 0.15) WHERE fact_id = ?", [belief.target_fact_id]);
		if (belief.action === "update" && belief.target_fact_id)
			db.run("UPDATE facts SET object = ?, confidence = ? WHERE fact_id = ?", [
				belief.object,
				confidence,
				belief.target_fact_id,
			]);
		const beliefId = createHash("sha256")
			.update(`${clusterId}:${belief.subject}:${belief.predicate}:${belief.object.slice(0, 50)}`)
			.digest("hex")
			.slice(0, 24);
		const provenance = JSON.stringify(
			cluster.map(item => item.fact_id).filter((id): id is string => typeof id === "string"),
		);
		db.run(
			`INSERT OR REPLACE INTO harmonic_beliefs (belief_id, subject, predicate, object, confidence, provenance, cluster_id, iteration, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[beliefId, belief.subject, belief.predicate, belief.object, confidence, provenance, clusterId, 0, now],
		);
	}
}

function dbOf(beam: BeamLike): Database {
	const db = beam.conn ?? beam.db;
	if (db === undefined) throw new TypeError("SHMR requires a beam with conn or db");
	return db;
}

function parseEmbeddingJson(raw: unknown): Vector | null {
	const decoded = decodeEmbeddingJson(raw);
	return decoded === null ? null : Float32Array.from(decoded);
}

/** Precomputed vectors from `memory_embeddings` (written by `scheduleEmbedding()`). */
function precomputedVectors(db: Database, memoryIds: readonly (string | undefined)[]): Map<string, Vector> {
	const out = new Map<string, Vector>();
	const ids = memoryIds.filter((id): id is string => id !== undefined);
	if (ids.length === 0 || !tableExists(db, "memory_embeddings")) return out;
	for (const chunk of batched(ids, SQLITE_IN_CLAUSE_BATCH)) {
		const rows = db
			.query(
				`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${sqlPlaceholders(chunk.length)})`,
			)
			.all(...chunk) as Array<{ memory_id: string; embedding_json: string | null }>;
		for (const row of rows) {
			const vector = parseEmbeddingJson(row.embedding_json);
			if (vector !== null) out.set(row.memory_id, vector);
		}
	}
	return out;
}

export async function harmonize(
	beam: BeamLike,
	batchSize = SHMR_BATCH_SIZE,
	maxIterations = SHMR_MAX_ITERATIONS,
	similarityThreshold = SHMR_SIMILARITY_THRESHOLD,
): Promise<HarmonizeStats> {
	const started = performance.now();
	const db = dbOf(beam);
	initSchema(db);
	const bare: ShmrItem[] = [];
	const memoryIds: (string | undefined)[] = [];
	if (tableExists(db, "facts")) {
		const rows = db
			.query(
				"SELECT fact_id, subject, predicate, object, confidence, timestamp FROM facts ORDER BY created_at DESC LIMIT ?",
			)
			.all(batchSize) as FactRow[];
		for (const row of rows) {
			bare.push({
				fact_id: row.fact_id,
				subject: row.subject,
				predicate: row.predicate,
				object: row.object,
				confidence: row.confidence ?? 0.5,
				timestamp: row.timestamp ?? undefined,
				source: "fact",
			});
			memoryIds.push(undefined);
		}
	}
	if (tableExists(db, "episodic_memory")) {
		const rows = db
			.query("SELECT id, content, importance, created_at FROM episodic_memory ORDER BY created_at DESC LIMIT ?")
			.all(Math.max(1, Math.floor(batchSize / 2))) as EpisodeRow[];
		for (const row of rows)
			if (row.content.length > 10) {
				bare.push({
					fact_id: `ep_${row.id}`,
					subject: "memory",
					predicate: "contains",
					object: row.content.slice(0, 300),
					confidence: row.importance ?? 0.5,
					timestamp: row.created_at ?? undefined,
					source: "episodic",
				});
				memoryIds.push(row.id);
			}
	}
	if (bare.length < SHMR_MIN_CLUSTER_SIZE)
		return {
			clusters_found: 0,
			beliefs_generated: 0,
			contradictions_resolved: 0,
			harmony_score_avg: 0,
			duration_ms: Math.floor(performance.now() - started),
			status: "insufficient_candidates",
		};
	const precomputed = precomputedVectors(db, memoryIds);
	const seeded: ShmrItem[] = bare.map((item, i) => {
		const memoryId = memoryIds[i];
		const vector = memoryId !== undefined ? precomputed.get(memoryId) : undefined;
		return vector === undefined ? item : { ...item, embedding: vector };
	});
	const itemVectors = await resolveItemVectors(seeded);
	const candidates: ShmrItem[] = seeded.map((item, i) => ({ ...item, embedding: itemVectors[i] }));
	const clusters = (await clusterBySimilarity(candidates, similarityThreshold)).filter(
		cluster => cluster.length >= SHMR_MIN_CLUSTER_SIZE,
	);
	let totalBeliefs = 0;
	let totalContradictions = 0;
	const scores: number[] = [];
	for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
		const cluster = clusters[clusterIndex];
		if (cluster === undefined) continue;
		const clusterId = `shmr_${Date.now()}_${clusterIndex}`;
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const beliefs = deterministicBeliefs(cluster);
			const score = Math.max(
				await computeHarmonyScore(beliefs, cluster),
				beliefs.length > 0 ? SHMR_HARMONY_THRESHOLD : 0,
			);
			scores.push(score);
			if (score >= SHMR_HARMONY_THRESHOLD) {
				applyBeliefs(db, beliefs, cluster, clusterId);
				totalBeliefs += beliefs.filter(belief => belief.action !== "dampen").length;
				totalContradictions += beliefs.filter(belief => belief.action === "dampen").length;
				break;
			}
		}
	}
	let avg = 0;
	for (const score of scores) avg += score;
	avg = scores.length === 0 ? 0 : avg / scores.length;
	const duration = Math.floor(performance.now() - started);
	db.run(
		"INSERT INTO memory_resonance_log (session_id, cluster_count, beliefs_generated, contradictions_resolved, harmony_score_avg, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
		[
			beam.session_id ?? beam.sessionId ?? "default",
			clusters.length,
			totalBeliefs,
			totalContradictions,
			Number(avg.toFixed(4)),
			duration,
		],
	);
	return {
		clusters_found: clusters.length,
		beliefs_generated: totalBeliefs,
		contradictions_resolved: totalContradictions,
		harmony_score_avg: Number(avg.toFixed(4)),
		duration_ms: duration,
		status: totalBeliefs > 0 ? "harmonized" : "no_convergence",
	};
}

export async function recallBeliefs(beam: BeamLike, query: string, topK = 10): Promise<Array<Record<string, unknown>>> {
	const db = dbOf(beam);
	initSchema(db);
	const rows = db
		.query(
			"SELECT belief_id, subject, predicate, object, confidence, provenance, created_at FROM harmonic_beliefs ORDER BY confidence DESC LIMIT ?",
		)
		.all(topK * 2) as BeliefRow[];
	// Query and rows in one call, so one degrade decision covers both. The per-vector
	// `?? hashEmbedding(...)` that used to guard each read is gone: it could only fire
	// when `embedBatch` returned short, which it no longer does, and when it fired it
	// scored one hash sketch against provider vectors.
	const vectors = await embedBatch([query, ...rows.map(row => row.object)]);
	assertOneEmbeddingSpace(vectors, "a recall query and the beliefs it is scored against");
	const queryEmbedding = vectors[0];
	if (queryEmbedding === undefined) return [];
	return rows
		.map((row, index) => {
			const rowEmbedding = vectors[index + 1];
			if (rowEmbedding === undefined) throw new Error("mnemopi shmr: embedBatch returned fewer vectors than texts");
			return { row, score: cosineSimilarity(queryEmbedding, rowEmbedding) * (row.confidence ?? 0.5) };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map(({ row, score }) => ({
			content: row.object,
			score: Number(score.toFixed(4)),
			belief_id: row.belief_id,
			subject: row.subject,
			predicate: row.predicate,
			provenance: row.provenance,
			source: "harmonic_belief",
		}));
}
export function reflect(
	_beam: BeamLike | null,
	_question: string,
	facts: Array<Record<string, unknown>> | null = null,
	topK = 10,
): string | null {
	if (facts === null || facts.length === 0) return null;
	const sorted = facts
		.slice()
		.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
		.slice(0, topK);
	return (
		sorted
			.map(fact => String(fact.content ?? fact.object ?? ""))
			.filter(text => text.length > 0)
			.join(" ") || null
	);
}

export function getResonanceLog(beam: BeamLike, limit = 10): Array<Record<string, unknown>> {
	const db = dbOf(beam);
	initSchema(db);
	return db.query("SELECT * FROM memory_resonance_log ORDER BY created_at DESC LIMIT ?").all(limit) as Array<
		Record<string, unknown>
	>;
}
