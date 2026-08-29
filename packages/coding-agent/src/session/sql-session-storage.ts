import { enoentError } from "@veyyon/utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import type { SessionTitleUpdate } from "./session-title-slot";
import type {
	ContentRow,
	DialectQueries,
	IndexRow,
	SliceRow,
	SqlSessionStorageAdapter,
	SqlSessionStorageClient,
	SqlSessionStorageOptions,
} from "./sql-session-storage-helpers";
import {
	buildQueries,
	DEFAULT_TABLE,
	decodeSqlBytes,
	detectAdapter,
	IDENT_RE,
	isDuplicateColumnError,
	rowNumber,
	rowTitleSource,
} from "./sql-session-storage-helpers";

export type { SqlSessionStorageClient };

export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;

	constructor(backend: SessionStorageBackend, adapter: SqlSessionStorageAdapter, table: string) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
	}

	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(backend, backend.adapter, backend.table);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(`SqlSessionStorage: table name must match ${IDENT_RE.source} (got ${JSON.stringify(table)})`);
		}
		this.#table = table;
		this.#q = buildQueries(this.#adapter, table);
		this.#createTable = options.createTable !== false;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	async init(): Promise<void> {
		if (this.#createTable) {
			await this.#client.unsafe(this.#q.createTable);
			for (const query of this.#q.addTitleColumns) {
				try {
					await this.#client.unsafe(query);
				} catch (err) {
					if (!isDuplicateColumnError(err)) throw err;
				}
			}
		}
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		return rows.map(row => ({
			path: row.path,
			size: rowNumber(row.byte_len),
			mtimeMs: rowNumber(row.mtime_ms),
			title: row.title ?? undefined,
			titleSource: rowTitleSource(row.title_source),
			titleUpdatedAt: row.title_updated_at ?? undefined,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		const rows = (await this.#client.unsafe(this.#q.readFull, [path])) as ContentRow[];
		const row = rows[0];
		return row ? row.content : null;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const values =
			this.#adapter === "postgres"
				? [prefixBytes, suffixBytes, path]
				: [prefixBytes, suffixBytes, suffixBytes, path];
		const rows = (await this.#client.unsafe(this.#q.readSlices, values)) as SliceRow[];
		const row = rows[0];
		if (!row) throw enoentError(path);
		return [decodeSqlBytes(row.head), decodeSqlBytes(row.tail)];
	}

	async writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate): Promise<void> {
		await this.#client.unsafe(this.#q.upsertReplace, [
			path,
			content,
			mtimeMs,
			title?.title ?? null,
			title?.source ?? null,
			title?.updatedAt ?? null,
		]);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.updateTitle, [
			title.title ?? null,
			title.source ?? null,
			title.updatedAt,
			mtimeMs,
			path,
		]);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.upsertAppend, [path, line, mtimeMs]);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) {
			await this.#client.unsafe(this.#q.delete, [path]);
		}
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.delete, [dst]);
		await this.#client.unsafe(this.#q.rename, [dst, mtimeMs, src]);
	}
}
