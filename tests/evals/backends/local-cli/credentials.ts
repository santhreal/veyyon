/**
 * The sign-in one trial runs with: a copy of the runner's credential store holding the model
 * provider's rows and nothing else.
 *
 * The trial's tools can read its credential directory, and run code can print what it reads, so a
 * trial never sees another provider's token, the usage history or the cache. The copy is made per
 * trial and deleted when the trial ends. A token the provider rotates during a trial is written to
 * the copy only.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
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

/** Write `<agentDir>/agent.db` holding only `provider`'s credentials, readable by the owner alone. */
export function stageCredentials(source: string, provider: string, agentDir: string): void {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const destination = path.join(agentDir, "agent.db");
	snapshotCredentialStore(source, destination);
	fs.chmodSync(destination, 0o600);
	const db = new Database(destination);
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
}
