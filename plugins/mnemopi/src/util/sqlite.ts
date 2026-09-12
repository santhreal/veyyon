import type { Database, SQLQueryBindings } from "bun:sqlite";

// tableExists is a generic sqlite helper with one home in the shared lib. It is
// re-exported here so mnemopi's own modules keep their existing import path.
// The previous local copy filtered on `type IN ('table','virtual table')`, but
// SQLite registers FTS5/vec virtual tables with `type = 'table'`, so the extra
// literal never matched; the shared owner uses the correct set.
export { escapeLike, sqlPlaceholders, tableExists } from "@veyyon/utils/sqlite";

/**
 * Batch size for building `... IN (?, ?, …)` clauses over a list of ids. SQLite
 * caps the number of bound parameters per statement (SQLITE_MAX_VARIABLE_NUMBER,
 * historically 999), so id lists are queried in batches well under that bound.
 * This is the ONE owner: `precomputedVectors` in both shmr.ts and beam/recall.ts
 * batch `memory_embeddings` lookups by this size.
 */
export const SQLITE_IN_CLAUSE_BATCH = 500;

export function isSqliteConstraint(error: unknown): boolean {
	return error instanceof Error && error.message.toLowerCase().includes("constraint");
}

/**
 * Reads a JSON string list stored in a text column. A null, empty, non-JSON or non-array value and
 * every non-string item yield nothing: a row with a damaged list reads as a row with none, and the
 * caller keeps the row rather than skipping it.
 */
export function parseStoredStringList(value: string | null): string[] {
	if (value === null || value === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const strings: string[] = [];
	for (const item of parsed) {
		if (typeof item === "string") strings.push(item);
	}
	return strings;
}

export interface EntityImportStats {
	inserted: number;
	skipped: number;
	overwritten: number;
	imported_renumbered: number;
}

export interface EntityImportAdapter<TItem, TExisting> {
	tableName: string;
	getId(item: TItem): number | null;
	fetchExisting(db: Database): Map<number, TExisting>;
	isSameContent(item: TItem, existing: TExisting): boolean;
	insertWithId(db: Database, item: TItem, id: number): void;
	insertWithoutId(db: Database, item: TItem): void;
}

export function importEntityBatch<TItem, TExisting>(
	db: Database,
	items: readonly TItem[],
	adapter: EntityImportAdapter<TItem, TExisting>,
	force = false,
): EntityImportStats {
	const stats: EntityImportStats = {
		inserted: 0,
		skipped: 0,
		overwritten: 0,
		imported_renumbered: 0,
	};
	const seenIds = new Set<number>();
	for (const item of items) {
		const id = adapter.getId(item);
		if (id === null) continue;
		if (seenIds.has(id)) {
			throw new Error(`import_all: duplicate id ${id} in the imported batch. Deduplicate the input before calling.`);
		}
		seenIds.add(id);
	}

	db.run("BEGIN IMMEDIATE");
	try {
		const existing = adapter.fetchExisting(db);
		for (const item of items) {
			const id = adapter.getId(item);
			const current = id === null ? undefined : existing.get(id);
			if (id === null) {
				adapter.insertWithoutId(db, item);
				stats.inserted++;
				continue;
			}
			if (current === undefined) {
				adapter.insertWithId(db, item, id);
				stats.inserted++;
				continue;
			}
			if (force) {
				db.run(`DELETE FROM ${adapter.tableName} WHERE id = ?`, [id]);
				adapter.insertWithId(db, item, id);
				stats.overwritten++;
				continue;
			}
			if (adapter.isSameContent(item, current)) {
				stats.skipped++;
				continue;
			}
			try {
				adapter.insertWithoutId(db, item);
				stats.imported_renumbered++;
			} catch (error) {
				if (isSqliteConstraint(error)) stats.skipped++;
				else throw error;
			}
		}
		db.run("COMMIT");
		return stats;
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}
export function getMemoryTableStats(
	db: Database,
	table: "working_memory" | "episodic_memory",
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): { count: number; total: number; last: string | null } {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (authorId) {
		clauses.push("author_id = ?");
		params.push(authorId);
	}
	if (authorType) {
		clauses.push("author_type = ?");
		params.push(authorType);
	}
	if (channelId) {
		clauses.push("channel_id = ?");
		params.push(channelId);
	}
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	const total = (db.query(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...params) as { count: number }).count;
	const last = db.query(`SELECT timestamp FROM ${table}${where} ORDER BY timestamp DESC LIMIT 1`).get(...params) as {
		timestamp: string | null;
	} | null;
	return { count: total, total, last: last?.timestamp ?? null };
}
