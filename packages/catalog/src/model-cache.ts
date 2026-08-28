import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { DAY_MS, getModelDbPath } from "@veyyon/utils";
import type { Api, Model, ModelSpec } from "./types";

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
	for (const operation of ["INSERT", "DELETE"]) {
		db.run(`
			CREATE TRIGGER IF NOT EXISTS model_cache_revision_after_${operation.toLowerCase()}
			AFTER ${operation} ON model_cache
			BEGIN
				UPDATE model_cache_meta SET value = value + 1 WHERE key = 'revision';
			END
		`);
	}
	db.run(`
		CREATE TRIGGER IF NOT EXISTS model_cache_revision_after_update
		AFTER UPDATE ON model_cache
		WHEN NEW.content_fingerprint IS NOT OLD.content_fingerprint
			OR NEW.models IS NOT OLD.models
			OR NEW.authoritative IS NOT OLD.authoritative
			OR NEW.static_fingerprint IS NOT OLD.static_fingerprint
			OR NEW.version IS NOT OLD.version
		BEGIN
			UPDATE model_cache_meta SET value = value + 1 WHERE key = 'revision';
		END
	`);
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
					JSON.stringify([providerId, CACHE_SCHEMA_VERSION, authoritative, staticFingerprint, serializedModels]),
				)
				.digest("hex");
			db.run(
				`INSERT INTO model_cache
				 (provider_id, version, updated_at, authoritative, static_fingerprint, content_fingerprint, models)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(provider_id) DO UPDATE SET
				     version = excluded.version,
				     updated_at = excluded.updated_at,
				     authoritative = excluded.authoritative,
				     static_fingerprint = excluded.static_fingerprint,
				     content_fingerprint = excluded.content_fingerprint,
				     models = excluded.models`,
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
	} catch {}
}

export function modelCacheStamp(dbPath?: string, options?: { ttlMs?: number; now?: () => number }): string {
	const ttlMs = options?.ttlMs ?? DAY_MS;
	const now = options?.now ?? Date.now;
	try {
		return withModelCacheDb(dbPath, db => {
			const rows = db
				.query("SELECT provider_id, content_fingerprint, updated_at FROM model_cache ORDER BY provider_id")
				.all() as Array<Pick<CacheRow, "provider_id" | "content_fingerprint" | "updated_at">>;
			const at = now();
			const stamped = rows.map(row => {
				const ageMs = at - row.updated_at;
				return [row.provider_id, row.content_fingerprint, Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs];
			});
			const revision = db.query("SELECT value FROM model_cache_meta WHERE key = 'revision'").get() as {
				value: number;
			} | null;
			return createHash("sha256")
				.update(JSON.stringify({ revision: revision?.value ?? 0, rows: stamped }))
				.digest("hex");
		});
	} catch {
		return "unreadable";
	}
}
