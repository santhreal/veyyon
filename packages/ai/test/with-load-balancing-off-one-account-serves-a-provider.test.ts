/**
 * WHY THIS FILE EXISTS. `accounts.loadBalancing` is documented as the setting that decides whether
 * the product may move a provider between the operator's accounts on its own initiative. The one
 * place that read it was the exhaustion handler, and that handler is not where the move happens:
 * the RESOLVER is. Every resolve re-ranked the accounts, skipped a blocked one in its strict pass,
 * and started a new session at a hash of its id, so with the setting off a second account was still
 * spent the moment the first one hit a window, and two sessions opened a minute apart landed on two
 * different subscriptions. The gate said "no move" and the next request moved anyway.
 *
 * The class this closes: with load balancing OFF and no explicit choice, exactly one account per
 * provider and credential type serves, and nothing automatic changes which one. The members of that
 * class, each pinned below:
 *   1. A new session with no history lands on the same account as every other new session.
 *   2. A sessionless caller gets that same account, not a round-robin cursor.
 *   3. A session whose account is rate-limited or out of quota keeps that account and waits.
 *   4. Usage ranking (a headroom contest) moves nothing: an account with less quota keeps serving.
 *   5. API keys are held to the same rule as OAuth logins.
 *   6. `sessionCredentialRouting`, the account card's source, predicts the account that will serve.
 *   7. Auth death still moves, because a refused grant cannot serve at all, and says so.
 *   8. Turning the setting ON restores movement: the same storage, the same accounts, a move.
 *
 * WHAT IT DOES NOT CATCH. The product default (OFF) and the wiring from `Settings` are pinned one
 * package up in `packages/coding-agent/test/session/the-load-balancing-gate-reads-the-operators-setting.test.ts`.
 * A ranking strategy's own plan filter (Codex tiers) is exercised elsewhere; the strategy here reads
 * the two windows of a report and nothing else, so plan eligibility is not covered here.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type CredentialFailoverEvent } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { UsageLimit, UsageReport } from "@veyyon/ai/usage";

const PROVIDER = "unit-one-account-serves";
const HOUR_MS = 60 * 60_000;
const NOW_MS = 1_760_000_000_000;
/** Enough distinct ids that a per-session hash across two accounts would land on both. */
const SESSION_IDS = Array.from({ length: 12 }, (_, i) => `session-${i}-${i * 7919}`);

describe("with load balancing off one account serves a provider", () => {
	let store: AuthCredentialStore | null = null;

	beforeEach(() => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		setSystemTime();
	});

	async function seedOAuth(storage: AuthStorage): Promise<{ firstId: number; secondId: number }> {
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-first",
				refresh: "refresh-first",
				expires: NOW_MS + HOUR_MS,
				accountId: "account-first",
				email: "first@example.com",
			},
			{
				type: "oauth",
				access: "access-second",
				refresh: "refresh-second",
				expires: NOW_MS + HOUR_MS,
				accountId: "account-second",
				email: "second@example.com",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		return { firstId: rows[0]!.id, secondId: rows[1]!.id };
	}

	async function seedApiKeys(storage: AuthStorage): Promise<void> {
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-first" },
			{ type: "api_key", key: "key-second" },
		]);
	}

	test("every new session and the sessionless caller land on the same account", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		await seedOAuth(storage);

		const served = new Set<string | undefined>();
		for (const sessionId of SESSION_IDS) served.add(await storage.getApiKey(PROVIDER, sessionId));
		served.add(await storage.getApiKey(PROVIDER));
		served.add(await storage.getApiKey(PROVIDER));

		expect([...served]).toEqual(["access-first"]);
	});

	test("the same holds for stored API keys", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		await seedApiKeys(storage);

		const served = new Set<string | undefined>();
		for (const sessionId of SESSION_IDS) served.add(await storage.getApiKey(PROVIDER, sessionId));
		served.add(await storage.getApiKey(PROVIDER));
		served.add(await storage.getApiKey(PROVIDER));

		expect([...served]).toEqual(["key-first"]);
	});

	/**
	 * The exhaustion handler already answered "no move" here. The defect was the resolve right after
	 * it: the strict pass skipped the blocked account and served the sibling, spending it.
	 */
	test("a rate-limited account keeps serving its session instead of a sibling being spent", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { firstId } = await seedOAuth(storage);
		const sessionId = SESSION_IDS[0]!;

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		const exhausted = await storage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: firstId,
			retryAfterMs: 60_000,
		});
		expect(exhausted).toEqual({ switched: false, retryAtMs: NOW_MS + 60_000 });

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		expect(await storage.getApiKey(PROVIDER, "another-session")).toBe("access-first");
		expect(await storage.getApiKey(PROVIDER)).toBe("access-first");
		const routing = storage.sessionCredentialRouting(PROVIDER, sessionId);
		expect(routing?.activeCredentialId).toBe(firstId);
	});

	test("a rate-limited API key keeps serving too", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		await seedApiKeys(storage);
		const sessionId = SESSION_IDS[1]!;
		const firstId = storage.listStoredCredentials(PROVIDER)[0]!.id;

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("key-first");
		await storage.markUsageLimitReached(PROVIDER, sessionId, { credentialId: firstId, retryAfterMs: 60_000 });

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("key-first");
		expect(await storage.getApiKey(PROVIDER)).toBe("key-first");
	});

	/** A usage report for one account: the first window near its limit or barely touched. */
	function usageReport(accountId: string, usedFraction: number): UsageReport {
		const limit: UsageLimit = {
			id: `${PROVIDER}:primary`,
			label: "1 Hour",
			scope: { provider: PROVIDER, windowId: "1h", shared: true },
			window: { id: "1h", label: "1 Hour", durationMs: HOUR_MS, resetsAt: NOW_MS + HOUR_MS / 2 },
			amount: {
				unit: "percent",
				used: usedFraction * 100,
				limit: 100,
				remaining: 100 - usedFraction * 100,
				usedFraction,
				remainingFraction: 1 - usedFraction,
			},
			status: usedFraction >= 0.9 ? "warning" : "ok",
		};
		return { provider: PROVIDER, fetchedAt: NOW_MS, limits: [limit], metadata: { accountId } };
	}

	/** The first account is nearly out of its window; the second has barely used its own. */
	function headroomContest(loadBalancing: boolean): AuthStorage {
		if (!store) throw new Error("test setup failed");
		return new AuthStorage(store, {
			loadBalancing,
			rankingStrategyResolver: () => ({
				findWindowLimits: report => ({ primary: report.limits[0], secondary: undefined }),
				windowDefaults: { primaryMs: HOUR_MS, secondaryMs: 7 * 24 * HOUR_MS },
			}),
			usageProviderResolver: () => ({
				id: PROVIDER,
				fetchUsage: async ({ credential }) =>
					credential.accountId
						? usageReport(credential.accountId, credential.accountId === "account-first" ? 0.95 : 0.05)
						: null,
			}),
		});
	}

	/**
	 * A headroom contest is a move by another name: whichever account has more quota left wins, so
	 * the account changes as usage shifts. The contest below moves the account with the setting on,
	 * which is what makes the off arm a proof rather than a fixture that ranks nothing.
	 */
	test("a headroom contest moves the account with the setting on", async () => {
		const storage = headroomContest(true);
		await seedOAuth(storage);

		expect(await storage.getApiKey(PROVIDER, SESSION_IDS[2])).toBe("access-second");
	});

	test("the same contest moves nothing with the setting off", async () => {
		const storage = headroomContest(false);
		await seedOAuth(storage);

		expect(await storage.getApiKey(PROVIDER, SESSION_IDS[2])).toBe("access-first");
		expect(await storage.getApiKey(PROVIDER, SESSION_IDS[3])).toBe("access-first");
		expect(await storage.getApiKey(PROVIDER)).toBe("access-first");
	});

	test("the account card predicts the account that will serve, blocked or not", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { firstId } = await seedOAuth(storage);

		for (const sessionId of SESSION_IDS.slice(0, 4)) {
			expect(storage.sessionCredentialRouting(PROVIDER, sessionId)?.activeCredentialId).toBe(firstId);
		}
		expect(storage.sessionCredentialRouting(PROVIDER, undefined)?.activeCredentialId).toBe(firstId);

		await storage.markUsageLimitReached(PROVIDER, SESSION_IDS[0], { credentialId: firstId, retryAfterMs: 60_000 });
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION_IDS[5])?.activeCredentialId).toBe(firstId);
	});

	/** A refused grant cannot serve, so it moves, and the move is announced rather than silent. */
	test("auth death still moves and announces itself", async () => {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, { loadBalancing: false, onCredentialFailover: e => void events.push(e) });
		const { firstId, secondId } = await seedOAuth(storage);
		const sessionId = SESSION_IDS[6]!;

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		await storage.rotateSessionCredential(PROVIDER, sessionId, {
			credentialId: firstId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
		expect(await storage.getApiKey(PROVIDER, "fresh-session")).toBe("access-second");
		expect(events.map(e => [e.from.credentialId, e.to.credentialId])).toEqual([[firstId, secondId]]);
	});

	/** The setting is a live resolver: the same storage moves the moment it turns on. */
	test("turning the setting on restores movement off a blocked account", async () => {
		if (!store) throw new Error("test setup failed");
		let enabled = false;
		const storage = new AuthStorage(store, { loadBalancing: () => enabled });
		const { firstId } = await seedOAuth(storage);
		const sessionId = SESSION_IDS[7]!;

		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");
		await storage.markUsageLimitReached(PROVIDER, sessionId, { credentialId: firstId, retryAfterMs: 60_000 });
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-first");

		enabled = true;
		expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-second");
	});
});
