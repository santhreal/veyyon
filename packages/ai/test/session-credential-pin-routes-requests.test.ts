/**
 * The account switch has to be REAL, not cosmetic.
 *
 * `/providers` lets a user pick which of a provider's several accounts serves this session.
 * The only thing that makes that a feature rather than a label change is that
 * `pinSessionCredential` actually moves where requests go, and keeps them there. Every test
 * in this file drives the real resolver (`getApiKey`) against a real sqlite store and asserts
 * on the bearer bytes that came back plus the identity every display surface reads, so a pin
 * the resolver quietly ignored cannot pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-pin-routing";
const OTHER_PROVIDER = "unit-pin-routing-other";
const HOUR_MS = 60 * 60_000;

describe("AuthStorage.pinSessionCredential routes this session's requests", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-pin-routing-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		// Hand back the credential's own access token as the bearer, so the value
		// `getApiKey` returns names exactly which stored account served the request.
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

	async function seedTwoAccounts(storage: AuthStorage, provider: string, tag: string): Promise<[number, number]> {
		await storage.set(provider, [
			{
				type: "oauth",
				access: `${tag}-access-first`,
				refresh: `${tag}-refresh-first`,
				expires: Date.now() + HOUR_MS,
				accountId: `${tag}-account-first`,
				email: `${tag}.first@example.com`,
			},
			{
				type: "oauth",
				access: `${tag}-access-second`,
				refresh: `${tag}-refresh-second`,
				expires: Date.now() + HOUR_MS,
				accountId: `${tag}-account-second`,
				email: `${tag}.second@example.com`,
			},
		]);
		const rows = storage.listStoredCredentials(provider);
		expect(rows).toHaveLength(2);
		return [rows[0]!.id, rows[1]!.id];
	}

	/**
	 * The load-bearing test of the whole feature: pinning an account must change the account
	 * the session's requests are attributed to, and must change ONLY that session. A pin the
	 * resolver ignored would show the new account in the manager while every request kept
	 * using the old one — the user would be told they switched and silently not have.
	 *
	 * Both halves are measured as a BEFORE/AFTER on the same session, so neither depends on
	 * which credential the round-robin hash happens to seed a given session id with: the
	 * pinned session is deliberately pinned to the account it did NOT resolve to, and the
	 * sibling's whole routing record must come back byte-identical.
	 */
	test("pinning the other account moves this session's bearer and identity to it, leaving a sibling session byte-identical", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage, PROVIDER, "pin");
		const pinnedSession = "session-pinned";
		const siblingSession = "session-untouched";

		const bearerBeforePin = await storage.getApiKey(PROVIDER, pinnedSession);
		const servedFirst = bearerBeforePin === "pin-access-first";
		expect(bearerBeforePin).toBe(servedFirst ? "pin-access-first" : "pin-access-second");
		// Pin the account this session is NOT on, so a no-op pin cannot pass.
		const targetId = servedFirst ? secondId : firstId;
		const targetBearer = servedFirst ? "pin-access-second" : "pin-access-first";
		const targetIdentity = servedFirst
			? { accountId: "pin-account-second", email: "pin.second@example.com" }
			: { accountId: "pin-account-first", email: "pin.first@example.com" };

		const siblingBearerBefore = await storage.getApiKey(PROVIDER, siblingSession);
		const siblingIdentityBefore = storage.getOAuthAccountIdentity(PROVIDER, siblingSession);
		const siblingRoutingBefore = storage.sessionCredentialRouting(PROVIDER, siblingSession);

		expect(storage.pinSessionCredential(PROVIDER, pinnedSession, targetId)).toBe(true);

		expect(await storage.getApiKey(PROVIDER, pinnedSession)).toBe(targetBearer);
		expect(storage.getOAuthAccountIdentity(PROVIDER, pinnedSession)).toEqual(targetIdentity);

		expect(await storage.getApiKey(PROVIDER, siblingSession)).toBe(siblingBearerBefore);
		expect(storage.getOAuthAccountIdentity(PROVIDER, siblingSession)).toEqual(siblingIdentityBefore);
		expect(storage.sessionCredentialRouting(PROVIDER, siblingSession)).toEqual(siblingRoutingBefore);
		expect(siblingRoutingBefore?.pinnedCredentialId).toBeUndefined();
	});

	/**
	 * Switching accounts is per PROVIDER by design: several providers serve one session at
	 * once (main model, subagent roles, web search), so pinning Anthropic must not disturb
	 * Codex. Pinning drops the pinned provider's routing record on purpose, and the failure
	 * this catches is that drop not being scoped: a "reset routing on switch" that swept every
	 * provider would cold-start every other provider's account choice for the session, which
	 * is invisible until the next request lands on a different account. Hence the whole
	 * routing record is compared, not just "the other provider still works".
	 */
	test("a pin on one provider leaves another provider's routing byte-identical", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [, secondId] = await seedTwoAccounts(storage, PROVIDER, "pin");
		await seedTwoAccounts(storage, OTHER_PROVIDER, "other");
		const sessionId = "session-two-providers";

		const otherBearerBefore = await storage.getApiKey(OTHER_PROVIDER, sessionId);
		const otherIdentityBefore = storage.getOAuthAccountIdentity(OTHER_PROVIDER, sessionId);
		const otherRoutingBefore = storage.sessionCredentialRouting(OTHER_PROVIDER, sessionId);
		expect(otherRoutingBefore?.pinnedCredentialId).toBeUndefined();

		expect(storage.pinSessionCredential(PROVIDER, sessionId, secondId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("pin-access-second");

		expect(storage.sessionCredentialRouting(OTHER_PROVIDER, sessionId)).toEqual(otherRoutingBefore);
		expect(await storage.getApiKey(OTHER_PROVIDER, sessionId)).toBe(otherBearerBefore);
		expect(storage.getOAuthAccountIdentity(OTHER_PROVIDER, sessionId)).toEqual(otherIdentityBefore);
	});

	/**
	 * A pin outranks the session's own routing record permanently, not just until the next
	 * resolve. The resolver writes a stickiness record on every successful `getApiKey`; if
	 * the pin were consulted only when that record is absent, the account would revert on
	 * the second request of the session and the user would see the switch "not take".
	 */
	test("repeated resolves stay on the pinned account instead of drifting back to the routing record", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstId, secondId] = await seedTwoAccounts(storage, PROVIDER, "pin");
		const sessionId = "session-repeat";

		// Establish a routing record BEFORE pinning, so the pin has an existing record to
		// outrank rather than an empty slot; then pin the account that record is not on.
		const bearerBeforePin = await storage.getApiKey(PROVIDER, sessionId);
		const servedFirst = bearerBeforePin === "pin-access-first";
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			activeCredentialId: servedFirst ? firstId : secondId,
		});
		const targetId = servedFirst ? secondId : firstId;
		const targetBearer = servedFirst ? "pin-access-second" : "pin-access-first";
		const targetIdentity = servedFirst
			? { accountId: "pin-account-second", email: "pin.second@example.com" }
			: { accountId: "pin-account-first", email: "pin.first@example.com" };

		expect(storage.pinSessionCredential(PROVIDER, sessionId, targetId)).toBe(true);

		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await storage.getApiKey(PROVIDER, sessionId)).toBe(targetBearer);
		}
		expect(storage.getOAuthAccountIdentity(PROVIDER, sessionId)).toEqual(targetIdentity);
		expect(storage.sessionCredentialRouting(PROVIDER, sessionId)).toEqual({
			provider: PROVIDER,
			pinnedCredentialId: targetId,
			activeCredentialId: targetId,
		});
	});
});
