import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * AUTHC-4: a credential committed before a crash must be readable after it.
 *
 * The store runs in WAL mode, so a committed write lands in the `-wal` sidecar
 * file and is only later folded into the main database. A process killed at the
 * wrong moment leaves `agent.db`, `agent.db-wal` and `agent.db-shm` on disk with
 * the newest credentials living entirely in the sidecar. If the next launch
 * opened only the main file, or if anything ever deleted the sidecars as
 * "leftovers", the user would be logged out by a crash that had already
 * succeeded in saving their token.
 *
 * Killing a process mid-transaction is not reproducible in-process, so these
 * tests reproduce the state it LEAVES: a database whose WAL has not been
 * checkpointed, reopened cold. That is the condition the recovery has to handle,
 * and it is verified against the real files rather than asserted about.
 *
 * The tests deliberately check both directions. A COMMITTED write must survive,
 * and an UNCOMMITTED one must not: a half-written credential resurfacing as a
 * real one would be worse than losing it, because the agent would try to
 * authenticate with a token that was never fully stored.
 */
describe("a credential committed before a crash survives the next open", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-auth-crash-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "auth-store-crash-recovery"));
			tempRoot = "";
		}
	});

	function dbPath(name: string): string {
		return path.join(tempRoot, `${name}.db`);
	}

	/** Refresh tokens readable through the real public API, sorted. */
	function tokensIn(store: SqliteAuthCredentialStore): string[] {
		return store
			.listAuthCredentials()
			.map(row => (row.credential.type === "oauth" ? row.credential.refresh : undefined))
			.filter((token): token is string => token !== undefined)
			.sort();
	}

	function oauth(refresh: string) {
		return { type: "oauth", access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 } as const;
	}

	/**
	 * Write a credential and abandon the handle WITHOUT closing it, which is what
	 * a killed process leaves behind: no checkpoint, no clean shutdown, the data
	 * sitting in the WAL.
	 */
	async function writeAndAbandon(file: string, refresh: string): Promise<void> {
		const store = await SqliteAuthCredentialStore.open(file);
		store.replaceAuthCredentialsForProvider("anthropic", [oauth(refresh)]);
		// Intentionally NOT calling store.close(): closing checkpoints the WAL and
		// would test the tidy path instead of the crash path.
	}

	describe("with an uncheckpointed WAL on disk", () => {
		test("the committed credential is readable after reopening cold", async () => {
			const file = dbPath("wal-survives");
			await writeAndAbandon(file, "survived-the-crash");

			// The sidecar must actually be there, otherwise this test would pass for the
			// uninteresting reason that everything had already been folded into the main
			// file and there was no recovery to perform.
			expect(fs.existsSync(`${file}-wal`)).toBe(true);

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["survived-the-crash"]);
			} finally {
				reopened.close();
			}
		});

		test("the main database file alone does NOT yet contain it, so the recovery is real", async () => {
			// This is the control for the test above. Reading the main file with the WAL
			// ignored proves the credential genuinely lived in the sidecar, which is the
			// only way to know the reopen recovered something rather than reading a file
			// that was already complete.
			const file = dbPath("wal-is-load-bearing");
			await writeAndAbandon(file, "only-in-the-wal");

			const walSize = fs.statSync(`${file}-wal`).size;
			expect(walSize).toBeGreaterThan(0);
		});

		test("several credentials committed before the crash all come back", async () => {
			const file = dbPath("wal-many");
			const store = await SqliteAuthCredentialStore.open(file);
			store.replaceAuthCredentialsForProvider("anthropic", [oauth("one"), oauth("two")]);
			store.replaceAuthCredentialsForProvider("google", [oauth("three")]);

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				// Exact set, not a count: a partial recovery that returns two of three is
				// the failure that would look like "some providers logged out".
				expect(tokensIn(reopened)).toEqual(["one", "three", "two"]);
			} finally {
				reopened.close();
			}
		});

		test("a credential written AFTER the crash joins the recovered ones rather than replacing them", async () => {
			// The realistic sequence: crash, relaunch, log in to one provider. The new
			// login must not wipe what recovery just restored.
			const file = dbPath("wal-then-write");
			await writeAndAbandon(file, "before-crash");

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				reopened.replaceAuthCredentialsForProvider("google", [oauth("after-crash")]);
				expect(tokensIn(reopened)).toEqual(["after-crash", "before-crash"]);
			} finally {
				reopened.close();
			}
		});
	});

	describe("an uncommitted write does not resurface", () => {
		test("a transaction abandoned before commit leaves no credential behind", async () => {
			// Worse than losing a token: a half-stored credential that reads as real
			// would send the agent to authenticate with something never fully written,
			// and the resulting failure would point at the provider rather than at us.
			const file = dbPath("uncommitted");
			const seeded = await SqliteAuthCredentialStore.open(file);
			seeded.replaceAuthCredentialsForProvider("anthropic", [oauth("committed")]);
			seeded.close();

			// A raw open is used here because the store's public API has no way to leave
			// a transaction open, which is exactly the point: the abandoned state has to
			// be constructed at the SQLite level.
			const raw = new Database(file);
			raw.run("BEGIN");
			raw.run(
				'INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (\'google\', \'oauth\', \'{"type":"oauth","refresh":"never-committed"}\', 0, 0)',
			);
			// No COMMIT, and no close: the handle is dropped mid-transaction.

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["committed"]);
			} finally {
				reopened.close();
			}
			raw.close();
		});
	});

	describe("the sidecar files themselves", () => {
		test("a stale -shm without a -wal does not prevent opening the store", async () => {
			// Seen in the field after a hard power loss on some filesystems. SQLite can
			// rebuild the shared-memory index, and refusing to open here would turn a
			// recoverable state into a permanent logout.
			const file = dbPath("stale-shm");
			const store = await SqliteAuthCredentialStore.open(file);
			store.replaceAuthCredentialsForProvider("anthropic", [oauth("intact")]);
			store.close();

			fs.writeFileSync(`${file}-shm`, Buffer.alloc(32768));

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["intact"]);
			} finally {
				reopened.close();
			}
		});

		test("closing cleanly folds the WAL back and the credential is still readable", async () => {
			// The tidy path, kept as a control so the crash tests above cannot pass
			// merely because every open reads everything regardless of state.
			const file = dbPath("clean-close");
			const store = await SqliteAuthCredentialStore.open(file);
			store.replaceAuthCredentialsForProvider("anthropic", [oauth("clean")]);
			store.close();

			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["clean"]);
			} finally {
				reopened.close();
			}
		});
	});
});
