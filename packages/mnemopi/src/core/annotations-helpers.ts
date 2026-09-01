import type { Database } from "bun:sqlite";
import { dbPath } from "../config";
import { closeQuietly, openDatabase } from "../db";
import { ENTITY_STOPWORDS } from "./stopwords";

export const ANNOTATION_KIND_VALUES = ["mentions", "fact", "occurred_on", "has_source"] as const;

export type AnnotationKind = (typeof ANNOTATION_KIND_VALUES)[number] | (string & {});

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

export interface AnnotationImportStats {
	inserted: number;
	skipped: number;
	overwritten: number;
	imported_renumbered: number;
}

export interface AnnotationStoreOptions {
	readonly dbPath?: string;
	readonly db_path?: string;
	readonly db?: Database;
	readonly conn?: Database;
}

export interface StoredAnnotationContent {
	readonly memory_id: string;
	readonly kind: string;
	readonly value: string;
	readonly source: string | null;
	readonly confidence: number | null;
	readonly created_at: string | null;
}

export interface StatementRunResult {
	readonly changes: number;
	readonly lastInsertRowid: number | bigint;
}

export interface WritableStatement {
	run(...params: SqlValue[]): StatementRunResult;
}

export type SqlValue = string | number | bigint | null;

export function normalizeRow(row: AnnotationRow): AnnotationRow {
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

export function normalizeContent(item: AnnotationInput): StoredAnnotationContent {
	return {
		memory_id: item.memory_id,
		kind: item.kind,
		value: item.value,
		source: item.source ?? "imported",
		confidence: item.confidence ?? 1.0,
		created_at: item.created_at ?? null,
	};
}

export function rowId(value: number | bigint | null | undefined): number | null {
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

export function sameContent(item: AnnotationInput, existing: StoredAnnotationContent): boolean {
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

export function isSqliteConstraint(error: unknown): boolean {
	return error instanceof Error && /constraint/i.test(error.message);
}

export function insertAnnotation(statement: WritableStatement, item: AnnotationInput, id?: number): void {
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
