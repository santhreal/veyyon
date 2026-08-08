/**
 * A rate-limit rotation must never be reported as the user's own choice.
 *
 * When the account a user pinned gets blocked, traffic moves to a sibling. The account
 * manager has to be able to say "you asked for `work`, it hit its limit at 14:03, `personal`
 * is serving" — which is only possible if `sessionCredentialRouting` keeps BOTH facts. The
 * regression this file exists to prevent: `activeCredentialId` was computed from the same
 * private helper that answers with the pin, so it was always a copy of `selectedCredentialId`,
 * the divergence could never be observed, and the substitute account was presented as if the
 * user had picked it. The second test below is that bug's permanent gate.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-pin-rotation";
const HOUR_MS = 60 * 60_000;
/** Frozen wall clock, so the block deadline below is an exact number and not a window. */
const NOW_MS = 1_760_000_000_000;
const BLOCK_FOR_MS = 2 * HOUR_MS;

describe("sessionCredentialRouting reports a pin that rotation moved off", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-pin-rotation-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		setSystemTime(new Date(NOW_MS));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(async () => {
		setSystemTime();
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
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-first",
				email: "first@example.com",
			},
			{
				type: "oauth",
				access: "access-second",
				refresh: "refresh-second",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-second",
				email: "second@example.com",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		return [rows[0]!.id, rows[1]!.id];
	}

	/**
	 * The healthy baseline the divergence test is measured against. A pin that is serving
	 * must report itself as both the choice and the active account, with no block deadline —
	 * otherwise the manager would render a "rotated off" warning during normal operation.
	 */
	test("an unblocked pin reports itself as both the choice and the active account", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-healthy-pin";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");

		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			selectedCredentialId: secondId,
			activeCredentialId: secondId,
		});
	});

	/**
	 * The anti-silent-fallback contract, and the permanent gate on the bug where
	 * `activeCredentialId` was read from the pin-preferring resolver: after the pinned
	 * credential is blocked and a sibling actually serves the request, routing must report
	 * three separate facts — the pin is still the user's choice, it is blocked until an exact
	 * deadline, and a DIFFERENT credential is active. Erasing the pin, or echoing it back as
	 * the active id, both turn an involuntary account switch into something the UI cannot
	 * distinguish from a deliberate one.
	 */
	test("a blocked pin keeps its id, carries its unblock deadline, and reports a different active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-rotated-pin";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");

		const marked = await storage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: secondId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		expect(marked).toEqual({ switched: true });

		// The rotation itself: the next resolve cannot use the pinned account, so a sibling
		// serves and becomes the last-used record.
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");

		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			selectedCredentialId: secondId,
			selectedBlockedUntilMs: NOW_MS + BLOCK_FOR_MS,
			activeCredentialId: firstId,
		});
	});

	/**
	 * The pin is a durable choice, not a one-shot request: once the block lifts, traffic
	 * returns to the pinned account with no second user action. A rotation that silently
	 * consumed the pin would strand the session on the substitute account forever.
	 */
	test("traffic returns to the pinned account once its block expires", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-unblocks";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		await storage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: secondId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)?.activeCredentialId).toBe(firstId);

		setSystemTime(new Date(NOW_MS + BLOCK_FOR_MS + 1_000));

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			selectedCredentialId: secondId,
			activeCredentialId: secondId,
		});
	});
});
