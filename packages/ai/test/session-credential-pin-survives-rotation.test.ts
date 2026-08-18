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
	 * The anti-silent-fallback contract, half of it now inverted by a product decision.
	 *
	 * A quota hold is OUR prediction about a window, so it no longer moves traffic off the account
	 * the user pinned: the pin keeps serving and the provider gets to be the one that refuses. What
	 * routing must still do is carry the hold, so the card can say "you chose this, we think it is out
	 * of quota until 16:03, `c` lifts the hold" instead of silently substituting an account.
	 */
	test("a held pin keeps serving, and routing reports the hold without moving the active account", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-rotated-pin";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");

		await storage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: secondId,
			retryAfterMs: BLOCK_FOR_MS,
		});

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			selectedCredentialId: secondId,
			selectedBlockedUntilMs: NOW_MS + BLOCK_FOR_MS,
			activeCredentialId: secondId,
		});
	});

	/**
	 * The original defect's permanent gate, driven through the substitution that still happens: a
	 * grant that fails AUTHENTICATION is the provider's verdict, not our prediction, so it moves the
	 * request off the pinned account. Routing then has to report three separate facts — the pin is
	 * still the user's choice, and a DIFFERENT credential is active. `activeCredentialId` was once
	 * read from the pin-preferring resolver, so it was always a copy of `selectedCredentialId` and
	 * this divergence could not be observed at all.
	 */
	test("a pin whose grant died reports itself as the choice while a sibling is active", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-dead-pin";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");

		const moved = await storage.rotateSessionCredential(PROVIDER, sessionId, {
			credentialId: secondId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});
		expect(moved).toBe(true);

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		const routing = storage.sessionCredentialRouting(PROVIDER, sessionId);
		expect(routing?.selectedCredentialId).toBe(secondId);
		expect(routing?.activeCredentialId).toBe(firstId);
	});

	/**
	 * The pin is a durable choice, not a one-shot request: it serves throughout its own hold, and
	 * once the hold expires routing stops reporting a deadline. A rotation that silently consumed the
	 * pin would strand the session on a substitute account forever.
	 */
	test("a pin serves through its hold and loses the deadline when the hold expires", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [, secondId] = await seedTwoAccounts(storage);
		const sessionId = "session-unblocks";

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		await storage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: secondId,
			retryAfterMs: BLOCK_FOR_MS,
		});
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)?.selectedBlockedUntilMs).toBe(NOW_MS + BLOCK_FOR_MS);

		setSystemTime(new Date(NOW_MS + BLOCK_FOR_MS + 1_000));

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			selectedCredentialId: secondId,
			activeCredentialId: secondId,
		});
	});
});
