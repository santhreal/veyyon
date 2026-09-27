/**
 * The sign-in one trial runs with: a copy of the runner's credential store holding the model
 * provider's rows and nothing else.
 *
 * The trial's tools can read its credential directory, and run code can print what it reads, so a
 * trial never sees another provider's token, the usage history or the cache. The store is pruned
 * once per run and provider; each trial writes its own copy from that and the copy is deleted when
 * the trial ends. An access token that would expire before a trial's deadline is refreshed in the
 * runner's store first, so the trial never refreshes, and never rotates, a token in a copy alone.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { errorMessage, isRecord, logger, tryParseJson } from "@veyyon/utils";
import { AUTH_DB_SOURCES } from "../../engine/auth/preflight";
import { snapshotCredentialStore } from "../../engine/auth/seed";

/**
 * The store trials copy from: the one a run names (`--auth-db`, or `authDb` from a caller that
 * builds the options itself), else the first of the runner's own that exists.
 */
export function credentialSource(options: Readonly<Record<string, unknown>> | undefined): string | null {
	const named = options?.authDb ?? options?.["auth-db"];
	if (typeof named === "string" && named.length > 0) return path.resolve(named);
	return AUTH_DB_SOURCES.find(candidate => fs.existsSync(candidate)) ?? null;
}

/** Signed-in rows the store holds for `provider`. */
export function providerCredentialCount(source: string, provider: string): number {
	const db = new Database(source, { readonly: true });
	try {
		const row = db
			.query<{ count: number }, [string]>(
				"SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL",
			)
			.get(provider);
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

/** Tables whose rows name no provider a trial needs: history and cache of every provider. */
const CLEARED_TABLES = ["cache", "usage_history", "usage_cost_history", "auth_account_names"] as const;

/** One provider's sign-in pruned from the runner's store, as the bytes every trial's copy is written from. */
export interface StagedCredentials {
	readonly bytes: Buffer;
	/** Epoch milliseconds the earliest OAuth access token in it expires; Infinity when none does. */
	readonly expires: number;
}

/** How long past a trial's deadline the access token in its copy must stay valid. */
export const REFRESH_MARGIN_MS = 10 * 60_000;

/** When each of `provider`'s active OAuth access tokens in `file` expires. */
function accessExpiries(file: string, provider: string): number[] {
	const db = new Database(file, { readonly: true });
	try {
		return db
			.query<{ data: string }, [string]>(
				"SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL",
			)
			.all(provider)
			.map(row => {
				const data = tryParseJson(row.data);
				return isRecord(data) && typeof data.expires === "number" ? data.expires : Number.POSITIVE_INFINITY;
			});
	} finally {
		db.close();
	}
}

/**
 * Refresh, in the runner's own store, each OAuth sign-in of `provider` whose access token expires
 * before `until`. A trial that refreshed its own copy rotated the refresh token in that copy alone,
 * which is deleted with the trial: the runner's store kept a refresh token the provider had retired,
 * and every later trial, and the runner's own sessions, failed to sign in. A refresh that fails is
 * left to the trial, which reports the refused sign-in as an infrastructure error.
 */
export async function refreshExpiringSignIns(source: string, provider: string, until: number): Promise<void> {
	if (!accessExpiries(source, provider).some(expires => expires < until)) return;
	const store = await SqliteAuthCredentialStore.open(source);
	try {
		const storage = new AuthStorage(store);
		await storage.reload();
		for (const entry of storage.exportSnapshot().credentials) {
			const credential = entry.credential;
			if (entry.provider !== provider || credential.type !== "oauth" || credential.expires >= until) continue;
			await storage.forceRefreshCredentialById(entry.id).catch((error: unknown) => {
				logger.warn("local-cli could not refresh a sign-in before staging it", {
					provider,
					id: entry.id,
					error: errorMessage(error),
				});
			});
		}
	} finally {
		store.close();
	}
}

/**
 * `provider`'s sign-in pruned from `source`: its credential rows and nothing else, the history and
 * cache of every provider cleared. The work file is made under `workDir` and removed.
 */
export async function stageCredentials(source: string, provider: string, workDir: string): Promise<StagedCredentials> {
	const file = path.join(workDir, `staging-${randomUUID()}.db`);
	try {
		snapshotCredentialStore(source, file);
		const db = new Database(file);
		try {
			const tables = new Set(
				db
					.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all()
					.map(row => row.name),
			);
			db.run("DELETE FROM auth_credentials WHERE provider <> ?", [provider]);
			for (const table of ["auth_credential_blocks", "auth_credential_refresh_leases"]) {
				if (tables.has(table)) {
					db.run(`DELETE FROM ${table} WHERE credential_id NOT IN (SELECT id FROM auth_credentials)`);
				}
			}
			if (tables.has("auth_provider_selection")) {
				db.run("DELETE FROM auth_provider_selection WHERE provider <> ?", [provider]);
			}
			for (const table of CLEARED_TABLES) {
				if (tables.has(table)) db.run(`DELETE FROM ${table}`);
			}
			// The deleted rows stay in free pages until the file is rewritten.
			db.run("VACUUM");
		} finally {
			db.close();
		}
		return { bytes: await fsp.readFile(file), expires: Math.min(...accessExpiries(file, provider)) };
	} finally {
		for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(`${file}${suffix}`, { force: true });
	}
}

/** Write `<agentDir>/agent.db` from `staged`, readable by the owner alone. */
export async function writeStagedCredentials(staged: StagedCredentials, agentDir: string): Promise<void> {
	await fsp.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await fsp.writeFile(path.join(agentDir, "agent.db"), staged.bytes, { mode: 0o600 });
}
