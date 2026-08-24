/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getModelDbPath } from "@veyyon/utils";
import type { Api, Model, ModelSpec } from "./types";

// Rows persist ModelSpec JSON (sparse `compat`, never the resolved record);
// the model manager rebuilds via `buildModel` on load. v11 adds a content
// fingerprint so the resolved-registry snapshot invalidates on every cache
// mutation, including a same-timestamp rewrite. v10 invalidated agent gateway
// rows (Cursor, Devin, Antigravity) whose limits were assumed rather than
// resolved: discovery published a blind 200k/64k pair for every proxied model,
// and a cached row keeps telling the user a 1M-token model holds 200k long after
// the resolver was fixed, because the startup list reads the cache with a 24
// hour TTL and the refresh path serves a stale row while backoff applies. v9
// invalidated rows carrying an identity-derived effort ladder: those specs were
// written when a ladder could be guessed from a model id, so a cached row still
// offers tiers the endpoint never published (Fireworks MiniMax keeping
// `minimal` and its `minimal -> none` mapping is issue #2315 verbatim). A cached
// ladder cannot be repaired in place, because the spec IS the declaration once
// it is on disk. v8 invalidates Codex discovery rows predating provider-native
// V2 compaction metadata; v7 invalidated rows predating the Antigravity Gemini
// budget-mode migration (cached specs still carrying
// `thinking.mode: "google-level"` and the old 3.5-flash effort routing); v6
// invalidated rows that may contain the retired unknown-limit sentinels
// (222222/8888); v5 invalidated rows predating effort-tier variant collapsing
// (raw `-low`/`-high`/`-thinking` member ids); v4 dropped the pre-efforts
// ThinkingConfig shape.
const CACHE_SCHEMA_VERSION = 11;

interface CacheRow {
	provider_id: string;
	version: number;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	content_fingerprint: string;
	models: string;
}

interface TableInfoRow {
	name: string;
}

interface CacheEntry<TApi extends Api = Api> {
	models: ModelSpec<TApi>[];
	fresh: boolean;
	authoritative: boolean;
	updatedAt: number;
	/**
	 * Hash of the static catalog slice that was merged into `models` when this
	 * row was written. `resolveProviderModels` compares against the current
	 * static fingerprint and bypasses the static+cache re-merge when they
	 * match — the cache already incorporates the same static state.
	 */
	staticFingerprint: string;
}

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

function openDb(resolvedPath: string): Database {
	const db = new Database(resolvedPath, { create: true });
	// Install the busy handler BEFORE any lock-taking statement.
	db.run("PRAGMA busy_timeout = 3000");
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			content_fingerprint TEXT NOT NULL DEFAULT '',
			models TEXT NOT NULL
		)
	`);
	migrateCacheSchema(db);
	installCacheRevisionTracking(db);
	return db;
}

function getSharedDb(): Database {
	const resolvedPath = getModelDbPath();
	if (sharedDb && sharedDbPath === resolvedPath) {
		return sharedDb;
	}
	if (sharedDb) {
		sharedDb.close();
	}
	const db = openDb(resolvedPath);
	sharedDb = db;
	sharedDbPath = resolvedPath;
	return db;
}

function withModelCacheDb<T>(dbPath: string | undefined, useDb: (db: Database) => T): T {
	if (!dbPath) return useDb(getSharedDb());
	const db = openDb(dbPath);
	try {
		return useDb(db);
	} finally {
		db.close();
	}
}

function migrateCacheSchema(db: Database): void {
	const stmt = db.prepare("PRAGMA table_info(model_cache)");
	try {
		const columns = stmt.all() as TableInfoRow[];
		if (!columns.some(column => column.name === "static_fingerprint")) {
			db.run("ALTER TABLE model_cache ADD COLUMN static_fingerprint TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some(column => column.name === "content_fingerprint")) {
			db.run("ALTER TABLE model_cache ADD COLUMN content_fingerprint TEXT NOT NULL DEFAULT ''");
		}
	} finally {
		stmt.finalize();
	}
	// Delete rows written under any older schema so they cannot be reused. The
	// legacy `UPDATE ... WHERE version = 2` migration silently promoted the very
	// first cache version to whatever the current one is, defeating every
	// subsequent invalidation (see #4146: pre-V2 Codex rows kept the legacy
	// compaction path even after CACHE_SCHEMA_VERSION was bumped).
	db.run("DELETE FROM model_cache WHERE version <> ?", [CACHE_SCHEMA_VERSION]);
}

function installCacheRevisionTracking(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache_meta (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		)
	`);
	db.run("INSERT OR IGNORE INTO model_cache_meta (key, value) VALUES ('revision', 0)");
	for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
		db.run(`
			CREATE TRIGGER IF NOT EXISTS model_cache_revision_after_${operation.toLowerCase()}
			AFTER ${operation} ON model_cache
			BEGIN
				UPDATE model_cache_meta SET value = value + 1 WHERE key = 'revision';
			END
		`);
	}
}

export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		return withModelCacheDb(dbPath, db => {
			const stmt = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?");
			try {
				const row = stmt.get(providerId);
				if (!row || row.version !== CACHE_SCHEMA_VERSION) {
					return null;
				}
				const models = JSON.parse(row.models) as ModelSpec<TApi>[];
				const ageMs = now() - row.updated_at;
				const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
				return {
					models,
					fresh,
					authoritative: row.authoritative === 1,
					updatedAt: row.updated_at,
					staticFingerprint: row.static_fingerprint ?? "",
				};
			} finally {
				stmt.finalize();
			}
		});
	} catch {
		// A cache we cannot read is a cache MISS: null sends the caller to fresh discovery, which is correct and
		// at worst slower. It is never mistaken for 'the provider has no models', because a miss and an empty
		// cached list are different values here.
		return null;
	}
}

export function writeModelCache<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
): void {
	try {
		withModelCacheDb(dbPath, db => {
			const serializedModels = JSON.stringify(
				models.map(model => ({ ...model, compat: model.compatConfig, compatConfig: undefined })),
			);
			const contentFingerprint = createHash("sha256")
				.update(
					JSON.stringify([
						providerId,
						CACHE_SCHEMA_VERSION,
						updatedAt,
						authoritative,
						staticFingerprint,
						serializedModels,
					]),
				)
				.digest("hex");
			db.run(
				`INSERT OR REPLACE INTO model_cache
				 (provider_id, version, updated_at, authoritative, static_fingerprint, content_fingerprint, models)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					providerId,
					CACHE_SCHEMA_VERSION,
					updatedAt,
					authoritative ? 1 : 0,
					staticFingerprint,
					contentFingerprint,
					serializedModels,
				],
			);
		});
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}

/**
 * Content-derived stamp of the cache table, for snapshot fingerprints.
 *
 * File stamps (mtime/size of `models.db` and its `-wal`/`-shm` sidecars) are
 * the wrong instrument here: SQLite moves the sidecars on every connection,
 * including reads and the writer's own first launch. Each production write
 * stores a digest over every persisted field, while table triggers increment a
 * durable revision for writes outside that path. The common path reads only
 * small fixed-width values and still invalidates for every row mutation.
 */
export function modelCacheStamp(dbPath?: string): string {
	try {
		return withModelCacheDb(dbPath, db => {
			const rows = db
				.query("SELECT provider_id, content_fingerprint FROM model_cache ORDER BY provider_id")
				.all() as Array<Pick<CacheRow, "provider_id" | "content_fingerprint">>;
			const revision = db.query("SELECT value FROM model_cache_meta WHERE key = 'revision'").get() as {
				value: number;
			} | null;
			return createHash("sha256")
				.update(JSON.stringify({ revision: revision?.value ?? 0, rows }))
				.digest("hex");
		});
	} catch {
		return "unreadable";
	}
}
