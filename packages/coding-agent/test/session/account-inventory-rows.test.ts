/**
 * The account model is one row per CREDENTIAL, not one row per provider.
 *
 * That is the defect the whole account manager exists to fix: `/providers` used to list one
 * line per provider with a bare "logged in" tag, so a user holding three Anthropic accounts
 * saw one row and could not tell which of them was serving the session. `buildAccountInventory`
 * is the single seam three surfaces read (the manager card, the inline `/account status`
 * block, and its ACP text form), so the row set, the grouping order and the routing marks are
 * asserted here once against a real `AuthStorage` over a real sqlite store.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { activeSessionAccounts, buildAccountInventory } from "@veyyon/coding-agent/session/account-inventory";

/** Sorts AFTER the api-key provider by label, and is inserted FIRST, so ordering is testable. */
const OAUTH_PROVIDER = "zeta-widgets";
const API_KEY_PROVIDER = "alpha-tools";
const SESSION_ID = "session-inventory";
const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 60 * 60_000;
const BLOCK_FOR_MS = 90 * 60_000;

describe("buildAccountInventory", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

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
		await authStorage.set(OAUTH_PROVIDER, [
			{
				type: "oauth",
				access: "zeta-access-first",
				refresh: "zeta-refresh-first",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "zeta-account-first",
				email: "zeta.first@example.com",
				orgName: "Zeta Inc",
			},
			{
				type: "oauth",
				access: "zeta-access-second",
				refresh: "zeta-refresh-second",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "zeta-account-second",
				email: "zeta.second@example.com",
				projectId: "zeta-project",
			},
		]);
		await authStorage.set(API_KEY_PROVIDER, [{ type: "api_key", key: "alpha-secret-key" }]);
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
	});

	/**
	 * One row per stored credential, grouped by provider, providers alphabetical by their
	 * DISPLAY label rather than their slug. Insertion order is deliberately the reverse of
	 * the expected order so a sort that never ran cannot pass.
	 */
	test("emits one row per credential and orders providers alphabetically by label", () => {
		if (!authStorage) throw new Error("test setup failed");
		const inventory = buildAccountInventory(authStorage, { sessionId: SESSION_ID });

		expect(inventory.providers.map(entry => entry.label)).toEqual(["Alpha Tools", "Zeta Widgets"]);
		expect(inventory.providers.map(entry => entry.provider)).toEqual([API_KEY_PROVIDER, OAUTH_PROVIDER]);
		expect(inventory.providers.map(entry => entry.rows.length)).toEqual([1, 2]);
		expect(inventory.totalAccounts).toBe(3);
		expect(inventory.unhealthyCount).toBe(0);
		expect(inventory.providers[1]?.rows.map(row => row.email)).toEqual([
			"zeta.first@example.com",
			"zeta.second@example.com",
		]);
	});

	/**
	 * An api-key credential has no account behind it, so every OAuth identity field must be
	 * absent rather than filled with a placeholder. A row that invented an email would make
	 * the display ladder claim an identity the credential cannot prove, and would let usage
	 * attribution match it against somebody's report.
	 */
	test("an api-key row carries no OAuth identity fields", () => {
		if (!authStorage) throw new Error("test setup failed");
		const inventory = buildAccountInventory(authStorage, { sessionId: SESSION_ID });
		const row = inventory.providers[0]?.rows[0];
		if (!row) throw new Error("api-key row missing");

		expect(row.provider).toBe(API_KEY_PROVIDER);
		expect(row.providerLabel).toBe("Alpha Tools");
		expect(row.type).toBe("api_key");
		expect(row.origin).toEqual({ kind: "api_key" });
		expect(row.email).toBeUndefined();
		expect(row.accountId).toBeUndefined();
		expect(row.orgId).toBeUndefined();
		expect(row.orgName).toBeUndefined();
		expect(row.projectId).toBeUndefined();
		expect(row.name).toBeUndefined();
		expect(row.usage).toEqual([]);
		// The provider's only credential, so routing replays it as what would serve a first
		// request: marked, and marked as a PREDICTION. Nothing has been spent on it, which is
		// why `activeSessionAccounts` below excludes exactly this shape.
		expect(row.activeForSession).toBe(true);
		expect(row.activeIsPrediction).toBe(true);
		expect(row.selectedForProvider).toBe(false);
	});

	/**
	 * `activeForSession` marks the credential this session's next request uses, and exactly that
	 * one. Driven through a real `getApiKey` so the mark is compared against the bearer that came
	 * back, not against the mark's own source.
	 *
	 * The mark alone does not mean the session spent anything: with no traffic yet, routing answers
	 * with a prediction and marks it. `activeSessionAccounts` is the owner of the observed question
	 * ("what has this session actually routed"), and it is asserted here beside the raw marks
	 * because three surfaces read it as "in use by this session": the `/account status` block,
	 * `/account refresh`, and `/account name`. Each of those named an untouched provider while the
	 * predicted rows counted.
	 */
	test("activeForSession marks exactly the credential the session resolved to", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const bearer = await storage.getApiKey(OAUTH_PROVIDER, SESSION_ID);
		const servedIndex = bearer === "zeta-access-first" ? 0 : 1;
		const servedId = storage.listStoredCredentials(OAUTH_PROVIDER)[servedIndex]?.id;

		const inventory = buildAccountInventory(storage, { sessionId: SESSION_ID });
		const oauthRows = inventory.providers[1]?.rows ?? [];

		expect(oauthRows.filter(row => row.activeForSession).map(row => row.credentialId)).toEqual([servedId]);
		expect(oauthRows.every(row => row.activeIsPrediction === false)).toBe(true);
		expect(oauthRows.every(row => row.selectedForProvider === false)).toBe(true);
		// The provider the session never touched carries a predicted mark, and nothing else, so it
		// is absent from the routed set even though its row says `activeForSession`.
		expect(inventory.providers[0]?.rows.every(row => row.activeIsPrediction)).toBe(true);
		expect(activeSessionAccounts(inventory).map(row => row.credentialId)).toEqual([servedId]);
	});

	/**
	 * A pin shows up as both marks on the same row while it is healthy, because a usable pin
	 * IS what serves next. The manager renders `selectedForProvider` as the user's choice and
	 * `activeForSession` as the live routing, so conflating them would hide a rotation.
	 */
	test("a healthy pin marks its row as both pinned and active", () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const [firstRow, secondRow] = storage.listStoredCredentials(OAUTH_PROVIDER);
		if (!firstRow || !secondRow) throw new Error("credentials missing");
		expect(storage.pinSessionCredential(OAUTH_PROVIDER, SESSION_ID, secondRow.id)).toBe(true);

		const rows = buildAccountInventory(storage, { sessionId: SESSION_ID }).providers[1]?.rows ?? [];

		expect(rows.map(row => [row.credentialId, row.selectedForProvider, row.activeForSession])).toEqual([
			[firstRow.id, false, false],
			[secondRow.id, true, true],
		]);
		expect(rows[1]?.blockedUntilMs).toBeUndefined();
	});

	/**
	 * The rate-limit glyph and its countdown are only reachable when `blockedUntilMs`
	 * populates. It silently never did, because the block was looked up with the bare
	 * credential type where the store keys blocks by `${provider}:${type}`, so a blocked
	 * account rendered as healthy and the "unblocks in ..." line could not exist.
	 */
	test("a rate-limit blocked credential carries its exact unblock deadline", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const firstId = storage.listStoredCredentials(OAUTH_PROVIDER)[0]?.id;
		if (firstId === undefined) throw new Error("first credential missing");

		await storage.markUsageLimitReached(OAUTH_PROVIDER, SESSION_ID, {
			credentialId: firstId,
			retryAfterMs: BLOCK_FOR_MS,
		});

		const rows = buildAccountInventory(storage, { sessionId: SESSION_ID }).providers[1]?.rows ?? [];
		expect(rows[0]?.blockedUntilMs).toBe(NOW_MS + BLOCK_FOR_MS);
		expect(rows[1]?.blockedUntilMs).toBeUndefined();
	});
});
