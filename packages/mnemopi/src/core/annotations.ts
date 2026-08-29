import type { Database } from "bun:sqlite";

import { dbPath } from "../config";
import { closeQuietly, openDatabase, transaction } from "../db";
import type {
	AnnotationImportStats,
	AnnotationInput,
	AnnotationRow,
	AnnotationStoreOptions,
	SqlValue,
	StoredAnnotationContent,
	WritableStatement,
} from "./annotations-helpers";

import {
	filterCleanMentions,
	initAnnotationsWithConn,
	insertAnnotation,
	isSqliteConstraint,
	normalizeRow,
	rowId,
	sameContent,
} from "./annotations-helpers";

export { ANNOTATION_KINDS, filterFacts, initAnnotations } from "./annotations-helpers";
export { filterCleanMentions };

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

	add(memoryId: string, kind: string, value: string, source = "", confidence = 1.0): number {
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence) VALUES (?, ?, ?, ?, ?)",
			)
			.run(memoryId, kind, value, source, confidence);
		return Number(result.lastInsertRowid);
	}

	addMany(
		memoryId: string,
		kind: string,
		values: readonly string[] | null | undefined,
		source = "",
		confidence = 1.0,
	): number {
		if (!values || values.length === 0) return 0;
		const rows = values.filter(value => value.length > 0 && value.trim().length > 0);
		if (rows.length === 0) return 0;
		const insert = this.db.prepare(
			"INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence) VALUES (?, ?, ?, ?, ?)",
		);
		transaction(this.db, () => {
			for (const value of rows) insert.run(memoryId, kind, value, source, confidence);
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
		options: {
			readonly value?: string | null;
			readonly memory_id?: string | null;
			readonly memoryId?: string | null;
			readonly filter_noise?: boolean;
			readonly filterNoise?: boolean;
		} = {},
	): AnnotationRow[] {
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
		const stats: AnnotationImportStats = {
			inserted: 0,
			skipped: 0,
			overwritten: 0,
			imported_renumbered: 0,
		};
		const seenIds = new Set<number>();
		for (const item of annotations) {
			const id = rowId(item.id);
			if (id === null) continue;
			if (seenIds.has(id)) {
				throw new Error(
					`import_all: duplicate id ${id} in the imported batch. Deduplicate the input before calling.`,
				);
			}
			seenIds.add(id);
		}

		transaction(this.db, () => {
			const existingRows = this.db
				.prepare("SELECT id, memory_id, kind, value, source, confidence, created_at FROM annotations")
				.all() as AnnotationRow[];
			const existing = new Map<number, StoredAnnotationContent>();
			for (const row of existingRows) existing.set(Number(row.id), normalizeRow(row));

			const insertWithId = this.db.prepare(
				"INSERT INTO annotations (id, memory_id, kind, value, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			) as WritableStatement;
			const insertWithoutId = this.db.prepare(
				"INSERT INTO annotations (memory_id, kind, value, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			) as WritableStatement;
			const deleteById = this.db.prepare("DELETE FROM annotations WHERE id = ?");

			for (const item of annotations) {
				const id = rowId(item.id);
				const current = id === null ? undefined : existing.get(id);
				if (id === null) {
					insertAnnotation(insertWithoutId, item);
					stats.inserted++;
					continue;
				}
				if (current === undefined) {
					insertAnnotation(insertWithId, item, id);
					stats.inserted++;
					continue;
				}
				if (force) {
					deleteById.run(id);
					insertAnnotation(insertWithId, item, id);
					stats.overwritten++;
					continue;
				}
				if (sameContent(item, current)) {
					stats.skipped++;
					continue;
				}
				try {
					insertAnnotation(insertWithoutId, item);
					stats.imported_renumbered++;
				} catch (error) {
					if (isSqliteConstraint(error)) stats.skipped++;
					else throw error;
				}
			}
		});
		return stats;
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
