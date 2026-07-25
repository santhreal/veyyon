import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * AUTHC-9: opening a credential store written by an OLDER veyyon must carry
 * every credential forward, unchanged.
 *
 * This is the upgrade-shaped route to the symptom this whole campaign exists
 * for. A user who updates and is asked to log in again does not care whether the
 * token was lost by a migration, a path change or a filter: it is the same
 * broken morning. The store has six schema versions and a chain of migrations
 * that rename and rebuild the credentials table, and each of those rebuilds is a
 * copy step that can silently drop rows or columns.
 *
 * The existing migration tests (`auth-storage-email-dedupe`,
 * `auth-storage-block-persistence`) exercise migrations as a side effect of
 * testing something else. This suite tests the migration itself, and it does so
 * the only way that proves anything: it hand-builds the OLD table shape with raw
 * SQL, writes real credentials into it, opens it with the real store, and reads
 * the tokens back through the real public API. Nothing is stubbed, because a
 * stub would be asserting that the test's idea of the old schema round-trips.
 *
 * The assertions are on exact token values rather than on row counts. A
 * migration that preserves the right NUMBER of rows while corrupting the JSON
 * payload presents to the user as a login prompt, which is indistinguishable
 * from the row having been dropped.
 */
describe("opening an older credential store preserves every credential", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-auth-migration-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "auth-schema-migration"));
			tempRoot = "";
		}
	});

	function dbPath(name: string): string {
		return path.join(tempRoot, `${name}.db`);
	}

	/** An OAuth credential payload, as the store serializes it into `data`. */
	function oauthData(refresh: string): string {
		return JSON.stringify({ type: "oauth", access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 });
	}

	/** An API-key credential payload. */
	function apiKeyData(key: string): string {
		return JSON.stringify({ key });
	}

	/**
	 * Build a database at the v0 table shape: no `disabled_cause`, no
	 * `identity_key`, no schema-version row. This is what the very first stores on
	 * disk look like, and it is the longest migration path available.
	 */
	function seedV0(file: string, rows: Array<{ provider: string; type: string; data: string; disabled?: number }>): void {
		const db = new Database(file);
		try {
			db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				);
			`);
			const insert = db.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 2000)",
			);
			for (const row of rows) insert.run(row.provider, row.type, row.data, row.disabled ?? 0);
			insert.finalize();
		} finally {
			db.close();
		}
	}

	/**
	 * Build a database at the v1 table shape: `disabled_cause` present,
	 * `identity_key` absent, and still no schema-version row, so the version has
	 * to be inferred from the columns.
	 */
	function seedV1(file: string, rows: Array<{ provider: string; type: string; data: string; cause?: string }>): void {
		const db = new Database(file);
		try {
			db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				);
			`);
			const insert = db.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 2000)",
			);
			for (const row of rows) insert.run(row.provider, row.type, row.data, row.cause ?? null);
			insert.finalize();
		} finally {
			db.close();
		}
	}

	/** Refresh tokens readable through the real public API, sorted. */
	function refreshTokensIn(store: SqliteAuthCredentialStore, provider?: string): string[] {
		return store
			.listAuthCredentials(provider)
			.map(row => (row.credential.type === "oauth" ? row.credential.refresh : undefined))
			.filter((token): token is string => token !== undefined)
			.sort();
	}

	/** Row ids in a store that has NOT been migrated yet, where most columns do not exist. */
	function idsBeforeMigration(file: string): number[] {
		const db = new Database(file, { readonly: true });
		try {
			return (db.query("SELECT id FROM auth_credentials ORDER BY id").all() as Array<{ id: number }>).map(
				row => row.id,
			);
		} finally {
			db.close();
		}
	}

	/** Every row in the raw table, including ones the public list filters out. */
	function rawRows(file: string): Array<{ id: number; provider: string; data: string; disabled_cause: string | null }> {
		const db = new Database(file, { readonly: true });
		try {
			return db.query("SELECT id, provider, data, disabled_cause FROM auth_credentials ORDER BY id").all() as Array<{
				id: number;
				provider: string;
				data: string;
				disabled_cause: string | null;
			}>;
		} finally {
			db.close();
		}
	}

	describe("from the oldest schema on disk (v0)", () => {
		test("every credential's exact token survives the whole migration chain", async () => {
			const file = dbPath("v0-tokens");
			seedV0(file, [
				{ provider: "anthropic", type: "oauth", data: oauthData("refresh-anthropic") },
				{ provider: "openai", type: "api_key", data: apiKeyData("sk-openai-key") },
				{ provider: "google", type: "oauth", data: oauthData("refresh-google") },
			]);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				// Exact tokens, not a count: a migration that keeps three rows while
				// mangling the JSON payload still presents to the user as a logout.
				expect(refreshTokensIn(store)).toEqual(["refresh-anthropic", "refresh-google"]);
				const openai = store.listAuthCredentials("openai");
				expect(openai).toHaveLength(1);
				expect(openai[0]?.credential.type === "api_key" ? openai[0].credential.key : "").toBe("sk-openai-key");
			} finally {
				store.close();
			}
		});

		test("a row flagged `disabled` becomes a disabled_cause rather than vanishing", async () => {
			// The v0 flag has to land somewhere the new schema can express, and the
			// choice matters: dropping the row would silently discard a credential the
			// user can still re-enable, and dropping the FLAG would silently re-arm a
			// credential that was disabled for a reason.
			const file = dbPath("v0-disabled");
			seedV0(file, [
				{ provider: "anthropic", type: "oauth", data: oauthData("live"), disabled: 0 },
				{ provider: "anthropic", type: "oauth", data: oauthData("retired"), disabled: 1 },
			]);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				// The public list filters disabled rows, which is exactly why the raw table
				// is checked too: "not listed" must not mean "not present".
				expect(refreshTokensIn(store)).toEqual(["live"]);
			} finally {
				store.close();
			}

			const rows = rawRows(file);
			expect(rows).toHaveLength(2);
			expect(rows[1]?.disabled_cause).toBe("disabled");
			expect(rows[1]?.data).toContain("retired");
		});

		test("row ids are preserved, so anything referencing a credential by id still resolves", async () => {
			// Blocks and refresh leases key off the credential id. Renumbering during a
			// table rebuild would silently detach them from their credential.
			const file = dbPath("v0-ids");
			seedV0(file, [
				{ provider: "anthropic", type: "oauth", data: oauthData("first") },
				{ provider: "anthropic", type: "oauth", data: oauthData("second") },
				{ provider: "openai", type: "api_key", data: apiKeyData("sk-third") },
			]);
			const before = idsBeforeMigration(file);

			const store = await SqliteAuthCredentialStore.open(file);
			store.close();

			expect(rawRows(file).map(row => row.id)).toEqual(before);
			expect(before).toEqual([1, 2, 3]);
		});
	});

	describe("from an intermediate schema (v1)", () => {
		test("credentials and their disabled causes both survive", async () => {
			const file = dbPath("v1-tokens");
			seedV1(file, [
				{ provider: "anthropic", type: "oauth", data: oauthData("kept") },
				{ provider: "anthropic", type: "oauth", data: oauthData("broken"), cause: "oauth refresh failed: 400" },
			]);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				expect(refreshTokensIn(store)).toEqual(["kept"]);
			} finally {
				store.close();
			}

			const rows = rawRows(file);
			// The cause text is carried verbatim: it is what the re-enable path matches on
			// to tell a refresh failure apart from a deliberate disable.
			expect(rows[1]?.disabled_cause).toBe("oauth refresh failed: 400");
		});

		test("identity keys are backfilled without disturbing the credential payload", async () => {
			// v1 has no identity_key. The backfill derives one, and it must do so without
			// rewriting `data`, since `data` is the credential itself.
			const file = dbPath("v1-identity");
			seedV1(file, [{ provider: "anthropic", type: "oauth", data: oauthData("payload-intact") }]);
			const dataBefore = rawRows(file)[0]?.data;

			const store = await SqliteAuthCredentialStore.open(file);
			store.close();

			expect(rawRows(file)[0]?.data).toBe(dataBefore ?? "");
		});
	});

	describe("the migration is safe to repeat", () => {
		test("opening the migrated store a second time changes nothing", async () => {
			// This runs on every launch, so a migration that is not idempotent corrupts a
			// perfectly good store on the boot AFTER the upgrade, which is far harder to
			// diagnose than failing during the upgrade itself.
			const file = dbPath("repeat");
			seedV0(file, [
				{ provider: "anthropic", type: "oauth", data: oauthData("stable") },
				{ provider: "openai", type: "api_key", data: apiKeyData("sk-stable") },
			]);

			const first = await SqliteAuthCredentialStore.open(file);
			first.close();
			const afterFirst = rawRows(file);

			const second = await SqliteAuthCredentialStore.open(file);
			try {
				expect(refreshTokensIn(second)).toEqual(["stable"]);
			} finally {
				second.close();
			}

			expect(rawRows(file)).toEqual(afterFirst);
		});

		test("the recorded schema version reaches current and stays there", async () => {
			const file = dbPath("version");
			seedV0(file, [{ provider: "anthropic", type: "oauth", data: oauthData("v") }]);

			const store = await SqliteAuthCredentialStore.open(file);
			store.close();

			const db = new Database(file, { readonly: true });
			try {
				const row = db.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as
					| { version: number }
					| undefined;
				// Pinned to the exact number: if the constant moves, a new migration step
				// was added and this suite must be extended to cover it rather than
				// silently continuing to test the old chain.
				expect(row?.version).toBe(6);
			} finally {
				db.close();
			}
		});

		test("the tables later versions introduced exist after migrating from v0", async () => {
			// v4 and v5 add the blocks and refresh-lease tables. A migration that skips
			// them leaves a store that reads fine and then throws on the first rate-limit
			// block or the first token refresh, which is a crash on the least convenient
			// code path there is.
			const file = dbPath("late-tables");
			seedV0(file, [{ provider: "anthropic", type: "oauth", data: oauthData("t") }]);

			const store = await SqliteAuthCredentialStore.open(file);
			store.close();

			const db = new Database(file, { readonly: true });
			try {
				const names = (
					db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
				).map(row => row.name);
				expect(names).toContain("auth_credentials");
				expect(names).toContain("auth_credential_blocks");
				expect(names).toContain("auth_credential_refresh_leases");
				// And the intermediate rename targets are gone rather than left as orphan
				// copies holding a second, diverging set of credentials.
				expect(names).not.toContain("auth_credentials_v0");
				expect(names).not.toContain("auth_credentials_legacy");
				expect(names).not.toContain("auth_credentials_v3");
			} finally {
				db.close();
			}
		});
	});

	describe("an empty or absent store is not mistaken for a migration", () => {
		test("a brand new file gets the current schema with no rows", async () => {
			const file = dbPath("fresh");
			const store = await SqliteAuthCredentialStore.open(file);
			try {
				expect(store.listAuthCredentials()).toEqual([]);
			} finally {
				store.close();
			}
			expect(rawRows(file)).toEqual([]);
		});

		test("an old-schema table with no rows migrates cleanly instead of erroring", async () => {
			// The realistic shape of a user who logged out before upgrading. It must not
			// turn an empty store into a failed launch.
			const file = dbPath("empty-v0");
			seedV0(file, []);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				expect(store.listAuthCredentials()).toEqual([]);
			} finally {
				store.close();
			}
		});
	});
});
