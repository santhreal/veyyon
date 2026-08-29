import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "@veyyon/utils";
import { hermesRoot } from "../config";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";

export interface TripleRow {
	id: number;
	subject: string;
	predicate: string;
	object: string;
	valid_from: string;
	valid_until: string | null;
	source: string | null;
	confidence: number | null;
	created_at: string | null;
}

export interface TripleWriteOptions {
	readonly validFrom?: string | null;
	readonly valid_from?: string | null;
	readonly source?: string | null;
	readonly confidence?: number | null;
}

export interface TripleQueryOptions {
	readonly subject?: string | null;
	readonly predicate?: string | null;
	readonly object?: string | null;
	readonly asOf?: string | null;
	readonly as_of?: string | null;
}

export interface TripleImportStats {
	inserted: number;
	skipped: number;
	overwritten: number;
	imported_renumbered: number;
}

export type TripleImportRow = Partial<Omit<TripleRow, "id">> & { readonly id?: number | null };

export const TRIPLE_COLUMNS = "id, subject, predicate, object, valid_from, valid_until, source, confidence, created_at";
export const CONTENT_FIELDS = [
	"subject",
	"predicate",
	"object",
	"valid_from",
	"valid_until",
	"source",
	"confidence",
	"created_at",
] as const;

export type ContentField = (typeof CONTENT_FIELDS)[number];
export type ContentSnapshot = Record<ContentField, string | number | null | undefined>;

export interface ImportBindingRow {
	readonly subject: string | null;
	readonly predicate: string | null;
	readonly object: string | null;
	readonly valid_from: string | null;
	readonly valid_until: string | null;
	readonly source: string;
	readonly confidence: number;
	readonly created_at: string | null;
}

export type ProcessEnv = Record<string, string | undefined>;
export type SerializableDatabase = Database & { serialize(): Uint8Array };

export function legacyDataDir(env: ProcessEnv = process.env): string {
	return join(hermesRoot(env), "mnemopi", "data");
}

export function defaultDataDir(env: ProcessEnv = process.env): string {
	return env.MNEMOPI_DATA_DIR && env.MNEMOPI_DATA_DIR.length > 0 ? env.MNEMOPI_DATA_DIR : legacyDataDir(env);
}

export function defaultTripleDbPath(env: ProcessEnv = process.env): string {
	return join(defaultDataDir(env), "triples.db");
}

export function legacyTripleDbPath(env: ProcessEnv = process.env): string {
	return join(legacyDataDir(env), "triples.db");
}

export function copyLegacyDb(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	let sourceDb: Database | null = null;
	try {
		sourceDb = openDatabase(source, { create: false, readwrite: false, pragmas: false });
		const serialized = (sourceDb as SerializableDatabase).serialize();
		if (!existsSync(destination)) atomicWriteFileSync(destination, serialized);
	} finally {
		closeQuietly(sourceDb);
	}
}

export function resolveDefaultTripleDb(env: ProcessEnv = process.env): string {
	const destination = defaultTripleDbPath(env);
	const legacy = legacyTripleDbPath(env);
	if (destination !== legacy && !existsSync(destination) && existsSync(legacy)) copyLegacyDb(legacy, destination);
	return destination;
}

export function initTriples(dbOrPath?: Database | DatabasePath | null): void {
	let db: Database;
	let owned = false;
	if (dbOrPath instanceof Database) {
		db = dbOrPath;
	} else {
		db = openDatabase(dbOrPath ?? resolveDefaultTripleDb());
		owned = true;
	}
	try {
		db.run(`
			CREATE TABLE IF NOT EXISTS triples (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				valid_until TEXT,
				source TEXT,
				confidence REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_valid_from ON triples(valid_from)");
	} finally {
		if (owned) closeQuietly(db);
	}
}

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function normalizeOptions(options?: TripleWriteOptions | string | null): Required<TripleWriteOptions> {
	if (typeof options === "string") {
		return { validFrom: options, valid_from: options, source: "inferred", confidence: 1.0 };
	}
	const validFrom = options?.validFrom ?? options?.valid_from ?? null;
	return {
		validFrom,
		valid_from: validFrom,
		source: options?.source ?? "inferred",
		confidence: options?.confidence ?? 1.0,
	};
}

export function rowToTriple(row: unknown): TripleRow {
	return row as TripleRow;
}

export function normalizeContent(item: TripleImportRow): ContentSnapshot {
	const bindings = normalizeImportBindings(item);
	return {
		subject: bindings.subject,
		predicate: bindings.predicate,
		object: bindings.object,
		valid_from: bindings.valid_from,
		valid_until: bindings.valid_until,
		source: bindings.source,
		confidence: bindings.confidence,
		created_at: bindings.created_at,
	};
}

export function requiredImportText(value: string | null | undefined): string | null {
	return value ?? null;
}

export function normalizeImportBindings(item: TripleImportRow): ImportBindingRow {
	return {
		subject: requiredImportText(item.subject),
		predicate: requiredImportText(item.predicate),
		object: requiredImportText(item.object),
		valid_from: requiredImportText(item.valid_from),
		valid_until: item.valid_until ?? null,
		source: item.source ?? "imported",
		confidence: item.confidence ?? 1.0,
		created_at: item.created_at ?? null,
	};
}

export function contentFromRow(row: TripleRow): ContentSnapshot {
	return {
		subject: row.subject,
		predicate: row.predicate,
		object: row.object,
		valid_from: row.valid_from,
		valid_until: row.valid_until,
		source: row.source,
		confidence: row.confidence,
		created_at: row.created_at,
	};
}

export function sameContent(left: ContentSnapshot, right: ContentSnapshot): boolean {
	for (const field of CONTENT_FIELDS) {
		if ((left[field] ?? null) !== (right[field] ?? null)) return false;
	}
	return true;
}
