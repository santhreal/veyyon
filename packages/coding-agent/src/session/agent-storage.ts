import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSqliteBusyError } from "@veyyon/ai/auth-credential-rows";
import type { AuthCredential, AuthCredentialStore, StoredAuthCredential } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { AsyncDrain } from "@veyyon/utils/async";
import { getAgentDbPath, getStatsDbPath } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { SQLITE_NOW_EPOCH } from "@veyyon/utils/sqlite";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import type { RawSettings as Settings } from "../config/settings";
import type {
	ModelPerfInsert,
	ModelPerfRow,
	ModelPerfSample,
	ModelPerfStats,
	ModelUsageRow,
	PerfAccum,
	SettingsRow,
	StatsMessageRow,
} from "./agent-storage-helpers";
import {
	MODEL_PERF_BACKFILL_CHUNK,
	MODEL_PERF_BACKFILL_KEY,
	MODEL_PERF_BACKFILL_MAX_AGE_MS,
	MODEL_PERF_BACKFILL_MAX_ROWS,
	MODEL_PERF_DECAY_AT,
	MODEL_PERF_FLUSH_DELAY_MS,
	normalizeModelPerfSample,
	SCHEMA_VERSION,
} from "./agent-storage-helpers";

export type { ModelPerfStats };
export { SCHEMA_VERSION };

const instances = new Map<string, AgentStorage>();
export class AgentStorage {
	#db: Database;
	#authStore: AuthCredentialStore;

	#listSettingsStmt: Statement;
	#upsertModelUsageStmt: Statement;
	#listModelUsageStmt: Statement;
	#upsertModelPerfStmt: Statement;
	#listModelPerfStmt: Statement;
	#modelUsageCache: string[] | null = null;
	#autoPerfBackfill: boolean;
	#perfBackfillChecked = false;
	#perfDrain = new AsyncDrain<ModelPerfInsert>(MODEL_PERF_FLUSH_DELAY_MS);

	private constructor(dbPath: string) {
		this.#autoPerfBackfill = dbPath === getAgentDbPath();
		this.#ensureDir(dbPath);
		try {
			this.#db = new Database(dbPath);
		} catch (err) {
			const dir = path.dirname(dbPath);
			const dirExists = fs.existsSync(dir);
			const errMsg = errorMessage(err);
			throw new Error(
				`Failed to open agent database at '${dbPath}': ${errMsg}\n` +
					`Directory '${dir}' exists: ${dirExists}\n` +
					`Ensure the directory is writable and not corrupted.`,
			);
		}

		this.#initializeSchema();
		this.#hardenPermissions(dbPath);

		this.#authStore = new SqliteAuthCredentialStore(this.#db);

		this.#listSettingsStmt = this.#db.prepare("SELECT key, value FROM settings");
		this.#upsertModelUsageStmt = this.#db.prepare(
			`INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ${SQLITE_NOW_EPOCH}) ON CONFLICT(model_key) DO UPDATE SET last_used_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listModelUsageStmt = this.#db.prepare(
			"SELECT model_key, last_used_at FROM model_usage ORDER BY last_used_at DESC",
		);
		this.#upsertModelPerfStmt = this.#db.prepare(
			`INSERT INTO model_perf (model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at)
VALUES (?1, 1, ?2, ?3, ?4, ?5, ${SQLITE_NOW_EPOCH})
ON CONFLICT(model_key) DO UPDATE SET
	samples = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.samples / 2 ELSE model_perf.samples END) + 1,
	output_tokens = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.output_tokens * 0.5 ELSE model_perf.output_tokens END) + excluded.output_tokens,
	gen_ms = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.gen_ms * 0.5 ELSE model_perf.gen_ms END) + excluded.gen_ms,
	ttft_samples = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.ttft_samples * 0.5 ELSE model_perf.ttft_samples END) + excluded.ttft_samples,
	ttft_ms = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.ttft_ms * 0.5 ELSE model_perf.ttft_ms END) + excluded.ttft_ms,
	updated_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listModelPerfStmt = this.#db.prepare(
			"SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms FROM model_perf",
		);
	}

	#initializeSchema(): void {
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS model_perf (
	model_key TEXT PRIMARY KEY,
	samples REAL NOT NULL DEFAULT 0,
	output_tokens REAL NOT NULL DEFAULT 0,
	gen_ms REAL NOT NULL DEFAULT 0,
	ttft_samples REAL NOT NULL DEFAULT 0,
	ttft_ms REAL NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
`);

		const settingsInfo = this.#db.prepare("PRAGMA table_info(settings)").all() as Array<{ name?: string }>;
		const hasSettingsTable = settingsInfo.length > 0;
		const hasKey = settingsInfo.some(column => column.name === "key");
		const hasValue = settingsInfo.some(column => column.name === "value");

		if (!hasSettingsTable) {
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
		} else if (!hasKey || !hasValue) {
			let legacySettings: Record<string, unknown> | null = null;
			const row = this.#db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data?: string } | undefined;
			if (row?.data) {
				try {
					const parsed = JSON.parse(row.data);
					if (isRecord(parsed)) {
						legacySettings = parsed;
					} else {
						logger.warn("AgentStorage legacy settings invalid shape");
					}
				} catch (error) {
					logger.warn("AgentStorage failed to parse legacy settings", { error: String(error) });
				}
			}

			const migrate = this.#db.transaction((settings: Record<string, unknown> | null) => {
				this.#db.run("DROP TABLE settings");
				this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
				if (settings) {
					const insert = this.#db.prepare(
						`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${SQLITE_NOW_EPOCH})`,
					);
					for (const [key, value] of Object.entries(settings)) {
						if (value === undefined) continue;
						const serialized = JSON.stringify(value);
						if (serialized === undefined) continue;
						insert.run(key, serialized);
					}
				}
			});

			migrate(legacySettings);
		}

		const versionRow = this.#db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		const schemaVersion = typeof versionRow?.version === "number" ? versionRow.version : 0;
		if (versionRow?.version !== undefined && versionRow.version !== SCHEMA_VERSION) {
			logger.warn("AgentStorage schema version mismatch", {
				current: versionRow.version,
				expected: SCHEMA_VERSION,
			});
		}
		if (schemaVersion < SCHEMA_VERSION) {
			this.#migrateSchema(schemaVersion);
		}
		this.#db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
	}

	#migrateSchema(fromVersion: number): void {
		if (fromVersion < 4) {
		}
		if (fromVersion < 5) {
			this.#migrateSchemaV4ToV5();
		}
		if (fromVersion < 6) {
			this.#db.run("DELETE FROM model_perf");
			this.#db.prepare("DELETE FROM meta WHERE key = ?").run(MODEL_PERF_BACKFILL_KEY);
		}
	}

	#migrateSchemaV4ToV5(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE settings RENAME TO settings_legacy");
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO settings (key, value, updated_at)
SELECT key, value, updated_at
FROM settings_legacy
`);
			this.#db.run("DROP TABLE settings_legacy");

			this.#db.run("ALTER TABLE model_usage RENAME TO model_usage_legacy");
			this.#db.run(`
CREATE TABLE model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO model_usage (model_key, last_used_at)
SELECT model_key, last_used_at
FROM model_usage_legacy
`);
			this.#db.run("DROP TABLE model_usage_legacy");
		});
		migrate();
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<AgentStorage> {
		const existing = instances.get(dbPath);
		if (existing) return existing;

		const maxRetries = 4;
		const baseDelayMs = 100;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const storage = new AgentStorage(dbPath);
				instances.set(dbPath, storage);
				return storage;
			} catch (err) {
				if (!isSqliteBusyError(err)) {
					throw err;
				}
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxRetries - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}

		throw new Error(
			`Failed to open agent database at '${dbPath}' after ${maxRetries} attempts: ${lastError?.message}`,
			{ cause: lastError },
		);
	}
	static resetInstance(): void {
		for (const storage of instances.values()) storage.#close();
		instances.clear();
	}

	#close(): void {
		this.#listSettingsStmt.finalize();
		this.#upsertModelUsageStmt.finalize();
		this.#listModelUsageStmt.finalize();
		this.#upsertModelPerfStmt.finalize();
		this.#listModelPerfStmt.finalize();
		this.#authStore.close();
	}

	getSettings(): Settings | null {
		const rows = (this.#listSettingsStmt.all() as SettingsRow[]) ?? [];
		if (rows.length === 0) return null;
		const settings: Record<string, unknown> = {};
		for (const row of rows) {
			try {
				settings[row.key] = JSON.parse(row.value) as unknown;
			} catch (error) {
				logger.warn("AgentStorage failed to parse setting", {
					key: row.key,
					error: String(error),
				});
			}
		}
		return settings as Settings;
	}

	recordModelUsage(modelKey: string): void {
		try {
			this.#upsertModelUsageStmt.run(modelKey);
			this.#modelUsageCache = null;
		} catch (error) {
			logger.warn("AgentStorage failed to record model usage", { modelKey, error: String(error) });
		}
	}

	getModelUsageOrder(): string[] {
		if (this.#modelUsageCache) {
			return this.#modelUsageCache;
		}
		try {
			const rows = this.#listModelUsageStmt.all() as ModelUsageRow[];
			this.#modelUsageCache = rows.map(row => row.model_key);
			return this.#modelUsageCache;
		} catch (error) {
			logger.warn("AgentStorage failed to get model usage order", { error: String(error) });
			return [];
		}
	}

	recordModelPerf(modelKey: string, sample: ModelPerfSample): Promise<void> {
		const row = normalizeModelPerfSample(modelKey, sample);
		if (!row) return Promise.resolve();
		return this.#perfDrain.push(row, rows => this.#flushModelPerf(rows));
	}

	#flushModelPerf(rows: ModelPerfInsert[]): void {
		this.#kickModelPerfBackfill();
		try {
			this.#db.transaction((batch: ModelPerfInsert[]) => {
				for (const row of batch) this.#foldModelPerf(row);
			})(rows);
		} catch (error) {
			logger.warn("AgentStorage failed to record model perf", { error: String(error) });
		}
	}

	#foldModelPerf(row: ModelPerfInsert): void {
		this.#upsertModelPerfStmt.run(row.modelKey, row.outputTokens, row.durationMs, row.ttftSamples, row.ttftMs);
	}

	getModelPerf(): Map<string, ModelPerfStats> {
		this.#kickModelPerfBackfill();
		const stats = new Map<string, ModelPerfStats>();
		try {
			for (const row of this.#listModelPerfStmt.all() as ModelPerfRow[]) {
				if (row.gen_ms <= 0 || row.output_tokens <= 0) continue;
				stats.set(row.model_key, {
					samples: row.samples,
					tps: (row.output_tokens * 1000) / row.gen_ms,
					ttftMs: row.ttft_samples > 0 ? row.ttft_ms / row.ttft_samples : null,
				});
			}
		} catch (error) {
			logger.warn("AgentStorage failed to read model perf", { error: String(error) });
		}
		return stats;
	}

	#kickModelPerfBackfill(): void {
		if (!this.#autoPerfBackfill || this.#perfBackfillChecked) return;
		this.#perfBackfillChecked = true;
		try {
			const marker = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(MODEL_PERF_BACKFILL_KEY);
			if (marker) return;
			const statsDbPath = getStatsDbPath();
			if (!fs.existsSync(statsDbPath)) return;
			void this.backfillModelPerfFromStats(statsDbPath)
				.then(imported => {
					this.#db
						.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
						.run(MODEL_PERF_BACKFILL_KEY, "complete");
					logger.info("AgentStorage imported model perf history from stats.db", { imported });
				})
				.catch(error => {
					logger.warn("AgentStorage model perf backfill failed", { error: String(error) });
				});
		} catch (error) {
			logger.warn("AgentStorage model perf backfill failed", { error: String(error) });
		}
	}

	async backfillModelPerfFromStats(statsDbPath: string): Promise<number> {
		let statsDb: Database;
		let select: Statement;
		try {
			statsDb = new Database(statsDbPath, { readonly: true });
			statsDb.run("PRAGMA busy_timeout = 5000");
			select = statsDb.prepare(
				`SELECT rowid, timestamp, provider, model, output_tokens, duration, ttft
FROM messages
WHERE (timestamp < ?1 OR (timestamp = ?1 AND rowid < ?2))
	AND timestamp >= ?3
	AND duration > 0 AND output_tokens > 0 AND stop_reason != 'error'
ORDER BY timestamp DESC, rowid DESC
LIMIT ?4`,
			);
		} catch (error) {
			throw new Error(
				`Cannot read the stats database at ${statsDbPath}: ${errorMessage(error)}. ` +
					`It holds usage history only and is rebuilt by \`veyyon stats\`, so deleting the file is safe and clears this.`,
				{ cause: error },
			);
		}
		try {
			const cutoff = Date.now() - MODEL_PERF_BACKFILL_MAX_AGE_MS;
			const sums = new Map<string, PerfAccum>();
			let cursorTimestamp = Number.MAX_SAFE_INTEGER;
			let cursorRowid = Number.MAX_SAFE_INTEGER;
			let scanned = 0;
			let imported = 0;
			while (scanned < MODEL_PERF_BACKFILL_MAX_ROWS) {
				const chunk = Math.min(MODEL_PERF_BACKFILL_CHUNK, MODEL_PERF_BACKFILL_MAX_ROWS - scanned);
				const rows = select.all(cursorTimestamp, cursorRowid, cutoff, chunk) as StatsMessageRow[];
				if (rows.length === 0) break;
				scanned += rows.length;
				const last = rows[rows.length - 1];
				cursorTimestamp = last.timestamp;
				cursorRowid = last.rowid;
				for (const row of rows) {
					const key = `${row.provider}/${row.model}`;
					let accum = sums.get(key);
					if (accum && accum.samples >= MODEL_PERF_DECAY_AT) continue;
					const normalized = normalizeModelPerfSample(key, {
						outputTokens: row.output_tokens,
						durationMs: row.duration,
						ttftMs: row.ttft ?? undefined,
					});
					if (!normalized) continue;
					if (!accum) {
						accum = { samples: 0, outputTokens: 0, genMs: 0, ttftSamples: 0, ttftMs: 0 };
						sums.set(key, accum);
					}
					accum.samples += 1;
					accum.outputTokens += normalized.outputTokens;
					accum.genMs += normalized.durationMs;
					accum.ttftSamples += normalized.ttftSamples;
					accum.ttftMs += normalized.ttftMs;
					imported++;
				}
				if (rows.length < chunk) break;
				await Bun.sleep(0);
			}
			if (sums.size > 0) {
				const upsert = this.#db.prepare(
					`INSERT INTO model_perf (model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${SQLITE_NOW_EPOCH})
ON CONFLICT(model_key) DO UPDATE SET
	samples = model_perf.samples + excluded.samples,
	output_tokens = model_perf.output_tokens + excluded.output_tokens,
	gen_ms = model_perf.gen_ms + excluded.gen_ms,
	ttft_samples = model_perf.ttft_samples + excluded.ttft_samples,
	ttft_ms = model_perf.ttft_ms + excluded.ttft_ms,
	updated_at = ${SQLITE_NOW_EPOCH}`,
				);
				this.#db.transaction(() => {
					for (const [key, accum] of sums) {
						upsert.run(key, accum.samples, accum.outputTokens, accum.genMs, accum.ttftSamples, accum.ttftMs);
					}
				})();
			}
			return imported;
		} finally {
			statsDb.close();
		}
	}

	hasAuthCredentials(): boolean {
		return this.#authStore.listAuthCredentials().length > 0;
	}

	get authStore(): AuthCredentialStore {
		return this.#authStore;
	}

	listAuthCredentials(provider?: string, includeDisabled = false): StoredAuthCredential[] {
		const credentials = this.#authStore.listAuthCredentials(provider);
		if (!includeDisabled) return credentials;

		const stmt = this.#db.prepare(
			provider
				? "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC"
				: "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials ORDER BY id ASC",
		);
		const rows = (provider ? stmt.all(provider) : stmt.all()) as Array<{
			id: number;
			provider: string;
			credential_type: string;
			data: string;
			disabled_cause: string | null;
		}>;

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch (error) {
				this.#reportUnreadableCredential(
					row.id,
					row.provider,
					`stored data is not valid JSON: ${errorMessage(error)}`,
				);
				continue;
			}
			if (!isRecord(parsed)) {
				this.#reportUnreadableCredential(row.id, row.provider, "stored data is not an object");
				continue;
			}

			let credential: AuthCredential;
			if (row.credential_type === "api_key") {
				if (typeof parsed.key !== "string") {
					this.#reportUnreadableCredential(row.id, row.provider, "api_key credential has no string key");
					continue;
				}
				credential = { type: "api_key", key: parsed.key };
			} else if (row.credential_type === "oauth") {
				credential = { type: "oauth", ...parsed } as AuthCredential;
			} else {
				this.#reportUnreadableCredential(row.id, row.provider, `unknown credential type "${row.credential_type}"`);
				continue;
			}

			results.push({ id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause });
		}
		return results;
	}

	#reportUnreadableCredential(id: number, provider: string, reason: string): void {
		logger.error("AgentStorage skipped an unreadable auth credential", {
			id,
			provider,
			reason,
			fix: `Run "veyyon auth-broker login ${provider}" to replace it.`,
		});
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		return this.#authStore.replaceAuthCredentialsForProvider(provider, credentials);
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		this.#authStore.updateAuthCredential(id, credential);
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		this.#authStore.deleteAuthCredential(id, disabledCause);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		this.#authStore.deleteAuthCredentialsForProvider(provider, disabledCause);
	}

	getCache(key: string): string | null {
		return this.#authStore.getCache(key);
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#authStore.setCache(key, value, expiresAtSec);
	}

	cleanExpiredCache(): void {
		this.#authStore.cleanExpiredCache();
	}

	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to create agent storage directory '${dir}': ${code || err}`);
			}
		}
		if (!fs.existsSync(dir)) {
			throw new Error(`Agent storage directory '${dir}' does not exist after creation attempt`);
		}
	}

	#hardenPermissions(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.chmodSync(dir, 0o700);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod agent dir", { path: dir, error: String(error) });
		}

		if (!fs.existsSync(dbPath)) return;
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod db file", { path: dbPath, error: String(error) });
		}
	}
}
