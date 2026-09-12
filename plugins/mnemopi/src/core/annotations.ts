import type { Database } from "bun:sqlite";

import { dbPath } from "../config";
import { closeQuietly, openDatabase, transaction } from "../db";
import { type EntityImportStats, importEntityBatch } from "../util/sqlite";
import { ENTITY_STOPWORDS } from "./stopwords";

const ANNOTATION_KIND_VALUES = ["mentions", "fact", "occurred_on", "has_source"] as const;

export type AnnotationKind = (typeof ANNOTATION_KIND_VALUES)[number] | (string & {});

// Backed by the canonical entity/mention stopword set in stopwords.ts. This
// module formerly kept its own inline subset that was missing every function
// word; see stopwords.ts for the divergence it fixed.
export const ENTITY_STOP_WORDS: ReadonlySet<string> = ENTITY_STOPWORDS;
export const ANNOTATION_KINDS: ReadonlySet<string> = new Set(ANNOTATION_KIND_VALUES);
export const MIN_FACT_LENGTH = 10;

export interface AnnotationRow {
	readonly id: number;
	readonly memory_id: string;
	readonly kind: string;
	readonly value: string;
	readonly source: string | null;
	readonly confidence: number | null;
	readonly created_at: string | null;
}

export interface AnnotationInput {
	readonly id?: number | bigint | null;
	readonly memory_id: string;
	readonly kind: string;
	readonly value: string;
	readonly source?: string | null;
	readonly confidence?: number | null;
	readonly created_at?: string | null;
}

export type AnnotationImportStats = EntityImportStats;

export interface AnnotationStoreOptions {
	readonly dbPath?: string;
	readonly db_path?: string;
	readonly db?: Database;
	readonly conn?: Database;
}

interface StoredAnnotationContent {
	readonly memory_id: string;
	readonly kind: string;
	readonly value: string;
	readonly source: string | null;
	readonly confidence: number | null;
	readonly created_at: string | null;
}

interface StatementRunResult {
	readonly changes: number;
	readonly lastInsertRowid: number | bigint;
}

interface WritableStatement {
	run(...params: SqlValue[]): StatementRunResult;
}

type SqlValue = string | number | bigint | null;

function normalizeRow(row: AnnotationRow): AnnotationRow {
	return {
		id: Number(row.id),
		memory_id: row.memory_id,
		kind: row.kind,
		value: row.value,
		source: row.source,
		confidence: row.confidence === null ? null : Number(row.confidence),
		created_at: row.created_at,
	};
}

function normalizeContent(item: AnnotationInput): StoredAnnotationContent {
	return {
		memory_id: item.memory_id,
		kind: item.kind,
		value: item.value,
		source: item.source ?? "imported",
		confidence: item.confidence ?? 1.0,
		created_at: item.created_at ?? null,
	};
}

function rowId(value: number | bigint | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	return Number(value);
}

function isNoisyMention(value: string): boolean {
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length === 0) return false;
	for (const word of words) {
		if (ENTITY_STOP_WORDS.has(word.toLowerCase())) return true;
	}
	return false;
}

function sameContent(item: AnnotationInput, existing: StoredAnnotationContent): boolean {
	const normalized = normalizeContent(item);
	return (
		normalized.memory_id === existing.memory_id &&
		normalized.kind === existing.kind &&
		normalized.value === existing.value &&
		normalized.source === existing.source &&
		normalized.confidence === existing.confidence &&
		normalized.created_at === existing.created_at
	);
}

function insertAnnotation(statement: WritableStatement, item: AnnotationInput, id?: number): void {
	if (id === undefined) {
		statement.run(
			item.memory_id,
			item.kind,
			item.value,
			item.source ?? "imported",
			item.confidence ?? 1.0,
			item.created_at ?? null,
		);
		return;
	}
	statement.run(
		id,
		item.memory_id,
		item.kind,
		item.value,
		item.source ?? "imported",
		item.confidence ?? 1.0,
		item.created_at ?? null,
	);
}

export function filterCleanMentions<T extends { readonly value?: string | null }>(rows: readonly T[]): T[] {
	return rows.filter(row => !isNoisyMention(row.value ?? ""));
}
export function filterFacts(facts: readonly string[] | null | undefined): string[] {
	if (!facts) return [];
	return facts.filter(fact => fact.length > MIN_FACT_LENGTH);
}
export function initAnnotations(path: string = dbPath()): void {
	const db = openDatabase(path);
	try {
		initAnnotationsWithConn(db);
	} finally {
		closeQuietly(db);
	}
}
export function initAnnotationsWithConn(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS annotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_annot_memory_kind ON annotations(memory_id, kind)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_annot_kind_value ON annotations(kind, value)");
	db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)");
}
export class AnnotationStore {
	readonly dbPath: string;
	readonly db: Database;
	readonly conn: Database;
	readonly #ownsConnection: boolean;

	constructor(options: AnnotationStoreOptions | string = {}) {
		if (typeof options === "string") {
			this.dbPath = options;
			this.db = openDatabase(options);
			this.#ownsConnection = true;
		} else {
			const shared = options.conn ?? options.db;
			this.dbPath = options.dbPath ?? options.db_path ?? dbPath();
			this.db = shared ?? openDatabase(this.dbPath);
			this.#ownsConnection = shared === undefined;
		}
		this.conn = this.db;
		initAnnotationsWithConn(this.db);
	}

	close(): void {
		if (this.#ownsConnection) closeQuietly(this.db);
	}

	add(
		memoryId: string,
		kind: string,
		value: string,
		sourceOrOptions: string | { source?: string; confidence?: number } = "",
		confidence = 1.0,
	): number {
		const source = typeof sourceOrOptions === "object" ? (sourceOrOptions.source ?? "") : sourceOrOptions;
		const conf = typeof sourceOrOptions === "object" ? (sourceOrOptions.confidence ?? 1.0) : confidence;
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence) VALUES (?, ?, ?, ?, ?)",
			)
			.run(memoryId, kind, value, source, conf);
		return Number(result.lastInsertRowid);
	}

	addMany(
		memoryId: string,
		kind: string,
		values: readonly string[] | null | undefined,
		sourceOrOptions: string | { source?: string; confidence?: number } = "",
		confidence = 1.0,
	): number {
		if (!values || values.length === 0) return 0;
		const rows = values.filter(value => value.length > 0 && value.trim().length > 0);
		if (rows.length === 0) return 0;
		const source = typeof sourceOrOptions === "object" ? (sourceOrOptions.source ?? "") : sourceOrOptions;
		const conf = typeof sourceOrOptions === "object" ? (sourceOrOptions.confidence ?? 1.0) : confidence;
		const insert = this.db.prepare(
			"INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence) VALUES (?, ?, ?, ?, ?)",
		);
		transaction(this.db, () => {
			for (const value of rows) insert.run(memoryId, kind, value, source, conf);
		});
		return rows.length;
	}
	queryByMemory(memoryId: string, kind?: string | null): AnnotationRow[] {
		const sql =
			kind === null || kind === undefined
				? "SELECT * FROM annotations WHERE memory_id = ? ORDER BY created_at ASC, id ASC"
				: "SELECT * FROM annotations WHERE memory_id = ? AND kind = ? ORDER BY created_at ASC, id ASC";
		const rows =
			kind === null || kind === undefined
				? this.db.prepare(sql).all(memoryId)
				: this.db.prepare(sql).all(memoryId, kind);
		return (rows as AnnotationRow[]).map(normalizeRow);
	}
	queryByKind(
		kind: string,
		valueOrOptions:
			| string
			| {
					readonly value?: string | null;
					readonly memory_id?: string | null;
					readonly memoryId?: string | null;
					readonly filter_noise?: boolean;
					readonly filterNoise?: boolean;
			  } = {},
	): AnnotationRow[] {
		const options = typeof valueOrOptions === "string" ? { value: valueOrOptions } : valueOrOptions;
		const conditions = ["kind = ?"];
		const params: SqlValue[] = [kind];
		if (options.value !== null && options.value !== undefined) {
			conditions.push("value = ?");
			params.push(options.value);
		}
		const memoryId = options.memory_id ?? options.memoryId;
		if (memoryId !== null && memoryId !== undefined) {
			conditions.push("memory_id = ?");
			params.push(memoryId);
		}
		const rows = this.db
			.prepare(`SELECT * FROM annotations WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC`)
			.all(...params) as AnnotationRow[];
		const normalized = rows.map(normalizeRow);
		const filterNoise = options.filter_noise ?? options.filterNoise ?? true;
		return filterNoise && kind === "mentions" ? filterCleanMentions(normalized) : normalized;
	}
	getDistinctValues(kind: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT value FROM annotations WHERE kind = ? ORDER BY value")
			.all(kind) as { value: string }[];
		return rows.map(row => row.value);
	}
	exportAll(): AnnotationRow[] {
		const rows = this.db
			.prepare("SELECT id, memory_id, kind, value, source, confidence, created_at FROM annotations ORDER BY id")
			.all() as AnnotationRow[];
		return rows.map(normalizeRow);
	}
	importAll(annotations: readonly AnnotationInput[], force = false): AnnotationImportStats {
		const insertWithId = this.db.prepare(
			"INSERT INTO annotations (id, memory_id, kind, value, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		) as WritableStatement;
		const insertWithoutId = this.db.prepare(
			"INSERT INTO annotations (memory_id, kind, value, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		) as WritableStatement;

		return importEntityBatch(
			this.db,
			annotations,
			{
				tableName: "annotations",
				getId: item => rowId(item.id),
				fetchExisting: db => {
					const existingRows = db
						.prepare("SELECT id, memory_id, kind, value, source, confidence, created_at FROM annotations")
						.all() as AnnotationRow[];
					const existing = new Map<number, StoredAnnotationContent>();
					for (const row of existingRows) existing.set(Number(row.id), normalizeRow(row));
					return existing;
				},
				isSameContent: (item, existing) => sameContent(item, existing),
				insertWithId: (_db, item, id) => insertAnnotation(insertWithId, item, id),
				insertWithoutId: (_db, item) => insertAnnotation(insertWithoutId, item),
			},
			force,
		);
	}
}

export function addAnnotation(
	memoryId: string,
	kind: string,
	value: string,
	source = "",
	confidence = 1.0,
	path?: string,
): number {
	const store = new AnnotationStore(path === undefined ? {} : path);
	try {
		return store.add(memoryId, kind, value, source, confidence);
	} finally {
		store.close();
	}
}
export interface QueryAnnotationsOptions {
	readonly memory_id?: string | null;
	readonly memoryId?: string | null;
	readonly kind?: string | null;
	readonly value?: string | null;
	readonly db_path?: string | null;
	readonly dbPath?: string | null;
}

export function queryAnnotations(options?: QueryAnnotationsOptions): AnnotationRow[];
export function queryAnnotations(
	memoryId?: string | null,
	kind?: string | null,
	value?: string | null,
	dbPath?: string | null,
): AnnotationRow[];
export function queryAnnotations(
	first: QueryAnnotationsOptions | string | null = {},
	kindArg?: string | null,
	valueArg?: string | null,
	dbPathArg?: string | null,
): AnnotationRow[] {
	const options: QueryAnnotationsOptions =
		typeof first === "object" && first !== null
			? first
			: { memory_id: first, kind: kindArg, value: valueArg, db_path: dbPathArg };
	const memoryId = options.memory_id ?? options.memoryId;
	const kind = options.kind;
	const value = options.value;
	const path = options.db_path ?? options.dbPath ?? undefined;
	const store = new AnnotationStore(path === undefined || path === null ? {} : path);
	try {
		if (memoryId !== null && memoryId !== undefined && kind === undefined && value === undefined) {
			return store.queryByMemory(memoryId);
		}
		if (memoryId !== null && memoryId !== undefined && kind !== null && kind !== undefined && value === undefined) {
			return store.queryByMemory(memoryId, kind);
		}
		if (kind !== null && kind !== undefined) return store.queryByKind(kind, { value, memory_id: memoryId });
		return store.exportAll();
	} finally {
		store.close();
	}
}
