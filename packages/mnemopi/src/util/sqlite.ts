import type { Database } from "bun:sqlite";

/**
 * True when a table (regular or virtual, e.g. FTS/vec) exists. Query errors
 * propagate: a failing sqlite_master read means a broken/closed handle, and
 * masking that as "table missing" silently disables whole features.
 */
export function tableExists(db: Database, table: string): boolean {
	return (
		db
			.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1")
			.get(table) !== null
	);
}
