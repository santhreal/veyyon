import type { Database } from "bun:sqlite";

export const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export function tableExists(db: Database, table: string): boolean {
	return (
		db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1").get(table) !== null
	);
}

export function sqlPlaceholders(count: number): string {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(`sqlPlaceholders: count must be a non-negative integer, got ${count}`);
	}
	return Array.from({ length: count }, () => "?").join(", ");
}

export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}
