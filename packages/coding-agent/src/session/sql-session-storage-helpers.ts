import type { SessionTitleUpdate } from "./session-title-slot";

export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

export interface SqlSessionStorageClient {
	unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
}

export interface SqlSessionStorageOptions {
	client: SqlSessionStorageClient;
	adapter?: SqlSessionStorageAdapter;
	table?: string;
	createTable?: boolean;
}

export interface DialectQueries {
	createTable: string;
	addTitleColumns: readonly string[];
	upsertReplace: string;
	upsertAppend: string;
	updateTitle: string;
	delete: string;
	rename: string;
	loadIndex: string;
	readFull: string;
	readSlices: string;
}

export interface IndexRow {
	path: string;
	byte_len: number | bigint | string;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

export interface ContentRow {
	content: string;
}

export interface SliceRow {
	head: unknown;
	tail: unknown;
}

export const DEFAULT_TABLE = "veyyon_session_files";
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const utf8Decoder = new TextDecoder("utf-8");

export function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

export function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";

	if (adapter === "mysql") {
		return {
			createTable:
				`CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL` +
				`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			addTitleColumns: [
				`ALTER TABLE ${table} ADD COLUMN title TEXT NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_source VARCHAR(16) NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_updated_at VARCHAR(64) NULL`,
			],
			upsertReplace:
				`INSERT INTO ${table} (path, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = VALUES(content), mtime_ms = VALUES(mtime_ms), title = VALUES(title), title_source = VALUES(title_source), title_updated_at = VALUES(title_updated_at)`,
			upsertAppend:
				`INSERT INTO ${table} (path, content, mtime_ms) VALUES (?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = CONCAT(content, VALUES(content)), mtime_ms = VALUES(mtime_ms)`,
			updateTitle: `UPDATE ${table} SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ? WHERE path = ?`,
			delete: `DELETE FROM ${table} WHERE path = ?`,
			rename: `UPDATE ${table} SET path = ?, mtime_ms = ? WHERE path = ?`,
			loadIndex: `SELECT path, mtime_ms, length(content) AS byte_len, title, title_source, title_updated_at FROM ${table}`,
			readFull: `SELECT content AS content FROM ${table} WHERE path = ?`,
			readSlices:
				`SELECT substring(cast(content AS binary), 1, ?) AS head, ` +
				`CASE WHEN ? <= 0 THEN cast('' AS binary) ` +
				`ELSE substring(cast(content AS binary), greatest(1, length(content) - ? + 1)) END AS tail ` +
				`FROM ${table} WHERE path = ?`,
		};
	}

	const mtimeType = adapter === "postgres" ? "BIGINT" : "INTEGER";
	const tableQualifier = `${table}.content`;
	const byteLengthExpr = adapter === "postgres" ? "octet_length(content)" : "length(cast(content AS blob))";
	const readSlices =
		adapter === "postgres"
			? `SELECT substring(convert_to(content, 'UTF8') from 1 for ${placeholder(1)}) AS head, ` +
				`CASE WHEN ${placeholder(2)} <= 0 THEN ''::bytea ` +
				`ELSE substring(convert_to(content, 'UTF8') from greatest(1, octet_length(content) - ${placeholder(2)} + 1)) END AS tail ` +
				`FROM ${table} WHERE path = ${placeholder(3)}`
			: `SELECT substr(cast(content AS blob), 1, ?) AS head, ` +
				`CASE WHEN ? <= 0 THEN x'' ELSE substr(cast(content AS blob), -?) END AS tail ` +
				`FROM ${table} WHERE path = ?`;

	return {
		createTable:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`path TEXT PRIMARY KEY, ` +
			`content TEXT NOT NULL, ` +
			`mtime_ms ${mtimeType} NOT NULL, ` +
			`title TEXT, ` +
			`title_source TEXT, ` +
			`title_updated_at TEXT` +
			`)`,
		addTitleColumns: [
			`ALTER TABLE ${table} ADD COLUMN title TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_source TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_updated_at TEXT`,
		],
		upsertReplace:
			`INSERT INTO ${table} (path, content, mtime_ms, title, title_source, title_updated_at) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}, ${placeholder(4)}, ${placeholder(5)}, ${placeholder(6)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, title = excluded.title, title_source = excluded.title_source, title_updated_at = excluded.title_updated_at`,
		upsertAppend:
			`INSERT INTO ${table} (path, content, mtime_ms) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = ${tableQualifier} || excluded.content, mtime_ms = excluded.mtime_ms`,
		updateTitle: `UPDATE ${table} SET title = ${placeholder(1)}, title_source = ${placeholder(2)}, title_updated_at = ${placeholder(3)}, mtime_ms = ${placeholder(4)} WHERE path = ${placeholder(5)}`,
		delete: `DELETE FROM ${table} WHERE path = ${placeholder(1)}`,
		rename: `UPDATE ${table} SET path = ${placeholder(1)}, mtime_ms = ${placeholder(2)} WHERE path = ${placeholder(3)}`,
		loadIndex: `SELECT path, mtime_ms, ${byteLengthExpr} AS byte_len, title, title_source, title_updated_at FROM ${table}`,
		readFull: `SELECT content AS content FROM ${table} WHERE path = ${placeholder(1)}`,
		readSlices,
	};
}

export function rowNumber(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
export function rowTitleSource(value: string | null | undefined): SessionTitleUpdate["source"] | undefined {
	return value === "auto" || value === "user" ? value : undefined;
}
export function isDuplicateColumnError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("duplicate column") || message.includes("already exists");
}

export function decodeSqlBytes(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return utf8Decoder.decode(value);
	if (value instanceof ArrayBuffer) return utf8Decoder.decode(new Uint8Array(value));
	return String(value);
}
