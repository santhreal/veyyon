import type { JsonPrimitive, JsonValue } from "@veyyon/utils";
import type { Veracity } from "./core/veracity";

/**
 * JSON, from the one place that declares it.
 *
 * Re-exported rather than declared, because this package declared it three times:
 * here, in `core/beam/types.ts`, and in `mcp-tools.ts`. All three were the same type,
 * which is what made the copies easy to keep making and impossible to notice: a reader
 * comparing two of the modules had to read both definitions to learn that they agreed.
 */
export type { JsonPrimitive, JsonValue };

/**
 * The scalar under an older name, kept because it is exported from a published package.
 *
 * `JsonPrimitive` is the canonical spelling, and this package used both: `JsonScalar`
 * here and `JsonPrimitive` in the two other copies, for the identical type. New code
 * should say `JsonPrimitive`.
 */
export type JsonScalar = JsonPrimitive;

/** Free-form metadata carried alongside a memory. */
export type Metadata = Record<string, JsonValue>;
/**
 * What a memory's veracity can be, from the module that owns the vocabulary and the weight
 * each value carries at recall.
 *
 * Declared here as a five-member union with `| (string & {})`, which admitted `"true"` and
 * `"false"` at the type level while the validator clamped both to `"unknown"`. Now there is
 * one list, it has eight values, and it cannot drift from the weights because it is derived
 * from them. See `core/veracity.ts`.
 */
export type { Veracity };

/**
 * A veracity as it comes back OUT of the database, which is any string.
 *
 * The column is `TEXT DEFAULT 'unknown'` with no CHECK constraint, so a row written by an
 * older version, an import from another store, or a hand-edited database can hold a value
 * outside the vocabulary. Typing a read row as the closed {@link Veracity} would say the
 * eight are the only possibilities and would let a consumer write an exhaustive `switch`
 * that a real row falls through. Put one of these through `clampVeracity` before treating
 * it as a {@link Veracity}, or through `weightForVeracity` to score it; both report a value
 * they do not recognize instead of quietly reading it as unlabelled.
 */
export type StoredVeracity = string;
/**
 * A vector a caller may HAND to this package.
 *
 * Deliberately wide: an embedding read back from JSON is a `number[]`, one produced by a
 * provider is a `Float32Array`, and a reader passing either should not have to convert.
 * What the package produces is narrower -- see {@link DenseVector}.
 */
export type Vector = Float32Array | readonly number[];

/**
 * A vector this package PRODUCES: always a dense `Float32Array`.
 *
 * The two names exist because the two directions are genuinely different, and for a while
 * both were called `Vector`: `types.ts` had the wide union, while `core/embeddings.ts` and
 * `core/shmr.ts` each declared their own `Vector = Float32Array` and used it for values
 * they construct. Three declarations, two meanings, one word -- so an editor's
 * auto-import decided whether the type you got accepted a plain array, and the copies
 * could drift without anything comparing them. Both modules now take this name from here
 * and re-export it under their old spelling, so their surface is unchanged and there is
 * one place that says what a dense vector is.
 */
export type DenseVector = Float32Array;
export type VecType = "float32" | "int8" | "bit";

export interface MemoryRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	session_id: string;
	importance: number;
	metadata_json: string | null;
	veracity: StoredVeracity;
	created_at: string;
	recall_count?: number | null;
	last_recalled?: string | null;
	valid_until?: string | null;
	superseded_by?: string | null;
	scope?: string | null;
	memory_type?: string | null;
	trust_tier?: string | null;
	author_id?: string | null;
	author_type?: string | null;
	channel_id?: string | null;
	topic?: string | null;
}

export type WorkingMemoryRow = MemoryRow;

export interface EpisodicMemoryRow extends MemoryRow {
	rowid: number;
	summary_of: string;
	tier?: number | null;
	degraded_at?: string | null;
	event_date?: string | null;
	episode_type?: string | null;
}

export interface MemoryInput {
	content: string;
	source?: string | null;
	timestamp?: string | Date | null;
	session_id?: string;
	importance?: number;
	metadata?: Metadata | null;
	veracity?: Veracity;
	scope?: string | null;
	valid_until?: string | Date | null;
}

export interface WorkingMemory {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	sessionId: string;
	importance: number;
	metadata: Metadata | null;
	veracity: StoredVeracity;
	createdAt: string;
}

export interface EpisodicMemory extends WorkingMemory {
	rowid: number;
	summaryOf: string;
	tier: number;
	degradedAt: string | null;
}

/**
 * A recall result is `RecallResult` in `core/beam/types.ts`, which is what recall RETURNS and
 * what `@veyyon/mnemopi` exports.
 *
 * This module used to declare a second interface under that name: a flat hand-written row with a
 * required `score`, no `truncated`/`full_length`, and `tier` typed as a number rather than a
 * {@link RecallTierLabel}. Nothing imported it -- every consumer, inside the package and out,
 * takes the beam one -- so it existed only as something an editor could auto-import instead of
 * the real type, and it would have typechecked while missing the truncation fields a caller has
 * to check before trusting `content`.
 */

export interface AnnotationRow {
	id: number;
	memory_id: string;
	kind: string;
	value: string;
	source: string | null;
	confidence: number;
	created_at: string;
}

export interface TripleRow {
	id: number;
	subject: string;
	predicate: string;
	object: string;
	valid_from: string;
	valid_until: string | null;
	source: string | null;
	confidence: number;
	created_at: string;
}

export interface FactRow {
	fact_id: string;
	session_id: string;
	subject: string;
	predicate: string;
	object: string;
	timestamp: string | null;
	source_msg_id: string | null;
	confidence: number;
	created_at: string;
}

export interface EmbeddingRow {
	memory_id: string;
	embedding_json: string;
	model: string | null;
	created_at: string;
}

export interface EmbeddingResult {
	memory_id: string;
	embedding: Vector;
	model: string | null;
	dim: number;
}

export interface VectorSearchResult {
	rowid?: number;
	id?: string;
	memory_id?: string;
	distance: number;
	score?: number;
}

export interface MemoryStats {
	working_count: number;
	episodic_count: number;
	embedding_count?: number;
	annotation_count?: number;
	triple_count?: number;
}
