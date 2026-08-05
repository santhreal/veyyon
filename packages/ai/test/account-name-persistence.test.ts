/**
 * A name the user typed must come back exactly as they typed it.
 *
 * `/account name <text>` is the one place in the account manager where the user authors
 * content rather than picking from a list, so the round trip is the whole contract: the
 * bytes stored are the bytes returned, spaces and non-ASCII included, and clearing is a real
 * delete rather than an empty string that would render as a blank label next to accounts
 * that honestly have no name.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-account-name";
const HOUR_MS = 60 * 60_000;

function countNameRows(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS total FROM auth_account_names").get() as
			| { total?: number }
			| undefined;
		return typeof row?.total === "number" ? row.total : -1;
	} finally {
		db.close();
	}
}

function storedNameBytes(dbPath: string): string | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT name FROM auth_account_names").get() as { name?: string } | undefined;
		return row?.name;
	} finally {
		db.close();
	}
}

describe("AuthStorage account names round-trip", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let credentialId = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-name-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-only",
				refresh: "refresh-only",
				expires: Date.now() + HOUR_MS,
				accountId: "account-only",
				email: "only@example.com",
			},
		]);
		credentialId = authStorage.listStoredCredentials(PROVIDER)[0]!.id;
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/**
	 * Names are display text, not identifiers: people write "work laptop" and their own
	 * alphabet. A store that normalized, slugged, or transcoded would silently rewrite what
	 * the user typed, and they would only notice by reading the label back.
	 */
	test("stores a name containing spaces and non-ASCII and returns the identical string", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const name = "работа · Mükund's Max 20x";

		expect(storage.setAccountName(PROVIDER, credentialId, name)).toBe(true);

		expect(storage.getAccountName(PROVIDER, credentialId)).toBe(name);
	});

	/**
	 * Surrounding whitespace is a typo, not content: `/account name  work ` must not produce a
	 * label that renders with a leading gap and sorts apart from `work`.
	 *
	 * Asserted against the bytes in `auth_account_names`, not against `getAccountName`. The
	 * read path trims too, so a write path that stored the padding would still round-trip
	 * clean through this API and only leak to the other readers of that table. Trimming has to
	 * happen before the row is written, and only the raw row can prove it did.
	 */
	test("stores the trimmed bytes, keeping interior spacing, rather than trimming on read", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId, "   work  laptop   ")).toBe(true);

		expect(storedNameBytes(dbPath)).toBe("work  laptop");
		expect(storage.getAccountName(PROVIDER, credentialId)).toBe("work  laptop");
	});

	/**
	 * The empty name is the documented way to remove a name, and it has to DELETE. Storing
	 * `""` would make `getAccountName` return a falsy-but-present value, and the display
	 * ladder distinguishes "named" from "not named" precisely to keep the invitation to set
	 * one visible; an empty row turns that into a blank label with no explanation.
	 */
	test("an empty name clears the row rather than storing an empty string", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		expect(storage.setAccountName(PROVIDER, credentialId, "work")).toBe(true);
		expect(countNameRows(dbPath)).toBe(1);

		expect(storage.setAccountName(PROVIDER, credentialId, "")).toBe(true);

		expect(storage.getAccountName(PROVIDER, credentialId)).toBeUndefined();
		expect(countNameRows(dbPath)).toBe(0);
	});

	/** Whitespace-only input is the same user intent as empty, so it clears too. */
	test("a whitespace-only name clears the row", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		expect(storage.setAccountName(PROVIDER, credentialId, "work")).toBe(true);

		expect(storage.setAccountName(PROVIDER, credentialId, "   ")).toBe(true);

		expect(storage.getAccountName(PROVIDER, credentialId)).toBeUndefined();
		expect(countNameRows(dbPath)).toBe(0);
	});

	/**
	 * Naming a credential that does not exist must report failure, not succeed silently: the
	 * caller's only way to tell the user "there is no such account" is this boolean, and a
	 * name written against a phantom id would sit in the table forever.
	 */
	test("refuses to name an unknown credential id", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId + 5_000, "ghost")).toBe(false);

		expect(countNameRows(dbPath)).toBe(0);
		expect(storage.getAccountName(PROVIDER, credentialId + 5_000)).toBeUndefined();
	});

	/**
	 * Renaming replaces, never accumulates. A second row for the same identity would make
	 * which name wins depend on table order.
	 */
	test("renaming overwrites the existing row instead of adding one", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId, "first")).toBe(true);
		expect(storage.setAccountName(PROVIDER, credentialId, "second")).toBe(true);

		expect(storage.getAccountName(PROVIDER, credentialId)).toBe("second");
		expect(countNameRows(dbPath)).toBe(1);
	});
});
