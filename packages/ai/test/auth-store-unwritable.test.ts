import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * AUTHC-8: when the credential store cannot be written, say so, and do not lose
 * what is already there.
 *
 * A read-only credential directory is a real state, not a contrived one. It
 * happens on a locked-down corporate image, on a container that mounts the home
 * directory read-only, after a `sudo` run leaves root-owned files behind, and on
 * a full disk. The failure mode that matters is not the write failing, it is the
 * write failing QUIETLY: the user logs in, sees no error, and is logged out
 * again on the next launch with nothing to explain it. That is Law 10 applied to
 * the most load-bearing file veyyon owns.
 *
 * Writing these tests turned up something worth stating plainly, because the
 * obvious expectation is wrong: making the credential DIRECTORY read-only does
 * not stop the store from working. A directory mode governs creating and
 * removing entries, so an existing `agent.db` stays writable inside it, and a
 * login on a locked-down image really does persist. Only a read-only FILE
 * refuses. Both are covered here, the first as measured behavior worth pinning
 * (a future change that starts creating a new file per write would silently
 * break exactly those users) and the second as the contract: it raises, and the
 * credential already stored is still readable once the mode is restored.
 *
 * That second half is what makes this more than an error-message test. A failed
 * write that also corrupts or truncates the existing store would be a worse
 * outcome than a clean refusal.
 *
 * These tests do not apply when the process can write anywhere regardless of
 * permissions, which is why they are skipped for root. Making them "pass" as
 * root would mean asserting nothing at all.
 */
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(RUNNING_AS_ROOT)("an unwritable credential store fails loudly and loses nothing", () => {
	let tempRoot = "";
	const restoreModes: Array<{ target: string; mode: number }> = [];

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-auth-unwritable-"));
	});

	afterEach(async () => {
		// Permissions are restored before cleanup, otherwise the temp tree could not
		// be removed and every later test would inherit the mess.
		for (const { target, mode } of restoreModes.splice(0)) {
			fs.chmodSync(target, mode);
		}
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "auth-store-unwritable"));
			tempRoot = "";
		}
	});

	/** Make `target` read-only, remembering how to put it back. */
	function makeReadOnly(target: string): void {
		const mode = fs.statSync(target).mode & 0o777;
		restoreModes.push({ target, mode });
		fs.chmodSync(target, 0o500);
	}

	function oauth(refresh: string) {
		return { type: "oauth", access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 } as const;
	}

	function tokensIn(store: SqliteAuthCredentialStore): string[] {
		return store
			.listAuthCredentials()
			.map(row => (row.credential.type === "oauth" ? row.credential.refresh : undefined))
			.filter((token): token is string => token !== undefined)
			.sort();
	}

	/** A store directory holding one already-saved credential, then closed. */
	async function seededStore(name: string, refresh: string): Promise<{ dir: string; file: string }> {
		const dir = path.join(tempRoot, name);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(file);
		store.replaceAuthCredentialsForProvider("anthropic", [oauth(refresh)]);
		store.close();
		return { dir, file };
	}

	describe("a read-only credential DIRECTORY still works, which is the good outcome", () => {
		/*
		 * These two pin measured behavior rather than a contract, and they are here
		 * because the obvious expectation is wrong in a way that would have produced
		 * a misleading test. A directory mode only governs creating and removing
		 * ENTRIES, so an existing `agent.db` remains writable inside a `r-x`
		 * directory. Verified: the write below lands and survives a reopen.
		 *
		 * That matters for real users on locked-down images: their login keeps
		 * working. It also means a future change that starts creating a new file per
		 * write (a rotating journal, a sidecar, a lock file) would silently break
		 * those users, and these tests are what would catch it.
		 */
		test("a login into an existing store succeeds even though the directory is read-only", async () => {
			const { dir, file } = await seededStore("readonly-dir", "already-saved");
			makeReadOnly(dir);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				store.replaceAuthCredentialsForProvider("google", [oauth("saved-anyway")]);
				expect(tokensIn(store)).toEqual(["already-saved", "saved-anyway"]);
			} finally {
				store.close();
			}
		});

		test("and the write is durable, not just visible to the session that made it", async () => {
			// The distinction that matters: a write held only in memory would read back
			// correctly right now and be gone on the next launch, which is exactly the
			// silent logout this campaign is about.
			const { dir, file } = await seededStore("readonly-dir-durable", "already-saved");
			makeReadOnly(dir);

			const store = await SqliteAuthCredentialStore.open(file);
			store.replaceAuthCredentialsForProvider("google", [oauth("saved-anyway")]);
			store.close();

			fs.chmodSync(dir, 0o700);
			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["already-saved", "saved-anyway"]);
			} finally {
				reopened.close();
			}
		});

		test("reading is unaffected, so a session is never killed by a read-only directory", async () => {
			const { dir, file } = await seededStore("readonly-reads", "still-readable");
			makeReadOnly(dir);

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(store)).toEqual(["still-readable"]);
			} finally {
				store.close();
			}
		});
	});

	describe("a read-only database FILE is the case that genuinely refuses", () => {
		test("a write raises rather than being dropped", async () => {
			// This is the state a `sudo` run leaves behind, and the one that would
			// otherwise produce the silent version of the bug: the login flow prints
			// "logged in", nothing lands on disk, and the next launch asks again.
			const { file } = await seededStore("readonly-file", "file-mode-token");
			makeReadOnly(file);

			let raised: unknown;
			try {
				const store = await SqliteAuthCredentialStore.open(file);
				try {
					store.replaceAuthCredentialsForProvider("google", [oauth("nope")]);
				} finally {
					store.close();
				}
			} catch (err) {
				raised = err;
			}
			expect(raised).toBeDefined();
			// The message has to point at the filesystem, since the fix is a chmod or a
			// different profile directory and nothing in the app can do it for the user.
			expect(String(raised)).toMatch(/readonly|read-only|unable to open|permission|SQLITE/i);
		});

		test("the stored credential survives the refused write", async () => {
			const { file } = await seededStore("readonly-file-preserves", "file-mode-token");
			makeReadOnly(file);

			await SqliteAuthCredentialStore.open(file)
				.then(store => {
					try {
						store.replaceAuthCredentialsForProvider("google", [oauth("nope")]);
					} finally {
						store.close();
					}
				})
				.catch(() => {});

			fs.chmodSync(file, 0o600);
			const reopened = await SqliteAuthCredentialStore.open(file);
			try {
				expect(tokensIn(reopened)).toEqual(["file-mode-token"]);
			} finally {
				reopened.close();
			}
		});
	});

	describe("the control", () => {
		test("the same write succeeds once the directory is writable", async () => {
			// Without this, every assertion above would also hold if the write path had
			// simply stopped working for an unrelated reason.
			const { file } = await seededStore("writable-control", "original");

			const store = await SqliteAuthCredentialStore.open(file);
			try {
				store.replaceAuthCredentialsForProvider("google", [oauth("saved-fine")]);
				expect(tokensIn(store)).toEqual(["original", "saved-fine"]);
			} finally {
				store.close();
			}
		});
	});
});
