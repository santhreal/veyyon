import type { Database } from "bun:sqlite";

/**
 * True when a queryable object named `table` exists in the database, whether it
 * is a regular table, a virtual table (FTS5/vec register in `sqlite_master`
 * with `type = 'table'`), or a view. Index and trigger names are not counted,
 * since they cannot be queried as a table.
 *
 * Query errors propagate on purpose: a failing `sqlite_master` read means a
 * broken or closed handle, and reporting that as "table missing" would silently
 * disable whole features (a scan path skipped, a rebuild never run).
 */
export function tableExists(db: Database, table: string): boolean {
	return (
		db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1").get(table) !== null
	);
}
