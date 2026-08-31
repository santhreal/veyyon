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
/**
 * SQLite expression for the current time as whole seconds since the Unix epoch, for use inside a SQL string.
 *
 * Not a bound parameter: it evaluates in the database, so an `INSERT ... DEFAULT` and an `UPDATE ... SET`
 * in the same statement agree on one timestamp and no clock is read in JavaScript.
 *
 * SECONDS, not milliseconds, and that is the whole reason this has one home. Three modules across two
 * packages each carried their own copy of this exact string and each writes a column another module reads:
 * `auth_credentials.updated_at`, `model_perf.updated_at`, the history tables. A copy edited to `'%s'` in
 * milliseconds, or to `strftime('%J')`, would put values a thousand times out of range into one table while
 * the readers kept interpreting them as seconds, and nothing would throw. Everything comparing those
 * columns, expiry checks and ranking windows included, would quietly be wrong.
 */
export const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export function tableExists(db: Database, table: string): boolean {
	return (
		db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1").get(table) !== null
	);
}

/**
 * A comma-separated run of `count` bound-parameter placeholders (`?, ?, …`) for
 * a SQL `IN (…)` clause or multi-row insert, so an id list can be bound safely
 * instead of interpolated. Pair it with `.all(...ids)` / `.run(...ids)`.
 *
 * Returns `""` for a count of 0. `IN ()` is not valid SQL, so the caller must
 * guard an empty list before using the result; this helper does not, because a
 * zero-length batch is a normal early-return case at the call site, not an
 * error. A negative or non-integer count is a programming error and throws.
 */
export function sqlPlaceholders(count: number): string {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(`sqlPlaceholders: count must be a non-negative integer, got ${count}`);
	}
	return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Escape the SQL `LIKE` wildcards in `value` so user input matches as literal
 * text instead of as a pattern. Backslash, `%` (any run) and `_` (any single
 * character) are each prefixed with a backslash.
 *
 * The result is only correct when the statement declares the same escape
 * character, so the `LIKE` clause must read `... LIKE ? ESCAPE '\'`. The caller
 * still wraps the escaped value in its own `%…%` for a substring match; those
 * surrounding wildcards are meant to stay active.
 */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}
