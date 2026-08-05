/**
 * The one condition worth interrupting the user about: the account changed without them.
 *
 * `pinnedButRotated` answers "did a rate limit move this session off the account the user
 * picked?" and it must answer with BOTH rows, because the sentence the surfaces render names
 * them together — "pinned to work, rotated off it at 14:03 (usage limit)". Returning only the
 * serving row would present the substitution as the user's own choice, and returning
 * something while the pin is still serving would put a warning on a healthy session.
 *
 * Driven end to end from a real `AuthStorage`: pin, block, resolve, build. The predicate is
 * three lines, but what makes it correct is the inventory marks underneath it, and those are
 * only real once a genuine rate-limit rotation has happened.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { buildAccountInventory, pinnedButRotated } from "@veyyon/coding-agent/session/account-inventory";

const PROVIDER = "unit-rotated";
const SESSION_ID = "session-rotated";
const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 60 * 60_000;
const BLOCK_FOR_MS = 2 * HOUR_MS;

describe("pinnedButRotated", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let workId = 0;
	let personalId = 0;

	beforeEach(async () => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-personal",
				refresh: "refresh-personal",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-personal",
				email: "personal@example.com",
			},
			{
				type: "oauth",
				access: "access-work",
				refresh: "refresh-work",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-work",
				email: "work@example.com",
			},
		]);
		const rows = authStorage.listStoredCredentials(PROVIDER);
		personalId = rows[0]?.id ?? 0;
		workId = rows[1]?.id ?? 0;
		authStorage.setAccountName(PROVIDER, workId, "work");
		authStorage.setAccountName(PROVIDER, personalId, "personal");
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
	});

	/**
	 * A pin that is serving is not news. Reporting it would put a permanent "rotated off"
	 * warning under every deliberately switched account.
	 */
	test("returns undefined while the pinned account is the one serving", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, workId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-work");

		const inventory = buildAccountInventory(storage, { sessionId: SESSION_ID });

		expect(pinnedButRotated(inventory, PROVIDER)).toBeUndefined();
	});

	/**
	 * No pin means no divergence to report, even when the session HAS been moved off its first
	 * account by a rate limit. That is the arrangement here: the first credential is blocked so
	 * the second serves, which is exactly the shape a rotated pin has minus the pin. A
	 * predicate that fell back to "the first row" as the pinned one would report this
	 * involuntary-looking pair and put a "you asked for X" warning on a choice nobody made.
	 */
	test("returns undefined when the session never pinned anything, even after a rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: personalId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-work");

		const inventory = buildAccountInventory(storage, { sessionId: SESSION_ID });
		const rows = inventory.providers[0]?.rows ?? [];
		// The precondition the fallback would trip over: row 0 is not the serving row.
		expect(rows.map(row => [row.credentialId, row.pinnedForSession, row.activeForSession])).toEqual([
			[personalId, false, false],
			[workId, false, true],
		]);

		expect(pinnedButRotated(inventory, PROVIDER)).toBeUndefined();
	});

	/**
	 * The reportable case. Both rows come back, each still carrying the name and the block
	 * deadline the surfaces need to write the sentence, and the pinned row is the one the
	 * user chose rather than the one now serving.
	 */
	test("returns the pinned row and the serving row once a rate limit moves traffic off the pin", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, workId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-work");

		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: workId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-personal");

		const inventory = buildAccountInventory(storage, { sessionId: SESSION_ID });
		const rotated = pinnedButRotated(inventory, PROVIDER);

		if (!rotated) throw new Error("expected a rotated pin to be reported");
		expect(rotated.pinned.credentialId).toBe(workId);
		expect(rotated.pinned.name).toBe("work");
		expect(rotated.pinned.pinnedForSession).toBe(true);
		expect(rotated.pinned.activeForSession).toBe(false);
		expect(rotated.pinned.blockedUntilMs).toBe(NOW_MS + BLOCK_FOR_MS);
		expect(rotated.serving.credentialId).toBe(personalId);
		expect(rotated.serving.name).toBe("personal");
		expect(rotated.serving.activeForSession).toBe(true);
		expect(rotated.serving.pinnedForSession).toBe(false);
	});

	/**
	 * Scoped to the provider asked about. Several providers serve one session at once, so a
	 * rotation on one must not make another provider's row look displaced.
	 */
	test("reports nothing for a provider that holds no credentials", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, workId)).toBe(true);
		await storage.getApiKey(PROVIDER, SESSION_ID);
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: workId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		await storage.getApiKey(PROVIDER, SESSION_ID);

		const inventory = buildAccountInventory(storage, { sessionId: SESSION_ID });

		expect(pinnedButRotated(inventory, "unit-rotated-elsewhere")).toBeUndefined();
	});
});
