/**
 * A pin must never outlive the account it names, and must outlive the process.
 *
 * Two failure modes, opposite directions, same feature. A pin that survives the credential
 * being deleted is a dangling id that re-resolves to nothing on every request; a pin that
 * does not survive a restart is a switch the user made and the tool forgot. This file pins
 * the refusal, the drop, and the durability so neither direction can regress unnoticed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-pin-lifecycle";
const HOUR_MS = 60 * 60_000;
const SESSION_ID = "session-lifecycle";

describe("session credential pin lifecycle", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-pin-lifecycle-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedTwoAccounts(storage: AuthStorage): Promise<[number, number]> {
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-first",
				refresh: "refresh-first",
				expires: Date.now() + HOUR_MS,
				accountId: "account-first",
				email: "first@example.com",
			},
			{
				type: "oauth",
				access: "access-second",
				refresh: "refresh-second",
				expires: Date.now() + HOUR_MS,
				accountId: "account-second",
				email: "second@example.com",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		return [rows[0]!.id, rows[1]!.id];
	}

	/** Close the live handle and open a fresh store plus storage over the same file. */
	async function reopen(): Promise<AuthStorage> {
		store?.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		const reopened = new AuthStorage(store);
		await reopened.reload();
		authStorage = reopened;
		return reopened;
	}

	/**
	 * Recording a pin the resolver cannot honor is worse than refusing: nothing surfaces,
	 * the manager shows a pin, and every request quietly resolves elsewhere. The boolean is
	 * the caller's only chance to tell the user the switch did not happen.
	 */
	test("refuses an unknown credential id and records nothing", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await seedTwoAccounts(storage);
		const unknownId = 987_654;

		const bearerBefore = await storage.getApiKey(PROVIDER, SESSION_ID);
		const routingBefore = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, unknownId)).toBe(false);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(bearerBefore);
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION_ID)).toEqual(routingBefore);
		expect(routingBefore?.pinnedCredentialId).toBeUndefined();
	});

	/**
	 * Logging an account out while it is pinned is an ordinary thing to do. The pin has to be
	 * dropped rather than honored, because the recorded id is an integer that a later
	 * credential could be handed by AUTOINCREMENT reuse, and honoring a stale one routes the
	 * session to somebody else's account.
	 */
	test("drops a pin whose credential was removed and resolves to a live account", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage);

		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-second");

		expect(await storage.removeCredential(PROVIDER, secondId)).toBe(true);

		expect(storage.sessionCredentialRouting(PROVIDER, SESSION_ID)?.pinnedCredentialId).toBeUndefined();
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-first");
		expect(storage.getOAuthAccountIdentity(PROVIDER, SESSION_ID)).toEqual({
			accountId: "account-first",
			email: "first@example.com",
		});
		expect(storage.listStoredCredentials(PROVIDER).map(row => row.id)).toEqual([firstId]);
	});

	/**
	 * The pin is written to the store, not only to process memory: a user who picks an
	 * account and then restarts must still be on it. Proven over a genuinely fresh
	 * `AuthStorage` on a reopened database, because an in-process object would pass this
	 * from its own map without ever having persisted anything.
	 */
	test("a pin survives a fresh AuthStorage over the same database", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const [, secondId] = await seedTwoAccounts(authStorage);
		expect(authStorage.pinSessionCredential(PROVIDER, SESSION_ID, secondId)).toBe(true);

		const reopened = await reopen();

		expect(reopened.sessionCredentialRouting(PROVIDER, SESSION_ID)?.pinnedCredentialId).toBe(secondId);
		expect(await reopened.getApiKey(PROVIDER, SESSION_ID)).toBe("access-second");
		expect(reopened.getOAuthAccountIdentity(PROVIDER, SESSION_ID)).toEqual({
			accountId: "account-second",
			email: "second@example.com",
		});
	});

	/**
	 * Clearing has to be as durable as setting. A clear that only emptied the in-memory map
	 * would resurrect the pin on the next launch, which reads to the user as the tool
	 * overriding a choice they just undid.
	 *
	 * The routing record is compared whole rather than by one field: after a clear, the
	 * session keeps running on the account it last used (that is stickiness, not a pin), so
	 * the observable difference between a cleared pin and a surviving one is the PRESENCE of
	 * `pinnedCredentialId`, and only an exact comparison catches it coming back.
	 */
	test("clearSessionCredentialPin removes the pin durably", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const [, secondId] = await seedTwoAccounts(authStorage);
		expect(authStorage.pinSessionCredential(PROVIDER, SESSION_ID, secondId)).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-second");

		authStorage.clearSessionCredentialPin(PROVIDER, SESSION_ID);

		const reopened = await reopen();
		expect(reopened.sessionCredentialRouting(PROVIDER, SESSION_ID)).toEqual({
			provider: PROVIDER,
			activeCredentialId: secondId,
		});
	});
});
