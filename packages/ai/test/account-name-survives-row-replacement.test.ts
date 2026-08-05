/**
 * A name must survive the two events that replace the credential row underneath it.
 *
 * This is the entire reason `resolveAccountNameIdentity` keys names by ACCOUNT IDENTITY
 * (email / account uuid / project / org) instead of by the sqlite row id. Both events below
 * are routine — a token refresh rewrites the row's payload, and logging out and back in
 * deletes the row and inserts a new one with a new id — and both would silently blank the
 * user's label under row-id keying. Silently is the problem: nothing errors, the manager
 * just shows the raw email again and the user has no way to know why.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-name-identity";
const HOUR_MS = 60 * 60_000;
const ACCOUNT_NAME = "work laptop";

function readCredentialPayloads(dbPath: string): Array<{ id: number; data: string }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT id, data FROM auth_credentials ORDER BY id").all() as Array<{
			id: number;
			data: string;
		}>;
	} finally {
		db.close();
	}
}

describe("account names are keyed by identity, not by credential row", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let originalId = 0;

	const originalCredential: OAuthCredential = {
		type: "oauth",
		access: "access-original",
		refresh: "refresh-original",
		expires: Date.now() + HOUR_MS,
		accountId: "account-stable",
		email: "stable@example.com",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-name-identity-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.set(PROVIDER, [originalCredential]);
		originalId = authStorage.listStoredCredentials(PROVIDER)[0]!.id;
		expect(authStorage.setAccountName(PROVIDER, originalId, ACCOUNT_NAME)).toBe(true);
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
	 * The re-login case: the user logs the account out and signs in again to the SAME
	 * account, so the row id changes but the identity does not. Under row-id keying the name
	 * is orphaned against a dead id; under identity keying it is found immediately, with no
	 * migration step and nothing for the user to redo.
	 */
	test("a name is still found after a logout and fresh login replaces the row with a new id", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		expect(await storage.removeCredential(PROVIDER, originalId)).toBe(true);
		storage.upsertCredential(PROVIDER, {
			type: "oauth",
			access: "access-after-relogin",
			refresh: "refresh-after-relogin",
			expires: Date.now() + 12 * HOUR_MS,
			accountId: "account-stable",
			email: "stable@example.com",
		});

		const rows = storage.listStoredCredentials(PROVIDER);
		expect(rows).toHaveLength(1);
		const replacedId = rows[0]!.id;
		// The row really was replaced; without this the test could pass on an update in place.
		expect(replacedId).not.toBe(originalId);
		expect(rows[0]?.credential).toMatchObject({ access: "access-after-relogin" });

		expect(storage.getAccountName(PROVIDER, replacedId)).toBe(ACCOUNT_NAME);
	});

	/**
	 * The refresh case: the row keeps its id but its payload is rewritten with new token
	 * bytes. A name stored inside that payload would be rewritten along with it, which is
	 * exactly what blob storage would have failed at, and the identity the name is keyed by
	 * must come through the rotation unchanged.
	 */
	test("a name survives a token refresh that rewrites the credential payload", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const payloadBefore = readCredentialPayloads(dbPath);
		expect(payloadBefore).toHaveLength(1);

		const result = await storage.refreshStoredOAuthCredential(PROVIDER, {
			forceRefresh: true,
			credentialFromRow: credential => credential,
			refresh: async () => ({
				access: "access-rotated",
				refresh: "refresh-rotated",
				expires: Date.now() + 12 * HOUR_MS,
			}),
		});

		expect(result.refreshed).toBe(true);
		expect(result.credential?.access).toBe("access-rotated");
		const payloadAfter = readCredentialPayloads(dbPath);
		expect(payloadAfter).toHaveLength(1);
		// Same row, genuinely rewritten bytes.
		expect(payloadAfter[0]?.id).toBe(originalId);
		expect(payloadAfter[0]?.data).not.toBe(payloadBefore[0]?.data);
		expect(payloadAfter[0]?.data).toContain("access-rotated");

		expect(storage.getAccountName(PROVIDER, originalId)).toBe(ACCOUNT_NAME);
	});

	/**
	 * The name belongs to ONE account, not to the provider. A second account added to the
	 * same provider must come back unnamed, so the manager can still offer to name it rather
	 * than showing two rows with the same label.
	 */
	test("a sibling account of the same provider does not inherit the name", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		storage.upsertCredential(PROVIDER, {
			type: "oauth",
			access: "access-sibling",
			refresh: "refresh-sibling",
			expires: Date.now() + HOUR_MS,
			accountId: "account-sibling",
			email: "sibling@example.com",
		});

		const rows = storage.listStoredCredentials(PROVIDER);
		expect(rows).toHaveLength(2);
		const siblingId = rows.find(row => row.id !== originalId)?.id;
		if (siblingId === undefined) throw new Error("sibling credential missing");

		expect(storage.getAccountName(PROVIDER, originalId)).toBe(ACCOUNT_NAME);
		expect(storage.getAccountName(PROVIDER, siblingId)).toBeUndefined();
	});
});
