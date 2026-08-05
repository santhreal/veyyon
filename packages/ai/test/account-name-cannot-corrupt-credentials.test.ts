/**
 * Naming an account must be incapable of costing the user a login.
 *
 * A rename is the one credential operation a user will do casually and repeatedly, from a
 * text prompt, possibly with a paste that carries odd bytes. If names lived in the
 * credential blob, every rename would be a read-modify-write of the row that holds the
 * refresh token, and a serialization mistake would log the account out. This file is the
 * gate on the design decision that prevents that: names live in `auth_account_names`, and
 * `auth_credentials` is not touched at all.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-name-corruption";
const HOUR_MS = 60 * 60_000;
const EXPIRES_AT = 1_760_000_000_000 + HOUR_MS;
/** Deliberately hostile: quotes, a backslash, a brace and non-ASCII, all JSON-significant. */
const HOSTILE_NAME = 'work "main" \\ {tokens: 1} · Mükund';

interface RawCredentialRow {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	identity_key: string | null;
	disabled_cause: string | null;
}

function readCredentialRows(dbPath: string): RawCredentialRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, provider, credential_type, data, identity_key, disabled_cause FROM auth_credentials ORDER BY id",
			)
			.all() as RawCredentialRow[];
		return rows;
	} finally {
		db.close();
	}
}

function readNameRows(dbPath: string): Array<{ identity: string; name: string }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT identity, name FROM auth_account_names ORDER BY identity").all() as Array<{
			identity: string;
			name: string;
		}>;
	} finally {
		db.close();
	}
}

describe("setAccountName leaves the credential row untouched", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let credentialId = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-name-corruption-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-token-bytes",
				refresh: "refresh-token-bytes",
				expires: EXPIRES_AT,
				accountId: "account-corruption",
				email: "corruption@example.com",
				orgId: "org-corruption",
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
	 * The corruption gate proper. Every column of the credential row is compared before and
	 * after the rename, including the serialized `data` blob that holds the refresh token: a
	 * rename that rewrote the row even identically would mean the write path exists and could
	 * one day write something wrong.
	 */
	test("every column of the credential row is byte-identical after a rename", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const before = readCredentialRows(dbPath);
		expect(before).toHaveLength(1);

		expect(storage.setAccountName(PROVIDER, credentialId, HOSTILE_NAME)).toBe(true);

		expect(readCredentialRows(dbPath)).toEqual(before);
	});

	/**
	 * The name must not be anywhere inside the credential payload. Asserted against the raw
	 * `data` text rather than the parsed credential, because the failure being prevented is a
	 * name smuggled into an unmodelled field that a typed read would never surface.
	 */
	test("the credential payload does not contain the name string at all", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId, HOSTILE_NAME)).toBe(true);

		const row = readCredentialRows(dbPath)[0];
		if (!row) throw new Error("credential row disappeared");
		expect(row.data).not.toContain(HOSTILE_NAME);
		expect(row.data).not.toContain("Mükund");
		expect(row.data).not.toContain("work");
	});

	/**
	 * The credential still reads back with the exact token bytes, expiry and identity it was
	 * stored with. This is the user-visible half of the same contract: an intact-looking row
	 * that deserialized to a different access token would still be a lost login.
	 *
	 * Re-read from the store rather than from the live object's cache. A rename that wrote to
	 * `auth_credentials` without refreshing memory would leave the in-process copy pristine and
	 * the damage invisible until the next launch, which is precisely how this class of bug
	 * reaches a user.
	 */
	test("the stored credential still carries its original token bytes, expiry and identity", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId, HOSTILE_NAME)).toBe(true);
		await storage.reload();

		const stored = storage.listStoredCredentials(PROVIDER);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toEqual({
			type: "oauth",
			access: "access-token-bytes",
			refresh: "refresh-token-bytes",
			expires: EXPIRES_AT,
			accountId: "account-corruption",
			email: "corruption@example.com",
			orgId: "org-corruption",
		});
		expect(storage.getOAuthAccountIdentity(PROVIDER)).toEqual({
			accountId: "account-corruption",
			email: "corruption@example.com",
			orgId: "org-corruption",
		});
	});

	/**
	 * The name went somewhere: exactly one row in the names table, keyed by the account's
	 * identity rather than its row id, holding the string verbatim. Without this the two
	 * tests above would also pass if `setAccountName` had quietly done nothing.
	 */
	test("the name lands in auth_account_names keyed by account identity", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(storage.setAccountName(PROVIDER, credentialId, HOSTILE_NAME)).toBe(true);

		expect(readNameRows(dbPath)).toEqual([
			{ identity: `${PROVIDER}|account:account-corruption`, name: HOSTILE_NAME },
		]);
		expect(storage.getAccountName(PROVIDER, credentialId)).toBe(HOSTILE_NAME);
	});
});
