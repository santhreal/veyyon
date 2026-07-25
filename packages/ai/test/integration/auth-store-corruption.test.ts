import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../../utils/src/temp";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";

/**
 * Corruption contracts for the credential store — the file whose failure the
 * user experiences as "I got logged out".
 *
 * The rule that shapes every assertion here: a corrupt store must FAIL LOUDLY,
 * never quietly present as an EMPTY store. Those two outcomes are
 * indistinguishable to the caller, and the empty one is by far the more
 * damaging: the app concludes there are no credentials, tells the user to log
 * in again, and the fresh login then writes over a file that still contained
 * recoverable tokens. A loud failure keeps the bytes on disk and keeps the
 * recovery option open. This is Law 10 applied to the exact surface that
 * produced this session's logout bug.
 *
 * Every test operates on a disposable temp path, checked through
 * `guardDestructivePath`, because these tests deliberately write garbage over
 * credential databases.
 */
describe("a corrupt credential store fails loudly instead of looking logged out", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-authc-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** A disposable db path, proven safe before we corrupt it. */
	function dbPath(name = "agent.db"): string {
		return guardDestructivePath(path.join(tempDir, name), "auth-store-corruption");
	}

	/** Create a real store holding one OAuth credential, then close it. */
	async function seedStore(target: string, refresh = "refresh-token"): Promise<void> {
		const store = await SqliteAuthCredentialStore.open(target);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: "access-token", refresh, expires: Date.now() + 3_600_000 },
			]);
		} finally {
			store.close();
		}
	}

	test("AUTHC-1: a store of garbage bytes throws `file is not a database`, never an empty credential list", async () => {
		const target = dbPath();
		fs.writeFileSync(target, "this is not a sqlite database at all, it is plain garbage\n".repeat(50));

		// Asserted as the EXACT contract, not "either throws or returns something":
		// a tolerant assertion here would still pass on the one outcome that matters
		// (a clean empty list), which is indistinguishable from "logged out" and would
		// make the next login overwrite a recoverable file.
		let store: SqliteAuthCredentialStore | undefined;
		let openError: unknown;
		try {
			store = await SqliteAuthCredentialStore.open(target);
		} catch (error) {
			openError = error;
		}
		try {
			expect(openError).toBeDefined();
			expect(String(openError)).toMatch(/file is not a database/i);
			// Nothing was opened, so nothing could have reported an empty login set.
			expect(store).toBeUndefined();
		} finally {
			store?.close();
		}
	});

	test("AUTHC-2: a truncated store still yields the stored credential, never a silent empty list", async () => {
		const target = dbPath();
		await seedStore(target, "survivor-refresh");
		const full = fs.readFileSync(target);
		expect(full.length).toBeGreaterThan(0);
		// Cut the file in half: a valid header with a severed body.
		fs.writeFileSync(target, full.subarray(0, Math.floor(full.length / 2)));

		let store: SqliteAuthCredentialStore | undefined;
		let openError: unknown;
		try {
			store = await SqliteAuthCredentialStore.open(target);
		} catch (error) {
			openError = error;
		}

		try {
			// Observed contract: SQLite recovers the leading pages, so the credential is
			// still there. The forbidden outcome is opening cleanly and reporting zero
			// credentials, which the user experiences as being logged out.
			expect(openError).toBeUndefined();
			const rows = store?.listAuthCredentials("anthropic") ?? [];
			expect(rows).toHaveLength(1);
			const credential = rows[0]?.credential;
			expect(credential?.type).toBe("oauth");
			if (credential?.type === "oauth") {
				// The exact token, not merely "something": a recovery that returns a
				// mangled credential is corruption wearing a success mask.
				expect(credential.refresh).toBe("survivor-refresh");
			}
		} finally {
			store?.close();
		}
	});

	test("AUTHC-3: a zero-byte store is a legitimate FRESH store, not corruption", async () => {
		const target = dbPath();
		fs.writeFileSync(target, "");

		// SQLite treats an empty file as a new database; treating this as corruption
		// would break every genuine first run.
		const store = await SqliteAuthCredentialStore.open(target);
		try {
			expect(store.listAuthCredentials()).toEqual([]);
			// And it must be usable, not just openable.
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			]);
			expect(store.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("AUTHC-5: one row with a corrupt payload must not take the other credentials down with it", async () => {
		const target = dbPath();
		const store = await SqliteAuthCredentialStore.open(target);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 },
			]);
			store.replaceAuthCredentialsForProvider("openai", [
				{ type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 3_600_000 },
			]);
		} finally {
			store.close();
		}

		// Corrupt exactly one row's payload, leaving the database structurally valid.
		const { Database } = await import("bun:sqlite");
		const db = new Database(target);
		try {
			db.prepare("UPDATE auth_credentials SET data = ? WHERE provider = ?").run("{not valid json", "anthropic");
		} finally {
			db.close();
		}

		const reopened = await SqliteAuthCredentialStore.open(target);
		try {
			// The healthy credential must still be reachable. Losing every login because
			// one row rotted would turn a single bad record into a full logout.
			const openai = reopened.listAuthCredentials("openai");
			expect(openai).toHaveLength(1);
			expect(openai[0]?.credential.type).toBe("oauth");
		} finally {
			reopened.close();
		}
	});

	test("AUTHC-6: concurrent writers must not lose a credential", async () => {
		const target = dbPath();
		const providers = ["anthropic", "openai", "google", "groq", "mistral", "cohere", "xai", "deepseek"];

		// Independent connections, like independent processes racing at startup.
		const stores = await Promise.all(providers.map(() => SqliteAuthCredentialStore.open(target)));
		try {
			await Promise.all(
				providers.map(async (provider, index) => {
					const store = stores[index];
					if (!store) throw new Error("missing store handle");
					store.replaceAuthCredentialsForProvider(provider, [
						{
							type: "oauth",
							access: `access-${provider}`,
							refresh: `refresh-${provider}`,
							expires: Date.now() + 3_600_000,
						},
					]);
				}),
			);

			// Every provider must be present exactly once, with its own token: a lost
			// write here is a credential the user has to re-authenticate.
			const first = stores[0];
			if (!first) throw new Error("missing store handle");
			for (const provider of providers) {
				const rows = first.listAuthCredentials(provider);
				expect(rows).toHaveLength(1);
				const credential = rows[0]?.credential;
				expect(credential?.type).toBe("oauth");
				if (credential?.type === "oauth") {
					expect(credential.refresh).toBe(`refresh-${provider}`);
				}
			}
		} finally {
			for (const store of stores) store.close();
		}
	});

	test("AUTHC-7: the credential database is not world-readable", async () => {
		if (process.platform === "win32") return;
		const target = dbPath();
		await seedStore(target);

		// A credential store readable by other users on the machine is a security
		// defect regardless of what the app does with it.
		const mode = fs.statSync(target).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	});
});
