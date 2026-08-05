/**
 * The default sqlite-backed credential store.
 *
 * WHY IT IS NOT IN `auth-storage.ts` ANY MORE. That module owns the OAuth machinery -- refreshing
 * tokens, consulting provider registries, classifying provider errors -- and reaching it costs 213
 * modules, most of them the provider registry and its 75 provider definitions. This class does none of
 * that. It opens a database, prepares statements, and reads and writes rows. The caller that forced the
 * split is `packages/coding-agent`'s storage layer: it wants exactly this class, and importing it
 * through `auth-storage.ts` put the OAuth flows on the path of `config/settings.ts`, which is the most
 * imported module in that package.
 *
 * The pure row logic it calls lives in `auth-credential-rows.ts`, which imports nothing but
 * `@veyyon/utils`, and the credential TYPES stay in `auth-storage.ts` and arrive as `import type`, which
 * is erased. So there is no runtime edge back to the OAuth side at all: this module and the row helpers
 * are a closed pair.
 *
 * `auth-storage.ts` re-exports this class, so every existing importer of `@veyyon/ai/auth-storage` or of
 * the package barrel is unaffected.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { SQLITE_NOW_EPOCH, tableExists } from "@veyyon/utils/sqlite";
import { errorMessage } from "@veyyon/utils/type-guards";
import {
	AUTH_SCHEMA_VERSION,
	type AuthRow,
	type CredentialBlockRow,
	deserializeCredential,
	isSqliteBusyError,
	matchesReplacementCredential,
	normalizeDisabledCause,
	resolveCredentialIdentityKey,
	resolveRowCredentialIdentityKey,
	serializeCredential,
	toStoredAuthCredential,
	USAGE_HISTORY_BUCKET_MS,
	USAGE_REPORT_TTL_MS,
} from "./auth-credential-rows";
import type {
	AuthCredential,
	AuthCredentialStore,
	CredentialRefreshLeaseFence,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "./auth-storage";
import {
	CREDENTIAL_CLOCK_TOLERANCE_MS,
	epochSecondsToMs,
	isRecordFromFutureClock,
	msToEpochSeconds,
} from "./credential-clock";
import { ConfigurationError } from "./error/validation";
import type { OAuthCredentials } from "./registry/oauth/types";
import type { Provider } from "./types";
import type { UsageCostHistoryEntry, UsageCostHistoryQuery, UsageHistoryEntry, UsageHistoryQuery } from "./usage";

/**
 * Default SQLite-backed implementation of {@link AuthCredentialStore}.
 *
 * Used by the pi-ai CLI and as the default store for `AuthStorage.create()`.
 * Also exposes convenience methods (`saveOAuth`, `getOAuth`, `saveApiKey`,
 * `getApiKey`, `listProviders`, `deleteProvider`) that callers can use directly
 * without going through `AuthStorage`.
 */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#updateEnablingStmt: Statement;
	#deleteStmt: Statement;
	#deleteIfMatchesStmt: Statement;
	#updateIfMatchesStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#getCacheIncludingExpiredStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteCachePrefixStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#updateIfMatchesWithLeaseStmt: Statement;
	#deleteIfMatchesWithLeaseStmt: Statement;
	#getCredentialBlockStmt: Statement;
	#listCredentialBlocksByCredentialStmt: Statement;
	#upsertCredentialBlockStmt: Statement;
	#deleteCredentialBlocksStmt: Statement;
	#deleteExpiredCredentialBlocksStmt: Statement;
	#acquireCredentialRefreshLeaseStmt: Statement;
	#getCredentialRefreshLeaseStmt: Statement;
	#renewCredentialRefreshLeaseStmt: Statement;
	#releaseCredentialRefreshLeaseStmt: Statement;
	#credentialBlockReconcileAfter: Map<string, number> = new Map();
	#insertUsageHistoryStmt: Statement;
	#insertUsageCostStmt: Statement;
	#listUsageCostsStmt: Statement;
	#getAccountNameStmt: Statement;
	#listAccountNamesStmt: Statement;
	#upsertAccountNameStmt: Statement;
	#deleteAccountNameStmt: Statement;
	#lastUsageHistoryStmt: Statement;
	#listUsageHistoryStmt: Statement;
	#updateUsageHistoryStmt: Statement;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();

		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
		this.#updateStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#updateEnablingStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, disabled_cause = NULL, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#updateIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#updateIfMatchesWithLeaseStmt = this.#db.prepare(
			`UPDATE auth_credentials
			SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH}
			WHERE id = ? AND data = ? AND disabled_cause IS NULL
				AND EXISTS (
					SELECT 1 FROM auth_credential_refresh_leases
					WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?
				)`,
		);
		this.#deleteStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#deleteIfMatchesWithLeaseStmt = this.#db.prepare(
			`UPDATE auth_credentials
			SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH}
			WHERE id = ? AND data = ? AND disabled_cause IS NULL
				AND EXISTS (
					SELECT 1 FROM auth_credential_refresh_leases
					WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?
				)`,
		);
		this.#deleteByProviderStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
		);
		this.#hardDeleteStmt = this.#db.prepare("DELETE FROM auth_credentials WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#getCacheIncludingExpiredStmt = this.#db.prepare("SELECT value FROM cache WHERE key = ?");
		this.#upsertCacheStmt = this.#db.prepare(
			"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
		);
		this.#deleteCachePrefixStmt = this.#db.prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?");
		this.#deleteExpiredCacheStmt = this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
		this.#getCredentialBlockStmt = this.#db.prepare(
			"SELECT blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ? AND blocked_until_ms > ?",
		);
		this.#listCredentialBlocksByCredentialStmt = this.#db.prepare(
			"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id = ? AND blocked_until_ms > ? ORDER BY provider_key ASC, block_scope ASC",
		);
		this.#upsertCredentialBlockStmt = this.#db.prepare(
			`INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at)
			VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH})
			ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
				blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
				updated_at = excluded.updated_at`,
		);
		this.#deleteCredentialBlocksStmt = this.#db.prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?");
		this.#deleteExpiredCredentialBlocksStmt = this.#db.prepare(
			"DELETE FROM auth_credential_blocks WHERE blocked_until_ms <= ?",
		);
		// `updated_at` is BOUND from the application clock here, not stamped with
		// ${SQLITE_NOW_EPOCH} like every other table above, and the difference is
		// load-bearing rather than stylistic.
		//
		// This column is not just a record of when the row was touched: the lease
		// logic reads it back and compares it against `Date.now()` to decide whether
		// the row was written by a clock ahead of ours, which makes the lease
		// stealable. Stamping it with SQLite's own C clock while comparing it to
		// JavaScript's means one value is governed by two clocks, and any divergence
		// between them reads as a peer with a skewed clock. `expires_at_ms` on this
		// same row already comes from `Date.now()`, so the row was internally
		// inconsistent.
		//
		// Binding it makes the check mean what it says. A peer with a genuinely
		// skewed clock still writes its own skewed time, so the detection this
		// guards is unchanged, while two readings of the SAME clock can no longer
		// disagree with each other.
		this.#acquireCredentialRefreshLeaseStmt = this.#db.prepare(
			`INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(credential_id) DO UPDATE SET
				owner = excluded.owner,
				expires_at_ms = excluded.expires_at_ms,
				updated_at = excluded.updated_at
			WHERE auth_credential_refresh_leases.expires_at_ms <= ?
				OR auth_credential_refresh_leases.updated_at > ?`,
		);
		this.#getCredentialRefreshLeaseStmt = this.#db.prepare(
			"SELECT expires_at_ms, updated_at FROM auth_credential_refresh_leases WHERE credential_id = ?",
		);
		this.#renewCredentialRefreshLeaseStmt = this.#db.prepare(
			// Same clock as the acquire above, for the same reason: a renewal that
			// re-stamped this column from SQLite's clock would undo the fix on the
			// first renewal of any long refresh.
			`UPDATE auth_credential_refresh_leases SET expires_at_ms = ?, updated_at = ? WHERE credential_id = ? AND owner = ?`,
		);
		this.#releaseCredentialRefreshLeaseStmt = this.#db.prepare(
			"DELETE FROM auth_credential_refresh_leases WHERE credential_id = ? AND owner = ?",
		);
		this.#insertUsageHistoryStmt = this.#db.prepare(
			"INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#lastUsageHistoryStmt = this.#db.prepare(
			"SELECT id, recorded_at FROM usage_history WHERE provider = ? AND account_key = ? AND limit_id = ? ORDER BY recorded_at DESC LIMIT 1",
		);
		this.#updateUsageHistoryStmt = this.#db.prepare(
			"UPDATE usage_history SET recorded_at = ?, email = ?, account_id = ?, label = ?, window_label = ?, used_fraction = ?, status = ?, resets_at = ? WHERE id = ?",
		);
		this.#listUsageHistoryStmt = this.#db.prepare(
			"SELECT recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at FROM usage_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) ORDER BY recorded_at ASC",
		);
		this.#insertUsageCostStmt = this.#db.prepare(
			"INSERT INTO usage_cost_history (recorded_at, provider, account_key, cost_usd) VALUES (?, ?, ?, ?)",
		);
		this.#listUsageCostsStmt = this.#db.prepare(
			"SELECT recorded_at, provider, account_key, cost_usd FROM usage_cost_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) AND (? IS NULL OR account_key = ?) ORDER BY recorded_at ASC",
		);
		this.#getAccountNameStmt = this.#db.prepare("SELECT name FROM auth_account_names WHERE identity = ?");
		this.#listAccountNamesStmt = this.#db.prepare("SELECT identity, name FROM auth_account_names");
		this.#upsertAccountNameStmt = this.#db.prepare(
			`INSERT INTO auth_account_names (identity, name, updated_at) VALUES (?, ?, ${SQLITE_NOW_EPOCH})
			 ON CONFLICT(identity) DO UPDATE SET name = excluded.name, updated_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#deleteAccountNameStmt = this.#db.prepare("DELETE FROM auth_account_names WHERE identity = ?");
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<SqliteAuthCredentialStore> {
		const dir = path.dirname(dbPath);
		// Fails CLOSED into the `mkdir` below: an unstattable parent is treated as absent, and `mkdir` then
		// raises the real error (EACCES, ENOTDIR) with the path in it. Reporting the stat failure here would
		// duplicate that error one line earlier and stop the ordinary "the directory is not there yet" case
		// from proceeding.
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		// Concurrent veyyon startups can race against WAL recovery and the schema
		// init's first lock-taking statement. Bun's default `busy_timeout` is 0,
		// so retry the open on `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` with bounded
		// exponential backoff before surfacing the failure. See issue #2421.
		const maxAttempts = 4;
		const baseDelayMs = 100;
		let lastBusyError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let db: Database | undefined;
			try {
				db = new Database(dbPath);
				try {
					await fs.chmod(dbPath, 0o600);
				} catch {
					// Ignore chmod failures (e.g., Windows)
				}
				SqliteAuthCredentialStore.#ensureAuthCredentialRefreshLeasesTable(db);
				return new SqliteAuthCredentialStore(db);
			} catch (err) {
				db?.close();
				if (!isSqliteBusyError(err)) {
					throw err;
				}
				lastBusyError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxAttempts - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}
		throw new ConfigurationError(
			`Failed to open auth database at '${dbPath}' after ${maxAttempts} attempts: ${lastBusyError?.message}`,
			{ cause: lastBusyError },
		);
	}

	static #ensureAuthCredentialRefreshLeasesTable(db: Database): void {
		db.run(`
			CREATE TABLE IF NOT EXISTS auth_credential_refresh_leases (
				credential_id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_credential_refresh_leases_expires ON auth_credential_refresh_leases(expires_at_ms);
		`);
	}

	#initializeSchema(): void {
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which acquires an exclusive lock during WAL
		// recovery). Without this, concurrent veyyon startups can crash here with
		// `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY`. See issue #2421.
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
			CREATE TABLE IF NOT EXISTS usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_usage_history_series ON usage_history(provider, account_key, limit_id, recorded_at);
			CREATE TABLE IF NOT EXISTS usage_cost_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				cost_usd REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_usage_cost_history_lookup ON usage_cost_history(provider, account_key, recorded_at);
			CREATE TABLE IF NOT EXISTS auth_account_names (
				identity TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_usage_history_recorded ON usage_history(recorded_at);
		`);

		if (!this.#authCredentialsTableExists()) {
			this.#createAuthCredentialsTable();
			this.#createAuthCredentialBlocksTable();
			this.#createAuthCredentialRefreshLeasesTable();
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
			return;
		}

		const recordedVersion = this.#readAuthSchemaVersion();
		const schemaVersion = recordedVersion ?? this.#inferAuthSchemaVersion();
		if (schemaVersion > AUTH_SCHEMA_VERSION) {
			logger.warn("SqliteAuthCredentialStore schema version mismatch", {
				current: schemaVersion,
				expected: AUTH_SCHEMA_VERSION,
			});
		} else if (schemaVersion < AUTH_SCHEMA_VERSION) {
			this.#migrateAuthSchema(schemaVersion);
		}

		this.#createAuthCredentialIndexes();
		this.#createAuthCredentialBlocksTable();
		this.#createAuthCredentialRefreshLeasesTable();
		this.#backfillCredentialIdentityKeys();
		// Rewriting an already-current version row is a no-op write transaction
		// on every boot; only persist when the recorded version actually changes.
		if (recordedVersion !== AUTH_SCHEMA_VERSION && schemaVersion <= AUTH_SCHEMA_VERSION) {
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
		}
	}

	#authCredentialsTableExists(): boolean {
		return tableExists(this.#db, "auth_credentials");
	}

	#readAuthSchemaVersion(): number | null {
		const stmt = this.#db.prepare("SELECT version FROM auth_schema_version WHERE id = 1");
		try {
			const row = stmt.get() as { version?: number } | undefined;
			return typeof row?.version === "number" ? row.version : null;
		} finally {
			stmt.finalize();
		}
	}

	#writeAuthSchemaVersion(version: number): void {
		const stmt = this.#db.prepare("INSERT OR REPLACE INTO auth_schema_version(id, version) VALUES (1, ?)");
		try {
			stmt.run(version);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersion(): number {
		const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
		try {
			const cols = stmt.all() as Array<{ name?: string }>;
			return this.#inferAuthSchemaVersionFromColumns(cols);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersionFromColumns(cols: Array<{ name?: string }>): number {
		const hasDisabledCause = cols.some(column => column.name === "disabled_cause");
		const hasIdentityKey = cols.some(column => column.name === "identity_key");
		const hasAccountId = cols.some(column => column.name === "account_id");
		const hasEmail = cols.some(column => column.name === "email");
		if (hasIdentityKey) return 3;
		if (hasAccountId || hasEmail) return 2;
		if (hasDisabledCause) return 1;
		return 0;
	}

	#createAuthCredentialsTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
				updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
			);
		`);
		this.#createAuthCredentialIndexes();
	}

	#createAuthCredentialIndexes(): void {
		this.#db.run(`
			CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;
		`);
	}

	#createAuthCredentialBlocksTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credential_blocks (
				credential_id INTEGER NOT NULL,
				provider_key TEXT NOT NULL,
				block_scope TEXT NOT NULL DEFAULT '',
				blocked_until_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (credential_id, provider_key, block_scope)
			);
			CREATE INDEX IF NOT EXISTS idx_auth_credential_blocks_expires ON auth_credential_blocks(blocked_until_ms);
		`);
	}

	#createAuthCredentialRefreshLeasesTable(): void {
		SqliteAuthCredentialStore.#ensureAuthCredentialRefreshLeasesTable(this.#db);
	}

	#migrateAuthSchema(fromVersion: number): void {
		if (fromVersion < 1) {
			this.#migrateAuthSchemaV0ToV1();
		}
		if (fromVersion < 3) {
			this.#migrateAuthSchemaV1OrV2ToV3();
		}
		if (fromVersion < 4) {
			this.#migrateAuthSchemaV3ToV4();
		}
		if (fromVersion < 5) {
			this.#migrateAuthSchemaV4ToV5();
		}
		if (fromVersion < 6) {
			this.#migrateAuthSchemaV5ToV6();
		}
	}

	#migrateAuthSchemaV0ToV1(): void {
		const migrate = this.#db.transaction(() => {
			const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
			let hasDisabled = false;
			try {
				const v0Cols = stmt.all() as Array<{ name?: string }>;
				hasDisabled = v0Cols.some(col => col.name === "disabled");
			} finally {
				stmt.finalize();
			}

			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v0");
			this.#db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
					updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
				);
			`);
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					${hasDisabled ? "CASE WHEN disabled = 1 THEN 'disabled' ELSE NULL END" : "NULL"},
					created_at,
					updated_at
				FROM auth_credentials_v0
			`);
			this.#db.run("DROP TABLE auth_credentials_v0");
		});
		migrate();
	}

	#migrateAuthSchemaV1OrV2ToV3(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_legacy");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					NULL,
					created_at,
					updated_at
				FROM auth_credentials_legacy
			`);
			this.#db.run("DROP TABLE auth_credentials_legacy");
		});
		migrate();
	}

	#migrateAuthSchemaV3ToV4(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v3");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					identity_key,
					created_at,
					updated_at
				FROM auth_credentials_v3
			`);
			this.#db.run("DROP TABLE auth_credentials_v3");
		});
		migrate();
	}

	#migrateAuthSchemaV4ToV5(): void {
		const migrate = this.#db.transaction(() => {
			this.#createAuthCredentialBlocksTable();
		});
		migrate();
	}

	#migrateAuthSchemaV5ToV6(): void {
		const migrate = this.#db.transaction(() => {
			this.#createAuthCredentialRefreshLeasesTable();
		});
		migrate();
	}

	#backfillCredentialIdentityKeys(): void {
		const selectRowsStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE identity_key IS NULL ORDER BY id ASC",
		);
		let rows: AuthRow[];
		try {
			rows = selectRowsStmt.all() as AuthRow[];
		} finally {
			selectRowsStmt.finalize();
		}
		if (rows.length === 0) return;

		let updateIdentity: Statement | null = null;
		try {
			for (const row of rows) {
				const identityKey = resolveRowCredentialIdentityKey(row.provider, row);
				// Rows whose identity cannot be derived stay NULL; writing NULL over
				// NULL would just burn a write transaction on every boot.
				if (identityKey === null) continue;
				updateIdentity ??= this.#db.prepare("UPDATE auth_credentials SET identity_key = ? WHERE id = ?");
				updateIdentity.run(identityKey, row.id);
			}
		} finally {
			updateIdentity?.finalize();
		}
	}

	// ─── AuthCredentialStore interface ──────────────────────────────────────

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows =
			(provider
				? (this.#listActiveByProviderStmt.all(provider) as AuthRow[])
				: (this.#listActiveStmt.all() as AuthRow[])) ?? [];

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			const result: StoredAuthCredential[] = [];
			const matchedExistingIds = new Set<number>();

			for (const credential of items) {
				const serialized = serializeCredential(providerName, credential);
				if (!serialized) continue;
				const match = existing.find(
					entry =>
						!matchedExistingIds.has(entry.id) &&
						matchesReplacementCredential(providerName, entry.credential, entry.identityKey, credential),
				);
				if (match) {
					matchedExistingIds.add(match.id);
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, match.id);
					result.push({ id: match.id, provider: providerName, credential, disabledCause: null });
				} else {
					const row = this.#insertStmt.get(
						providerName,
						serialized.credentialType,
						serialized.data,
						serialized.identityKey,
					) as { id?: number } | undefined;
					if (row?.id) {
						result.push({ id: row.id, provider: providerName, credential, disabledCause: null });
					}
				}
			}

			for (const row of existing) {
				if (!matchedExistingIds.has(row.id)) {
					this.#deleteStmt.run("replaced by newer credential", row.id);
				}
			}

			return result;
		});

		const result = replace(provider, credentials);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			if (item.type === "oauth") {
				for (const row of existing) {
					if (row.credential && row.credential.type === "api_key") {
						this.#deleteStmt.run("replaced by oauth login", row.id);
					}
				}
			}

			let targetId: number | null = null;
			for (const row of existing) {
				if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
				if (targetId === null) {
					targetId = row.id;
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, row.id);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) {
				const row = this.#insertStmt.get(
					providerName,
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
				) as { id?: number } | undefined;
				targetId = row?.id ?? null;
			}

			const activeRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const result: StoredAuthCredential[] = [];
			for (const row of activeRows) {
				const activeCredential = deserializeCredential(row);
				if (!activeCredential) continue;
				result.push(toStoredAuthCredential(row, activeCredential));
			}
			return result;
		});

		const result = upsert(provider, credential);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	/**
	 * Hard-deletes disabled rows for a provider when an active replacement exists.
	 * OAuth credentials match by identity key; API keys match by provider and type.
	 * Disabled rows without an active same-type replacement remain recoverable.
	 */
	#purgeSupersededDisabledRows(provider: string, activeRows: StoredAuthCredential[]): void {
		try {
			let hasActiveApiKey = false;
			const activeIdentityKeys = new Set<string>();
			for (const row of activeRows) {
				if (row.credential.type === "api_key") {
					hasActiveApiKey = true;
					continue;
				}
				const identityKey = resolveCredentialIdentityKey(provider, row.credential);
				if (identityKey) activeIdentityKeys.add(identityKey);
			}
			if (!hasActiveApiKey && activeIdentityKeys.size === 0) return;

			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
			for (const row of disabledRows) {
				if (hasActiveApiKey && row.credential_type === "api_key") {
					this.#hardDeleteStmt.run(row.id);
					continue;
				}
				const identityKey = resolveRowCredentialIdentityKey(provider, row);
				if (identityKey && activeIdentityKeys.has(identityKey)) {
					this.#hardDeleteStmt.run(row.id);
				}
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	/**
	 * The re-enabling variant of {@link updateAuthCredential}: writes the credential
	 * and clears `disabled_cause` in one statement, so a row a peer disabled on a
	 * superseded token comes back the moment a refresh proves the grant is alive.
	 */
	updateAuthCredentialEnabling(id: number, credential: AuthCredential): void {
		this.#writeCredential(id, credential, true);
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		this.#writeCredential(id, credential, false);
	}

	/**
	 * Read one row by id, INCLUDING disabled rows, which `listAuthCredentials`
	 * filters out. Used during a refresh race to see whether a peer already rotated
	 * the token, since the peer's row may itself have been disabled.
	 */
	readAuthCredentialById(id: number): StoredAuthCredential | undefined {
		const stmt = this.#db.prepare("SELECT * FROM auth_credentials WHERE id = ?");
		try {
			const row = stmt.get(id) as AuthRow | undefined;
			if (!row) return undefined;
			const credential = deserializeCredential(row);
			if (!credential) return undefined;
			return toStoredAuthCredential(row, credential);
		} finally {
			stmt.finalize();
		}
	}

	/**
	 * List disabled rows, newest first. See
	 * {@link AuthCredentialStore.listDisabledAuthCredentials}.
	 *
	 * Ordered by id descending because the row that matters is the one disabled
	 * most recently: an account that was replaced and then re-added leaves older
	 * disabled rows behind, and reporting one of those would name a cause the user
	 * already resolved.
	 */
	listDisabledAuthCredentials(provider?: string): StoredAuthCredential[] {
		const sql = provider
			? "SELECT * FROM auth_credentials WHERE disabled_cause IS NOT NULL AND provider = ? ORDER BY id DESC"
			: "SELECT * FROM auth_credentials WHERE disabled_cause IS NOT NULL ORDER BY id DESC";
		const stmt = this.#db.prepare(sql);
		try {
			const rows = (provider ? stmt.all(provider) : stmt.all()) as AuthRow[];
			const stored: StoredAuthCredential[] = [];
			for (const row of rows) {
				const credential = deserializeCredential(row);
				if (credential) stored.push(toStoredAuthCredential(row, credential));
			}
			return stored;
		} finally {
			stmt.finalize();
		}
	}

	#writeCredential(id: number, credential: AuthCredential, reenable: boolean): void {
		try {
			const providerStmt = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?");
			let providerRow: { provider?: string } | undefined;
			try {
				providerRow = providerStmt.get(id) as { provider?: string } | undefined;
			} finally {
				providerStmt.finalize();
			}
			const provider = providerRow?.provider ?? "";
			const serialized = serializeCredential(provider, credential);
			if (!serialized) return;
			const statement = reenable ? this.#updateEnablingStmt : this.#updateStmt;
			statement.run(serialized.credentialType, serialized.data, serialized.identityKey, id);
			if (provider) {
				this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
			}
		} catch (error) {
			// NEVER silent. A dropped credential write is the logout bug: the caller
			// believes the rotated token is on disk, the next process reads the old one,
			// and a single-use refresh token is already spent. There is no safe recovery
			// here, so the least-bad outcome is that the operator can SEE it happened.
			logger.error("Failed to persist auth credential update", {
				id,
				clearDisabled: reenable,
				error: errorMessage(error),
			});
		}
	}

	tryUpdateAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		const providerStmt = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?");
		let providerRow: { provider?: string } | undefined;
		try {
			providerRow = providerStmt.get(id) as { provider?: string } | undefined;
		} finally {
			providerStmt.finalize();
		}
		const provider = providerRow?.provider ?? "";
		const serialized = serializeCredential(provider, credential);
		if (!serialized) return false;
		const result = lease
			? (this.#updateIfMatchesWithLeaseStmt.run(
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
					id,
					expectedData,
					id,
					lease.owner,
					lease.nowMs,
				) as { changes: number })
			: (this.#updateIfMatchesStmt.run(
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
					id,
					expectedData,
				) as { changes: number });
		if (result.changes !== 1) return false;
		if (provider) {
			this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
		}
		return true;
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		try {
			this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
		} catch (error) {
			// This method returns void, so a swallowed failure told the caller the
			// credential was disabled when it is still enabled and still in rotation.
			// A key revoked upstream then keeps being retried on every request.
			logger.warn("Auth credential could not be disabled; it stays in rotation", {
				id,
				disabledCause,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * CAS-style disable: only soft-deletes the row when its `data` column still
	 * matches `expectedData` and the row has not already been disabled. Used by
	 * the OAuth refresh-failure path to avoid clobbering a peer that rotated the
	 * row between our pre-check and the disable.
	 */
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		const result = lease
			? (this.#deleteIfMatchesWithLeaseStmt.run(
					normalizeDisabledCause(disabledCause),
					id,
					expectedData,
					id,
					lease.owner,
					lease.nowMs,
				) as { changes: number })
			: (this.#deleteIfMatchesStmt.run(normalizeDisabledCause(disabledCause), id, expectedData) as {
					changes: number;
				});
		return result.changes === 1;
	}
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		try {
			this.#deleteByProviderStmt.run(normalizeDisabledCause(disabledCause), provider);
		} catch (error) {
			// Same masked outcome as deleteAuthCredential, for every credential the
			// provider owns: the caller believes the provider was signed out.
			logger.warn("Auth credentials for provider could not be disabled; they stay in rotation", {
				provider,
				disabledCause,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Report a failed cache statement once per operation, then stay quiet about it.
	 *
	 * Every method below answers a database failure by behaving as though the cache were simply empty:
	 * a failed read is a miss, a failed write is a value not kept. That is the right BEHAVIOUR -- a cache
	 * is an optimization and nothing here should fail a request over it -- but doing it silently hides a
	 * real operational fault. A read-only or corrupt `auth.db`, a full disk, or a locked file makes every
	 * lookup miss and every write vanish, so the process re-fetches model catalogs and OAuth metadata on
	 * every launch and looks merely slow. The first failure of each kind says what happened; later ones
	 * are debug, because a broken database fails on every call and a warning per call would bury it.
	 */
	#reportedCacheFailures = new Set<string>();

	#reportCacheFailure(operation: string, error: unknown): void {
		const detail = { operation, error: String(error) };
		if (this.#reportedCacheFailures.has(operation)) {
			logger.debug("AuthStorage cache operation failed again", detail);
			return;
		}
		this.#reportedCacheFailures.add(operation);
		logger.warn(
			"AuthStorage cache is not working; cached model catalogs and OAuth metadata will be re-fetched every time",
			detail,
		);
	}

	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		try {
			const stmt = options?.includeExpired === true ? this.#getCacheIncludingExpiredStmt : this.#getCacheStmt;
			const row = stmt.get(key) as { value?: string } | undefined;
			return row?.value ?? null;
		} catch (error) {
			// A failed read is indistinguishable from a miss to the caller, which is why it has to be said
			// out loud here: otherwise an unreadable database looks exactly like a cold cache, forever.
			this.#reportCacheFailure("get", error);
			return null;
		}
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		try {
			this.#upsertCacheStmt.run(key, value, expiresAtSec);
		} catch (error) {
			this.#reportCacheFailure("set", error);
		}
	}

	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix(prefix: string): void {
		try {
			this.#deleteCachePrefixStmt.run(prefix.length, prefix);
		} catch (error) {
			// A delete that fails leaves STALE rows behind, so a later read can serve data the caller
			// believed it had invalidated. Reported for that reason, not merely for symmetry.
			this.#reportCacheFailure("deletePrefix", error);
		}
	}

	cleanExpiredCache(): void {
		try {
			this.#deleteExpiredCacheStmt.run();
		} catch (error) {
			this.#reportCacheFailure("cleanExpired", error);
		}
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		const nowMs = Date.now();
		this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		const row = this.#getCredentialBlockStmt.get(credentialId, providerKey, blockScope, nowMs) as
			| { blocked_until_ms?: number; updated_at?: number }
			| undefined;
		if (typeof row?.blocked_until_ms !== "number") return undefined;
		// `updated_at` is whole seconds. A row written after the clock we are
		// reading with cannot be measured against it; drop the block rather than
		// hold the credential for the length of the jump. This matters more here
		// than in memory: a persisted block survives restarts, so without the
		// check the credential stays unusable across every later process too.
		if (isRecordFromFutureClock(epochSecondsToMs(row.updated_at), nowMs)) return undefined;
		return row.blocked_until_ms;
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		const nowMs = Date.now();
		this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		const row = this.#getCredentialBlockStmt.get(credentialId, providerKey, blockScope, nowMs) as
			| { blocked_until_ms?: number; updated_at?: number }
			| undefined;
		if (typeof row?.blocked_until_ms !== "number") return undefined;
		const memoryReconcileAfter =
			this.#credentialBlockReconcileAfter.get(`${credentialId}\0${providerKey}\0${blockScope}`) ?? 0;
		const writtenAtMs = epochSecondsToMs(row.updated_at);
		if (isRecordFromFutureClock(writtenAtMs, nowMs)) return undefined;
		const persistedReconcileAfter = writtenAtMs === undefined ? 0 : writtenAtMs + USAGE_REPORT_TTL_MS;
		const reconcileAfter = Math.max(memoryReconcileAfter, persistedReconcileAfter);
		return reconcileAfter > nowMs ? Math.min(row.blocked_until_ms, reconcileAfter) : undefined;
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		this.#upsertCredentialBlockStmt.run(
			block.credentialId,
			block.providerKey,
			block.blockScope,
			block.blockedUntilMs,
		);
		this.#credentialBlockReconcileAfter.set(
			`${block.credentialId}\0${block.providerKey}\0${block.blockScope}`,
			Math.min(block.blockedUntilMs, Date.now() + USAGE_REPORT_TTL_MS),
		);
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#deleteCredentialBlocksStmt.run(credentialId);
		for (const key of this.#credentialBlockReconcileAfter.keys()) {
			if (key.startsWith(`${credentialId}\0`)) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	/**
	 * Read the display name a user chose for one account identity.
	 *
	 * Names live in their OWN table, never inside `auth_credentials.data`. That is not a
	 * preference: several persist paths rebuild an OAuth credential from an explicit field
	 * list (`#persistRefreshedUsageCredential` is one), so a field carried inside the blob
	 * is silently destroyed by the next token refresh. Keeping the name out of the blob also
	 * means renaming an account cannot rewrite token bytes at all, which is the only way to
	 * make a rename incapable of breaking a login.
	 */
	getAccountName(identity: string): string | undefined {
		const row = this.#getAccountNameStmt.get(identity) as { name?: string } | undefined;
		const name = row?.name?.trim();
		return name && name.length > 0 ? name : undefined;
	}

	listAccountNames(): Array<{ identity: string; name: string }> {
		const rows = this.#listAccountNamesStmt.all() as Array<{ identity?: string; name?: string }>;
		const names: Array<{ identity: string; name: string }> = [];
		for (const row of rows) {
			const identity = row.identity?.trim();
			const name = row.name?.trim();
			if (identity && name) names.push({ identity, name });
		}
		return names;
	}

	setAccountName(identity: string, name: string): void {
		this.#upsertAccountNameStmt.run(identity, name);
	}

	deleteAccountName(identity: string): void {
		this.#deleteAccountNameStmt.run(identity);
	}

	cleanExpiredCredentialBlocks(nowMs: number): void {
		this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		for (const [key, reconcileAfterMs] of this.#credentialBlockReconcileAfter) {
			if (reconcileAfterMs <= nowMs) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (credentialIds.length === 0) return [];
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const seenCredentialIds = new Set<number>();
		const blocks: StoredCredentialBlock[] = [];
		for (const credentialId of credentialIds) {
			if (seenCredentialIds.has(credentialId)) continue;
			seenCredentialIds.add(credentialId);
			const rows = this.#listCredentialBlocksByCredentialStmt.all(credentialId, nowMs) as CredentialBlockRow[];
			for (const row of rows) {
				blocks.push({
					credentialId: row.credential_id,
					providerKey: row.provider_key,
					blockScope: row.block_scope,
					blockedUntilMs: row.blocked_until_ms,
					updatedAtMs: epochSecondsToMs(row.updated_at),
				});
			}
		}
		return blocks;
	}

	tryAcquireCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const nowMs = Date.now();
		// The second bound steals a lease stamped by a clock ahead of this one.
		// Without it, a backward clock jump makes the row unstealable for the
		// length of the jump and every refresh waiter polls until the clock
		// catches up: a hung OAuth refresh, not a slow one. `updated_at` is whole
		// seconds, so the tolerance is applied before the conversion.
		const staleWriteCutoffSeconds = Math.ceil((nowMs + CREDENTIAL_CLOCK_TOLERANCE_MS) / 1000);
		const result = this.#acquireCredentialRefreshLeaseStmt.run(
			credentialId,
			owner,
			expiresAtMs,
			msToEpochSeconds(nowMs),
			nowMs,
			staleWriteCutoffSeconds,
		) as {
			changes: number;
		};
		return result.changes === 1;
	}

	getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined {
		const row = this.#getCredentialRefreshLeaseStmt.get(credentialId) as
			| { expires_at_ms?: number; updated_at?: number }
			| undefined;
		if (typeof row?.expires_at_ms !== "number") return undefined;
		const nowMs = Date.now();
		if (row.expires_at_ms <= nowMs) return undefined;
		// Report a lease from a future clock as absent so the waiter retries the
		// acquire (which now steals it) instead of sleeping out the jump.
		if (isRecordFromFutureClock(epochSecondsToMs(row.updated_at), nowMs)) return undefined;
		return row.expires_at_ms;
	}

	renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const result = this.#renewCredentialRefreshLeaseStmt.run(
			expiresAtMs,
			msToEpochSeconds(Date.now()),
			credentialId,
			owner,
		) as {
			changes: number;
		};
		return result.changes === 1;
	}

	releaseCredentialRefreshLease(credentialId: number, owner: string): void {
		try {
			this.#releaseCredentialRefreshLeaseStmt.run(credentialId, owner);
		} catch {
			// Ignore lease release failures; expired leases are stealable.
		}
	}

	recordUsageSnapshots(entries: UsageHistoryEntry[]): void {
		try {
			for (const entry of entries) {
				const bucket = Math.floor(entry.recordedAt / USAGE_HISTORY_BUCKET_MS);
				const last = this.#lastUsageHistoryStmt.get(entry.provider, entry.accountKey, entry.limitId) as
					| { id: number; recorded_at: number }
					| undefined;
				if (last && Math.floor(last.recorded_at / USAGE_HISTORY_BUCKET_MS) === bucket) {
					this.#updateUsageHistoryStmt.run(
						entry.recordedAt,
						entry.email ?? null,
						entry.accountId ?? null,
						entry.label,
						entry.windowLabel ?? null,
						entry.usedFraction ?? null,
						entry.status ?? null,
						entry.resetsAt ?? null,
						last.id,
					);
					continue;
				}
				this.#insertUsageHistoryStmt.run(
					entry.recordedAt,
					entry.provider,
					entry.accountKey,
					entry.email ?? null,
					entry.accountId ?? null,
					entry.limitId,
					entry.label,
					entry.windowLabel ?? null,
					entry.usedFraction ?? null,
					entry.status ?? null,
					entry.resetsAt ?? null,
				);
			}
		} catch {
			// History is best-effort; never break the usage fetch path.
		}
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		try {
			const provider = query?.provider ?? null;
			const rows = this.#listUsageHistoryStmt.all(query?.sinceMs ?? 0, provider, provider) as Array<{
				recorded_at: number;
				provider: string;
				account_key: string;
				email: string | null;
				account_id: string | null;
				limit_id: string;
				label: string;
				window_label: string | null;
				used_fraction: number | null;
				status: string | null;
				resets_at: number | null;
			}>;
			return rows.map(row => ({
				recordedAt: row.recorded_at,
				provider: row.provider as Provider,
				accountKey: row.account_key,
				email: row.email ?? undefined,
				accountId: row.account_id ?? undefined,
				limitId: row.limit_id,
				label: row.label,
				windowLabel: row.window_label ?? undefined,
				usedFraction: row.used_fraction ?? undefined,
				status: (row.status ?? undefined) as UsageHistoryEntry["status"],
				resetsAt: row.resets_at ?? undefined,
			}));
		} catch (error) {
			// An empty list is how this says "you have no recorded usage", so a failed query used to present a
			// database it could not read as a clean history. The caller keeps its empty list, because a usage
			// panel that cannot query is more useful empty than crashed, and the report is the difference.
			logger.warn("Usage history could not be read; the usage view is showing none of it", {
				error: errorMessage(error),
			});
			return [];
		}
	}
	recordUsageCosts(entries: UsageCostHistoryEntry[]): void {
		try {
			for (const entry of entries) {
				this.#insertUsageCostStmt.run(entry.recordedAt, entry.provider, entry.accountKey, entry.costUsd);
			}
		} catch (error) {
			// Still not fatal to the request, but this is money: a dropped batch makes
			// the cost view under-report spend, and an under-report is indistinguishable
			// from cheap usage unless the drop is named.
			logger.warn("Usage costs could not be recorded; the cost view will under-report this spend", {
				entries: entries.length,
				error: errorMessage(error),
			});
		}
	}

	listUsageCosts(query?: UsageCostHistoryQuery): UsageCostHistoryEntry[] {
		try {
			const provider = query?.provider ?? null;
			const accountKey = query?.accountKey ?? null;
			const rows = this.#listUsageCostsStmt.all(
				query?.sinceMs ?? 0,
				provider,
				provider,
				accountKey,
				accountKey,
			) as Array<{
				recorded_at: number;
				provider: string;
				account_key: string;
				cost_usd: number;
			}>;
			return rows.map(row => ({
				recordedAt: row.recorded_at,
				provider: row.provider as Provider,
				accountKey: row.account_key,
				costUsd: row.cost_usd,
			}));
		} catch (error) {
			// Same as `listUsageHistory`: zero recorded cost and an unreadable cost table are the same empty
			// list, and reporting a total of $0 for a database that could not be queried is worse than saying
			// so. The empty list is still returned so the view renders.
			logger.warn("Usage cost history could not be read; the reported totals are missing all of it", {
				error: errorMessage(error),
			});
			return [];
		}
	}

	// ─── Convenience methods for CLI ────────────────────────────────────────

	/**
	 * Save OAuth credentials for a provider.
	 * Preserves unrelated identities and replaces only the matching credential.
	 */
	saveOAuth(provider: string, credentials: OAuthCredentials): void {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		this.upsertAuthCredentialForProvider(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "oauth") {
				const { type: _type, ...oauth } = credential;
				return oauth as OAuthCredentials;
			}
		}
		return null;
	}

	/**
	 * Save API key for a provider (replaces existing).
	 */
	saveApiKey(provider: string, apiKey: string): void {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "api_key") {
				return credential.key;
			}
		}
		return null;
	}

	/**
	 * List all providers with credentials.
	 */
	listProviders(): string[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		const providers = new Set<string>();
		for (const row of rows) {
			providers.add(row.provider);
		}
		return Array.from(providers);
	}

	/**
	 * Delete all credentials for a provider.
	 */
	deleteProvider(provider: string): void {
		this.deleteAuthCredentialsForProvider(provider, "deleted by user");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listActiveStmt.finalize();
		this.#listActiveByProviderStmt.finalize();
		this.#listDisabledByProviderStmt.finalize();
		this.#insertStmt.finalize();
		this.#updateStmt.finalize();
		this.#deleteStmt.finalize();
		this.#deleteIfMatchesStmt.finalize();
		this.#deleteByProviderStmt.finalize();
		this.#hardDeleteStmt.finalize();
		this.#getCacheStmt.finalize();
		this.#getCacheIncludingExpiredStmt.finalize();
		this.#upsertCacheStmt.finalize();
		this.#deleteExpiredCacheStmt.finalize();
		this.#getCredentialBlockStmt.finalize();
		this.#listCredentialBlocksByCredentialStmt.finalize();
		this.#upsertCredentialBlockStmt.finalize();
		this.#deleteCredentialBlocksStmt.finalize();
		this.#deleteExpiredCredentialBlocksStmt.finalize();
		this.#insertUsageHistoryStmt.finalize();
		this.#lastUsageHistoryStmt.finalize();
		this.#listUsageHistoryStmt.finalize();
		this.#updateUsageHistoryStmt.finalize();
		this.#insertUsageCostStmt.finalize();
		this.#listUsageCostsStmt.finalize();
		this.#db.close();
	}
}
