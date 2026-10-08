import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import { batched } from "@veyyon/utils/array";
import * as logger from "@veyyon/utils/logger";
import { HOUR_MS } from "@veyyon/utils/time";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { scratchpadMaxItems } from "../../config";
import { transaction } from "../../db";
import { toUtcIso } from "../../util/datetime";
import { generateId } from "../../util/ids";
import { getMemoryTableStats } from "../../util/sqlite";
import { currentEmbeddingModel, embeddingsDisabled } from "../embeddings";
import { EpisodicGraph } from "../episodic-graph";
import { countExtractedFactCategories, extractFactCategoriesSafe } from "../extraction";
import { getMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "../runtime-options";
import { clampVeracity } from "../veracity";
import { storeExtractedFactCategories } from "./consolidate";
import { type EmbedItem, scheduleEmbedding, vecAvailable, vecInsert } from "./helpers";
import type {
	BeamEvent,
	BeamMemoryState,
	BeamStats,
	ImportStats,
	Metadata,
	RememberBatchItem,
	RememberBatchOptions,
	RememberOptions,
	TrustTier,
	Veracity,
} from "./types";

type Row = Record<string, unknown>;
type EventPayload = Omit<BeamEvent, "type" | "sessionId" | "timestamp">;

type StoreRememberOptions = RememberOptions & {
	memoryId?: string;
	memory_id?: string;
	validUntil?: string | null;
	valid_until?: string | null;
	authorId?: string | null;
	author_id?: string | null;
	authorType?: string | null;
	author_type?: string | null;
	extractEntities?: boolean;
	extract_entities?: boolean;
	extract_text?: string;
	embed_text?: string;
	channelId?: string | null;
	channel_id?: string | null;
};

type StoreRememberBatchOptions = RememberBatchOptions & {
	forceVeracity?: boolean;
	force_veracity?: boolean;
};

const TRUST_TIERS: Record<string, true> = {
	STATED: true,
	DERIVED: true,
	EXTERNAL_WRITE: true,
	IMPORTED: true,
};
// Read through `../../config`, the one owner of MNEMOPI_SP_MAX. It falls back to 1000
// rather than seeding a NaN cap that corrupts the pruning bound and its SQLite LIMIT bind.
const SCRATCHPAD_MAX_ITEMS = scratchpadMaxItems();

function metadataJson(metadata: Metadata | null | undefined): string | null {
	return metadata == null ? null : JSON.stringify(metadata);
}

function jsonObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? (value as Record<string, unknown>) : {};
}

function isSqlBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		value instanceof ArrayBuffer ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}

function sqlBinding(value: unknown, fallback: SQLQueryBindings): SQLQueryBindings {
	return isSqlBinding(value) ? value : fallback;
}

function embeddingText(content: string, options: { embedText?: string; embed_text?: string }): string {
	return options.embedText ?? options.embed_text ?? content;
}

function storedEmbeddingText(content: string, embedText: string): string | null {
	return embedText === content ? null : embedText;
}

function sourceToTrustTier(source: string | null | undefined): TrustTier {
	switch ((source ?? "").toLowerCase()) {
		case "conversation":
		case "user":
		case "assistant":
			return "STATED";
		case "tool":
		case "api":
		case "system":
			return "EXTERNAL_WRITE";
		case "import":
		case "imported":
		case "backup":
			return "IMPORTED";
		default:
			return "STATED";
	}
}

function normalizeTrustTier(value: unknown, source: string): TrustTier {
	if (value === null || value === undefined) return sourceToTrustTier(source);
	if (typeof value === "string" && TRUST_TIERS[value] === true) return value;
	return "STATED";
}

function emitEvent(beam: BeamMemoryState, type: string, data: EventPayload): void {
	const event: BeamEvent = {
		...data,
		type,
		sessionId: beam.sessionId,
		timestamp: toUtcIso(),
	};
	const candidate = beam as BeamMemoryState & {
		emitEvent?: (type: string, data: EventPayload) => void;
	};
	if (typeof candidate.emitEvent === "function") {
		candidate.emitEvent(type, data);
		return;
	}
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

function invalidateCaches(beam: BeamMemoryState): void {
	const cache = beam.caches as {
		queryCache?: { invalidate?: () => void };
		_queryCache?: { invalidate?: () => void };
	};
	cache.queryCache?.invalidate?.();
	cache._queryCache?.invalidate?.();
}

function findDuplicate(beam: BeamMemoryState, content: string): string | null {
	const row = beam.db
		.prepare("SELECT id FROM working_memory WHERE content = ? AND session_id = ? LIMIT 1")
		.get(content, beam.sessionId) as { id: string } | null;
	return row?.id ?? null;
}

function trimWorkingMemory(beam: BeamMemoryState): void {
	const limit = beam.config.workingMemoryLimit;
	if (!Number.isFinite(limit) || limit <= 0) return;
	const ttlHours = beam.config.workingMemoryTtlHours;
	const cutoff = toUtcIso(new Date(Date.now() - ttlHours * HOUR_MS));
	beam.db
		.prepare(`
			DELETE FROM working_memory
			WHERE session_id = ?
			  AND consolidated_at IS NULL
			  AND (
				timestamp < ? OR
				id NOT IN (
					SELECT id FROM working_memory
					WHERE session_id = ? AND consolidated_at IS NULL
					ORDER BY timestamp DESC
					LIMIT ?
				)
			  )
		`)
		.run(beam.sessionId, cutoff, beam.sessionId, limit);
}

function addTemporalAnnotations(beam: BeamMemoryState, memoryId: string, timestamp: string, source: string): void {
	try {
		beam.annotations?.add?.(memoryId, "occurred_on", timestamp.slice(0, 10));
		if (source && source !== "conversation" && source !== "user" && source !== "assistant") {
			beam.annotations?.add?.(memoryId, "has_source", source);
		}
	} catch (error) {
		// Non-blocking (matches Python's path), but dropped annotations degrade
		// temporal recall — surface it.
		logger.warn("mnemopi: temporal annotation enrichment failed for stored memory", {
			memoryId,
			error: errorMessage(error),
		});
	}
}

function proactiveLinkingAllowed(beam: BeamMemoryState): boolean {
	const override = process.env.MNEMOPI_PROACTIVE_LINKING;
	return override === undefined ? beam.config.proactiveLinking === true : override === "1";
}

function proactiveLinkIfEnabled(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	extractEntities: boolean,
): void {
	if (!proactiveLinkingAllowed(beam)) return;
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(content, memoryId, {
			sessionId: beam.sessionId,
			linkExisting: true,
			extractEntities,
		});
	} catch (error) {
		// Must never block durable memory storage, but a silently missing graph
		// link is invisible recall loss — surface it.
		logger.warn("mnemopi: proactive graph linking failed; memory stored without episodic links", {
			memoryId,
			error: errorMessage(error),
		});
	}
}

/**
 * Run the LLM fact extractor over freshly stored content and persist the
 * resulting facts. Best-effort: failures (no LLM, closed DB, malformed output)
 * are swallowed so they can never disrupt the synchronous `remember` that
 * scheduled them.
 */
async function runFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): Promise<void> {
	try {
		const extracted = await extractFactCategoriesSafe(content);
		if (countExtractedFactCategories(extracted) === 0) return;
		storeExtractedFactCategories(beam, extracted, 0, memoryId);
		invalidateCaches(beam);
	} catch (error) {
		// Never disrupts the `remember` that scheduled it, but a failed
		// extraction means facts silently never became searchable — surface it.
		logger.warn("mnemopi: background fact extraction failed; no facts stored for memory", {
			memoryId,
			error: errorMessage(error),
		});
	}
}

/**
 * Schedule background fact extraction for a stored memory. `remember` is
 * synchronous, so the async extractor is fired-and-forgotten; the promise is
 * tracked on `beam.pendingExtractions` so callers can drain it via
 * `flushExtractions()` (tests, graceful shutdown). The active runtime options
 * (host LLM `complete`, model, prompt overrides) are captured here and
 * re-entered inside the task because the AsyncLocalStorage scope set by
 * `Mnemopi.#withRuntimeOptions` has already exited by the time the task runs.
 */
function scheduleFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): void {
	if (content.trim() === "") return;
	const runtimeOptions = getMnemopiRuntimeOptions();
	const task = withMnemopiRuntimeOptions(runtimeOptions, () => runFactExtraction(beam, memoryId, content));
	const pending = beam.pendingExtractions;
	if (pending !== undefined) {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
}

function rowToDict(row: Row): Row {
	return { ...row };
}

/** Re-embedding batch size for a model-change rebuild — bounds each background
 *  embedding request instead of embedding the whole corpus in one call. */
const EMBED_REBUILD_BATCH = 128;

/**
 * Reconcile stored embeddings against the active embedding model at store open.
 *
 * Every `memory_embeddings` row is stamped with the model that produced it (see
 * `runEmbedding` in `helpers.ts`). When the configured embedding model changes,
 * its vector dimension changes too, so the previously-stored vectors are no
 * longer comparable. On a mismatch we wipe every stored vector — the
 * `memory_embeddings` table, the `episodic_memory.binary_vector` column, and the
 * sqlite-vec `vec_episodes` index — then enqueue all live memories for
 * background re-embedding under the new model via `scheduleEmbedding`.
 *
 * Runs once per store open; a fresh store (no embeddings) or an already-current
 * store is a no-op. The destructive wipe is skipped whenever it could not be
 * rebuilt — embeddings disabled via the runtime option OR the
 * `MNEMOPI_NO_EMBEDDINGS` env, or an unresolved (empty) active model — so a
 * stale-but-valid corpus is never destroyed without a replacement. MUST run
 * inside the active runtime-options scope so `currentEmbeddingModel()` /
 * `embeddingsDisabled()` reflect the per-instance configuration.
 */
export function reconcileEmbeddingModel(beam: BeamMemoryState): void {
	if (embeddingsDisabled()) return;
	const active = currentEmbeddingModel().trim();
	if (active === "") return;

	// Re-embed in bounded batches so a corpus-wide rebuild never issues one giant
	// embedding request; each batch is its own tracked background task.
	const rebuild = (items: readonly EmbedItem[]): void => {
		for (const batch of batched(items, EMBED_REBUILD_BATCH)) {
			scheduleEmbedding(beam, batch);
		}
	};

	// Stop at the first row whose stamped model differs from the active one
	// (NULL/unstamped counts as a mismatch via `IS NOT`).
	const mismatch = beam.db.query("SELECT 1 FROM memory_embeddings WHERE model IS NOT ? LIMIT 1").get(active);
	if (mismatch) {
		const staleModels = beam.db
			.query("SELECT DISTINCT model FROM memory_embeddings WHERE model IS NOT ?")
			.all(active) as { model: string | null }[];
		const live = beam.db
			.query(`
				SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory WHERE superseded_by IS NULL
				UNION ALL
				SELECT id AS memoryId, content FROM episodic_memory WHERE superseded_by IS NULL
			`)
			.all() as EmbedItem[];

		transaction(beam.db, () => {
			beam.db.prepare("DELETE FROM memory_embeddings").run();
			beam.db.prepare("UPDATE episodic_memory SET binary_vector = NULL").run();
			if (vecAvailable(beam.db)) {
				try {
					beam.db.prepare("DELETE FROM vec_episodes").run();
				} catch {
					// sqlite-vec cleanup is best-effort; rebuild correctness takes precedence.
				}
			}
		});

		logger.info("mnemopi: embedding model changed, rebuilding", {
			from: staleModels.map(row => row.model ?? "(unstamped)"),
			to: active,
			count: live.length,
		});
		rebuild(live);
		return;
	}

	// No stale embeddings, but a previously-interrupted rebuild (a failed embed or a process
	// exit after the wipe) can leave live memories with no active-model embedding. Treating an
	// empty/partial table as "reconciled" would strand them FTS-only, so re-enqueue any live
	// row still missing an active-model embedding.
	const missing = beam.db
		.query(`
			SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
			UNION ALL
			SELECT id AS memoryId, content FROM episodic_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
		`)
		.all(active, active) as EmbedItem[];
	if (missing.length === 0) return;
	logger.info("mnemopi: resuming interrupted embedding rebuild", { to: active, count: missing.length });
	rebuild(missing);
}

type Authorship = { authorId: string | null; authorType: string | null; channelId: string };

/** The author, author type and channel `options` sets, each defaulting to the beam's own. */
function rememberAuthorship(beam: BeamMemoryState, options: StoreRememberOptions): Authorship {
	return {
		authorId: options.authorId ?? options.author_id ?? beam.authorId,
		authorType: options.authorType ?? options.author_type ?? beam.authorType,
		channelId: options.channelId ?? options.channel_id ?? beam.channelId,
	};
}

interface RememberedFields extends Authorship {
	source: string;
	importance: number;
	timestamp: string;
	scope: string;
	veracity: Veracity;
	trustTier: TrustTier;
	memoryType: string;
	validUntil: string | null;
	metadata: Metadata | null;
	embedText: string;
}

function rememberedFields(beam: BeamMemoryState, content: string, options: StoreRememberOptions): RememberedFields {
	const source = options.source ?? "conversation";
	return {
		source,
		importance: options.importance ?? 0.5,
		timestamp: options.timestamp ?? toUtcIso(),
		scope: options.scope ?? "session",
		veracity: clampVeracity(options.veracity, "remember"),
		trustTier: normalizeTrustTier(options.trustTier, source),
		memoryType: options.memoryType ?? "unknown",
		validUntil: options.validUntil ?? options.valid_until ?? null,
		metadata: options.metadata ?? null,
		embedText: embeddingText(content, options),
		...rememberAuthorship(beam, options),
	};
}

/** Fold a repeat of stored memory `memoryId` into it: raise its importance and take the newer fields. */
function refreshDuplicateMemory(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	fields: RememberedFields,
): void {
	beam.db
		.prepare(`
			UPDATE working_memory
			SET importance = MAX(importance, ?), timestamp = ?, source = ?,
				valid_until = COALESCE(?, valid_until),
				scope = COALESCE(?, scope),
				author_id = COALESCE(?, author_id),
				author_type = COALESCE(?, author_type),
				channel_id = COALESCE(?, channel_id),
				memory_type = COALESCE(?, memory_type),
				veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END,
				trust_tier = COALESCE(?, trust_tier),
				embed_text = COALESCE(?, embed_text),
				consolidated_at = NULL
			WHERE id = ? AND session_id = ?
		`)
		.run(
			fields.importance,
			fields.timestamp,
			fields.source,
			fields.validUntil,
			fields.scope,
			fields.authorId,
			fields.authorType,
			fields.channelId,
			fields.memoryType,
			fields.veracity,
			fields.veracity,
			fields.trustTier,
			storedEmbeddingText(content, fields.embedText),
			memoryId,
			beam.sessionId,
		);
	emitEvent(beam, "MEMORY_UPDATED", {
		memoryId,
		content,
		source: fields.source,
		importance: fields.importance,
		metadata: fields.metadata ?? undefined,
	});
	if (fields.embedText !== content) scheduleEmbedding(beam, [{ memoryId, content: fields.embedText }]);
}

function insertRememberedMemory(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	fields: RememberedFields,
): void {
	beam.db
		.prepare(`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, valid_until, scope,
			 author_id, author_type, channel_id, veracity, memory_type, trust_tier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			memoryId,
			content,
			storedEmbeddingText(content, fields.embedText),
			fields.source,
			fields.timestamp,
			beam.sessionId,
			fields.importance,
			metadataJson(fields.metadata),
			fields.validUntil,
			fields.scope,
			fields.authorId,
			fields.authorType,
			fields.channelId,
			fields.veracity,
			fields.memoryType,
			fields.trustTier,
		);
}

export function remember(beam: BeamMemoryState, content: string, options: StoreRememberOptions = {}): string {
	const fields = rememberedFields(beam, content, options);
	const existingId = findDuplicate(beam, content);
	if (existingId !== null) {
		refreshDuplicateMemory(beam, existingId, content, fields);
		invalidateCaches(beam);
		return existingId;
	}

	const memoryId = options.memoryId ?? options.memory_id ?? generateId(content, new Date(fields.timestamp));
	insertRememberedMemory(beam, memoryId, content, fields);
	addTemporalAnnotations(beam, memoryId, fields.timestamp, fields.source);
	// `extractText` lets a caller decouple "what gets stored" from "what facts are
	// mined". coding-agent retains full multi-author transcripts but wants
	// fact/entity heuristics to read only the user-authored turns (issue #3372).
	const extractionSource = options.extractText ?? options.extract_text ?? content;
	proactiveLinkIfEnabled(
		beam,
		memoryId,
		extractionSource,
		Boolean(options.extractEntities ?? options.extract_entities),
	);
	trimWorkingMemory(beam);
	emitEvent(beam, "MEMORY_ADDED", {
		memoryId,
		content,
		source: fields.source,
		importance: fields.importance,
		metadata: fields.metadata ?? undefined,
	});
	scheduleEmbedding(beam, [{ memoryId, content: fields.embedText }]);
	if (options.extract === true) scheduleFactExtraction(beam, memoryId, extractionSource);
	invalidateCaches(beam);
	return memoryId;
}

/** What a batch applies to an item that leaves a field unset. */
interface BatchDefaults {
	timestamp: string;
	forceVeracity: boolean;
	veracity: Veracity;
	scope: string;
	memoryType: string;
	trustTier: TrustTier;
}

/** Store one batch item through `statement`, annotate it and announce it. Returns its memory id. */
function insertBatchItem(
	beam: BeamMemoryState,
	statement: Statement,
	item: RememberBatchItem,
	defaults: BatchDefaults,
): string {
	const timestamp = item.timestamp ?? defaults.timestamp;
	const memoryId = generateId(item.content, new Date(timestamp));
	const source = item.source ?? "conversation";
	const storeItem = item as StoreRememberOptions;
	const authorship = rememberAuthorship(beam, storeItem);
	const importance = item.importance ?? 0.5;
	statement.run(
		memoryId,
		item.content,
		storedEmbeddingText(item.content, embeddingText(item.content, storeItem)),
		source,
		timestamp,
		beam.sessionId,
		importance,
		metadataJson(item.metadata ?? null),
		authorship.authorId,
		authorship.authorType,
		authorship.channelId,
		item.memoryType ?? defaults.memoryType,
		defaults.forceVeracity || item.veracity === undefined
			? defaults.veracity
			: clampVeracity(item.veracity, "rememberBatch"),
		defaults.trustTier,
		item.scope ?? defaults.scope,
	);
	addTemporalAnnotations(beam, memoryId, timestamp, source);
	emitEvent(beam, "MEMORY_ADDED", {
		memoryId,
		content: item.content,
		source,
		importance,
		metadata: item.metadata ?? undefined,
	});
	return memoryId;
}

export function rememberBatch(
	beam: BeamMemoryState,
	items: readonly RememberBatchItem[],
	options: StoreRememberBatchOptions = {},
): string[] {
	const defaults: BatchDefaults = {
		timestamp: toUtcIso(),
		forceVeracity: options.forceVeracity ?? options.force_veracity ?? false,
		veracity: clampVeracity(options.veracity, "remember"),
		scope: options.scope ?? "session",
		memoryType: options.memoryType ?? "unknown",
		trustTier: normalizeTrustTier(options.trustTier ?? "IMPORTED", "imported"),
	};
	const stored = transaction(beam.db, () => {
		const statement = beam.db.prepare(`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json,
			 author_id, author_type, channel_id, memory_type, veracity, trust_tier, scope)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const rows = items.map(item => ({ item, memoryId: insertBatchItem(beam, statement, item, defaults) }));
		trimWorkingMemory(beam);
		return rows;
	});
	invalidateCaches(beam);
	scheduleEmbedding(
		beam,
		stored.map(({ item, memoryId }) => ({
			memoryId,
			content: embeddingText(item.content, item as StoreRememberOptions),
		})),
	);
	for (const { item, memoryId } of stored) {
		if (item.extract === true || options.extract === true) scheduleFactExtraction(beam, memoryId, item.content);
	}
	return stored.map(({ memoryId }) => memoryId);
}

export function getContext(beam: BeamMemoryState, limit = 10): Row[] {
	const now = toUtcIso();
	return (
		beam.db
			.prepare(`
				SELECT id, content, source, timestamp, importance, scope
				FROM working_memory
				WHERE (session_id = ? OR scope = 'global')
				  AND (valid_until IS NULL OR valid_until > ?)
				  AND superseded_by IS NULL
				ORDER BY
					CASE WHEN scope = 'global' THEN 0 ELSE 1 END,
					importance DESC,
					timestamp DESC
				LIMIT ?
			`)
			.all(beam.sessionId, now, limit) as Row[]
	).map(rowToDict);
}

export function invalidate(beam: BeamMemoryState, memoryId: string, replacementId: string | null = null): boolean {
	const now = toUtcIso();
	const working = beam.db
		.prepare(`
			UPDATE working_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.run(now, replacementId, memoryId, beam.sessionId);
	if (working.changes > 0) return true;
	const episodic = beam.db
		.prepare(`
			UPDATE episodic_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.run(now, replacementId, memoryId, beam.sessionId);
	return episodic.changes > 0;
}

export function getWorkingStats(
	beam: BeamMemoryState,
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): BeamStats {
	return getMemoryTableStats(beam.db, "working_memory", authorId, authorType, channelId);
}
export function getGlobalWorkingStats(beam: BeamMemoryState): BeamStats {
	return getWorkingStats(beam);
}

export function updateWorking(
	beam: BeamMemoryState,
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
): boolean {
	const assignments: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (content !== null) {
		assignments.push("content = ?", "embed_text = NULL");
		params.push(content);
	}
	if (importance !== null) {
		assignments.push("importance = ?");
		params.push(importance);
	}
	if (assignments.length === 0) return false;
	params.push(memoryId, beam.sessionId);
	const result = beam.db
		.prepare(`UPDATE working_memory SET ${assignments.join(", ")} WHERE id = ? AND session_id = ?`)
		.run(...params);
	if (result.changes > 0) {
		invalidateCaches(beam);
		if (content !== null) scheduleEmbedding(beam, [{ memoryId, content }]);
	}
	return result.changes > 0;
}

export function get(beam: BeamMemoryState, memoryId: string): Row | null {
	const working = beam.db
		.prepare(`
			SELECT id, content, source, timestamp, session_id,
				   importance, metadata_json, veracity, created_at
			FROM working_memory
			WHERE id = ?
		`)
		.get(memoryId) as Row | null | undefined;
	if (working != null) return { ...working, metadata: working.metadata_json, memory_store: "working" };

	const episodic = beam.db
		.prepare(`
			SELECT id, content, source, timestamp, session_id,
				   importance, metadata_json, veracity, created_at
			FROM episodic_memory
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.get(memoryId, beam.sessionId) as Row | null | undefined;
	if (episodic != null) return { ...episodic, metadata: episodic.metadata_json, memory_store: "episodic" };

	return getFact(beam, memoryId);
}

/**
 * Read-only resolution for ids minted from the `facts` table. `recall`
 * surfaces `facts.fact_id` as a result id (`factRecall`), so `get` must
 * resolve those ids too — otherwise every surfaced fact id is a dead end
 * for the read path (issue #4725). Visibility mirrors `factRecall`:
 * same-session facts plus explicitly global ones (`scope` is an optional
 * column on `facts`; `SELECT *` tolerates banks without it, in which case
 * only same-session facts resolve). The row is shaped like the
 * working/episodic hits with the full triple as content;
 * `memory_store: "fact"` marks it read-only — no update/forget/invalidate
 * path mutates `facts`.
 */
function getFact(beam: BeamMemoryState, memoryId: string): Row | null {
	const fact = beam.db.prepare("SELECT * FROM facts WHERE fact_id = ?").get(memoryId) as Row | null | undefined;
	if (fact == null) return null;
	if (fact.session_id !== beam.sessionId && fact.scope !== "global") return null;
	const subject = typeof fact.subject === "string" ? fact.subject : "";
	const predicate = typeof fact.predicate === "string" ? fact.predicate : "";
	const object = typeof fact.object === "string" ? fact.object : "";
	return {
		id: fact.fact_id,
		content: [subject, predicate, object].filter(part => part.length > 0).join(" "),
		source: "facts",
		timestamp: fact.timestamp ?? null,
		session_id: fact.session_id ?? null,
		importance: fact.confidence ?? null,
		metadata: JSON.stringify({
			subject,
			predicate,
			object,
			source_msg_id: fact.source_msg_id ?? null,
		}),
		created_at: fact.created_at ?? null,
		memory_store: "fact",
	};
}

export function forgetWorking(beam: BeamMemoryState, memoryId: string): boolean {
	let deleted = 0;
	transaction(beam.db, () => {
		const result = beam.db
			.prepare("DELETE FROM working_memory WHERE id = ? AND session_id = ?")
			.run(memoryId, beam.sessionId);
		deleted = result.changes;
		if (deleted > 0) {
			beam.db.prepare("DELETE FROM annotations WHERE memory_id = ?").run(memoryId);
		}
	});
	if (deleted > 0) invalidateCaches(beam);
	return deleted > 0;
}

export function scratchpadWrite(beam: BeamMemoryState, content: string): string {
	const padId = generateId(content);
	const timestamp = toUtcIso();
	beam.db
		.prepare(`
			INSERT INTO scratchpad (id, content, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
		`)
		.run(padId, content, beam.sessionId, timestamp, timestamp);
	return padId;
}

export function scratchpadRead(beam: BeamMemoryState): Row[] {
	return (
		beam.db
			.prepare(`
				SELECT id, content, created_at, updated_at
				FROM scratchpad
				WHERE session_id = ?
				ORDER BY updated_at DESC
				LIMIT ?
			`)
			.all(beam.sessionId, Number.isFinite(SCRATCHPAD_MAX_ITEMS) ? SCRATCHPAD_MAX_ITEMS : 1000) as Row[]
	).map(rowToDict);
}

export function scratchpadClear(beam: BeamMemoryState): void {
	beam.db.prepare("DELETE FROM scratchpad WHERE session_id = ?").run(beam.sessionId);
}

const EXPORT_BASE_COLUMNS =
	"id, content, source, timestamp, session_id, importance, metadata_json, valid_until, superseded_by, scope, recall_count, last_recalled, created_at, veracity, memory_type, author_id, author_type, channel_id, trust_tier, event_date, event_date_precision, temporal_tags";

export function exportToDict(beam: BeamMemoryState): Record<string, unknown> {
	const db = beam.db;
	return {
		mnemopi_export: {
			version: "1.0",
			export_date: toUtcIso(),
			source_db: beam.dbPath ?? ":memory:",
			component: "beam",
		},
		working_memory: db
			.prepare(
				`SELECT ${EXPORT_BASE_COLUMNS.replace("metadata_json,", "embed_text, metadata_json,")}, consolidated_at FROM working_memory ORDER BY session_id, timestamp`,
			)
			.all(),
		episodic_memory: db
			.prepare(
				`SELECT rowid, ${EXPORT_BASE_COLUMNS.replace("metadata_json,", "metadata_json, summary_of,")} FROM episodic_memory ORDER BY session_id, timestamp`,
			)
			.all(),
		episodic_embeddings: [],
		scratchpad: db
			.prepare(
				"SELECT id, content, session_id, created_at, updated_at FROM scratchpad ORDER BY session_id, updated_at",
			)
			.all(),
		consolidation_log: db
			.prepare(
				"SELECT id, session_id, items_consolidated, summary_preview, created_at FROM consolidation_log ORDER BY session_id, created_at",
			)
			.all(),
	};
}

/**
 * Columns an import writes to both memory tables after `id`, each with the value bound when the exported
 * row holds no SQLite-bindable value for it. `veracity` is clamped to the vocabulary instead.
 */
const MEMORY_IMPORT_COLUMNS: Readonly<Record<string, SQLQueryBindings>> = {
	content: "",
	source: null,
	timestamp: null,
	session_id: "default",
	importance: 0.5,
	metadata_json: "{}",
	valid_until: null,
	superseded_by: null,
	scope: "session",
	recall_count: 0,
	last_recalled: null,
	created_at: null,
	veracity: "unknown",
	memory_type: "unknown",
	author_id: null,
	author_type: null,
	channel_id: null,
	trust_tier: "STATED",
	event_date: null,
	event_date_precision: "unknown",
	temporal_tags: "[]",
};
const WORKING_IMPORT_COLUMNS = { ...MEMORY_IMPORT_COLUMNS, consolidated_at: null, embed_text: null };
const EPISODIC_IMPORT_COLUMNS = { ...MEMORY_IMPORT_COLUMNS, summary_of: "" };

type UpsertTally = { inserted: number; skipped: number; overwritten: number };

function importedItems(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(jsonObject) : [];
}

function importInsertSql(table: string, columns: Readonly<Record<string, SQLQueryBindings>>): string {
	const names = ["id", ...Object.keys(columns)];
	return `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
}

/** The values `importInsertSql` binds for one exported row, in its column order. */
function importedRow(
	id: string,
	item: Record<string, unknown>,
	columns: Readonly<Record<string, SQLQueryBindings>>,
): SQLQueryBindings[] {
	const values: SQLQueryBindings[] = [id];
	for (const [column, fallback] of Object.entries(columns)) {
		values.push(
			column === "veracity" ? clampVeracity(item.veracity, "rememberBatch") : sqlBinding(item[column], fallback),
		);
	}
	return values;
}

/**
 * Count an exported row as skipped, overwritten or inserted. Returns false when a stored row holds its id
 * and `force` is off, so the stored row stays.
 */
function claimImportedRow(exists: boolean, force: boolean, tally: UpsertTally): boolean {
	if (exists && !force) {
		tally.skipped++;
		return false;
	}
	if (exists) tally.overwritten++;
	else tally.inserted++;
	return true;
}

function importWorkingMemory(db: Database, rows: unknown, force: boolean, tally: UpsertTally): void {
	const check = db.prepare("SELECT 1 FROM working_memory WHERE id = ?");
	const remove = db.prepare("DELETE FROM working_memory WHERE id = ?");
	const insert = db.prepare(importInsertSql("working_memory", WORKING_IMPORT_COLUMNS));
	for (const item of importedItems(rows)) {
		const id = String(item.id ?? "");
		if (id.length === 0) continue;
		const exists = check.get(id) !== null;
		if (!claimImportedRow(exists, force, tally)) continue;
		if (exists) remove.run(id);
		insert.run(...importedRow(id, item, WORKING_IMPORT_COLUMNS));
	}
}

/** Import episodic rows, mapping each exported rowid to the rowid its row was stored under. */
function importEpisodicMemory(db: Database, rows: unknown, force: boolean, tally: UpsertTally): Map<number, number> {
	const oldToNewRowid = new Map<number, number>();
	const getRowid = db.prepare("SELECT rowid FROM episodic_memory WHERE id = ?");
	const remove = db.prepare("DELETE FROM episodic_memory WHERE id = ?");
	const removeVec = vecAvailable(db) ? db.prepare("DELETE FROM vec_episodes WHERE rowid = ?") : null;
	const insert = db.prepare(importInsertSql("episodic_memory", EPISODIC_IMPORT_COLUMNS));
	for (const item of importedItems(rows)) {
		const id = String(item.id ?? "");
		if (id.length === 0) continue;
		const existing = getRowid.get(id) as { rowid: number } | null;
		if (!claimImportedRow(existing !== null, force, tally)) continue;
		if (existing !== null) {
			try {
				removeVec?.run(existing.rowid);
			} catch {
				// sqlite-vec cleanup is best-effort; import correctness takes precedence.
			}
			remove.run(id);
		}
		insert.run(...importedRow(id, item, EPISODIC_IMPORT_COLUMNS));
		const oldRowid = Number(item.rowid);
		const stored = getRowid.get(id) as { rowid: number } | null;
		if (Number.isFinite(oldRowid) && stored !== null) oldToNewRowid.set(oldRowid, stored.rowid);
	}
	return oldToNewRowid;
}

/** Insert each embedding whose exported rowid maps to an imported episode. Returns how many were inserted. */
function importEpisodicEmbeddings(db: Database, rows: unknown, oldToNewRowid: Map<number, number>): number {
	if (!vecAvailable(db)) return 0;
	let inserted = 0;
	for (const item of importedItems(rows)) {
		const mappedRowid = oldToNewRowid.get(Number(item.rowid));
		const embedding = Array.isArray(item.embedding) ? item.embedding.map(value => Number(value)) : null;
		if (mappedRowid === undefined || embedding === null || embedding.some(v => !Number.isFinite(v))) continue;
		try {
			vecInsert(db, mappedRowid, embedding);
			inserted++;
		} catch {
			// Embedding import is best-effort when sqlite-vec is unavailable or degraded.
		}
	}
	return inserted;
}

function importScratchpad(db: Database, rows: unknown, tally: ImportStats["scratchpad"]): void {
	const check = db.prepare("SELECT 1 FROM scratchpad WHERE id = ?");
	const update = db.prepare(
		"UPDATE scratchpad SET content = ?, session_id = ?, created_at = ?, updated_at = ? WHERE id = ?",
	);
	const insert = db.prepare(
		"INSERT INTO scratchpad (content, session_id, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?)",
	);
	for (const item of importedItems(rows)) {
		const id = String(item.id ?? "");
		if (id.length === 0) continue;
		const exists = check.get(id) !== null;
		(exists ? update : insert).run(
			sqlBinding(item.content, ""),
			sqlBinding(item.session_id, "default"),
			sqlBinding(item.created_at, null),
			sqlBinding(item.updated_at, null),
			id,
		);
		tally[exists ? "updated" : "inserted"]++;
	}
}

function importConsolidationLog(db: Database, rows: unknown): number {
	const insert = db.prepare(
		"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
	);
	const items = importedItems(rows);
	for (const item of items) {
		insert.run(
			sqlBinding(item.session_id, "default"),
			sqlBinding(item.items_consolidated, 0),
			sqlBinding(item.summary_preview, ""),
			sqlBinding(item.created_at, null),
		);
	}
	return items.length;
}

export function importFromDict(beam: BeamMemoryState, data: Record<string, unknown>, force = false): ImportStats {
	const stats = {
		working_memory: { inserted: 0, skipped: 0, overwritten: 0 },
		episodic_memory: { inserted: 0, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
		scratchpad: { inserted: 0, updated: 0 },
		consolidation_log: { inserted: 0 },
	} satisfies ImportStats;
	const db: Database = beam.db;

	transaction(db, () => {
		importWorkingMemory(db, data.working_memory, force, stats.working_memory);
		const oldToNewRowid = importEpisodicMemory(db, data.episodic_memory, force, stats.episodic_memory);
		stats.episodic_memory.embeddings_inserted = importEpisodicEmbeddings(db, data.episodic_embeddings, oldToNewRowid);
		importScratchpad(db, data.scratchpad, stats.scratchpad);
		stats.consolidation_log.inserted = importConsolidationLog(db, data.consolidation_log);
	});
	invalidateCaches(beam);
	return stats;
}
