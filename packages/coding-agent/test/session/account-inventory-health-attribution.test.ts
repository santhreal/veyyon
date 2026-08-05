/**
 * A failing account must not drag a healthy sibling down with it.
 *
 * `applyCredentialHealth` folds probe results into the inventory, and the identifier it
 * matches on decides whether the manager tells the truth. One Anthropic login can hold two
 * subscriptions, so two credential rows legitimately share an email and an account id; the
 * database row id is the only identifier that is unique per row. Matching on anything softer
 * paints a red ✗ and an upstream error string on an account that is working, which sends the
 * user to re-authenticate a credential that never failed.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage, type CredentialHealthResult, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	type AccountInventory,
	applyCredentialHealth,
	buildAccountInventory,
} from "@veyyon/coding-agent/session/account-inventory";

/**
 * Must be `anthropic`: it is the one provider whose stored identity is org-scoped, so two
 * credentials sharing an email and an account id survive as two rows instead of being deduped
 * into one. That collision is the whole subject of this file, and no other provider produces it.
 */
const PROVIDER = "anthropic";
const HOUR_MS = 60 * 60_000;
const SHARED_EMAIL = "shared@example.com";

describe("applyCredentialHealth", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let inventory: AccountInventory | null = null;
	let teamId = 0;
	let personalId = 0;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
		// Two subscriptions on ONE login: same email, same account id, different org. This is
		// the real Anthropic shape, and the reason id matching is not an implementation detail.
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-team",
				refresh: "refresh-team",
				expires: Date.now() + HOUR_MS,
				accountId: "account-shared",
				email: SHARED_EMAIL,
				orgId: "org-team",
				orgName: "Example Org",
			},
			{
				type: "oauth",
				access: "access-personal",
				refresh: "refresh-personal",
				expires: Date.now() + HOUR_MS,
				accountId: "account-shared",
				email: SHARED_EMAIL,
				orgId: "org-personal",
				orgName: "Personal",
			},
		]);
		const rows = authStorage.listStoredCredentials(PROVIDER);
		teamId = rows[0]?.id ?? 0;
		personalId = rows[1]?.id ?? 0;
		inventory = buildAccountInventory(authStorage);
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
		inventory = null;
	});

	function failure(id: number, reason: string): CredentialHealthResult {
		return { id, provider: PROVIDER, type: "oauth", email: SHARED_EMAIL, accountId: "account-shared", ok: false, reason };
	}

	/**
	 * The load-bearing case: one of two rows sharing an email fails, and only that row is
	 * marked. Under email matching both rows would go red and the count would read 2.
	 */
	test("a failure on one row does not mark the sibling that shares its email and account id", () => {
		if (!inventory) throw new Error("test setup failed");

		const next = applyCredentialHealth(inventory, [failure(teamId, "invalid_grant: refresh token revoked")]);
		const rows = next.providers[0]?.rows ?? [];

		expect(rows.map(row => [row.credentialId, row.health, row.healthReason])).toEqual([
			[teamId, "failed", "invalid_grant: refresh token revoked"],
			[personalId, undefined, undefined],
		]);
	});

	/**
	 * `unhealthyCount` drives the ⚠ badge on the provider's sidebar count, so it must count
	 * hard failures only. `ok: null` means "no probe is configured for this provider" — an
	 * unverifiable credential is not a broken one, and badging it would make every provider
	 * without a usage endpoint look permanently faulty.
	 */
	test("unhealthyCount counts hard failures only, not unverifiable or passing rows", () => {
		if (!inventory) throw new Error("test setup failed");

		const next = applyCredentialHealth(inventory, [
			failure(teamId, "401 unauthorized"),
			{ id: personalId, provider: PROVIDER, type: "oauth", ok: null, reason: "no probe configured" },
		]);
		const rows = next.providers[0]?.rows ?? [];

		expect(rows.map(row => row.health)).toEqual(["failed", "unverifiable"]);
		expect(next.unhealthyCount).toBe(1);

		const allWell = applyCredentialHealth(inventory, [
			{ id: teamId, provider: PROVIDER, type: "oauth", ok: true },
			{ id: personalId, provider: PROVIDER, type: "oauth", ok: true },
		]);
		expect(allWell.providers[0]?.rows.map(row => row.health)).toEqual(["ok", "ok"]);
		expect(allWell.unhealthyCount).toBe(0);
	});

	/**
	 * A result whose id matches no row is dropped rather than applied to the nearest row.
	 * Probes run asynchronously, so a result can arrive after the account it names was logged
	 * out; attaching it to a neighbour would blame the wrong account for a dead credential.
	 */
	test("a result for an unknown credential id changes nothing", () => {
		if (!inventory) throw new Error("test setup failed");

		const next = applyCredentialHealth(inventory, [failure(teamId + personalId + 500, "gone")]);

		expect(next.providers[0]?.rows.map(row => row.health)).toEqual([undefined, undefined]);
		expect(next.unhealthyCount).toBe(0);
	});

	/**
	 * A probe can recover identity a stored credential never had, but it must FILL and never
	 * OVERWRITE: the stored value is what the routing layer keys on, so a probe answer that
	 * replaced it would make the displayed account differ from the one being used.
	 */
	test("probe identity fills a blank field and never overwrites a stored one", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.set(PROVIDER, [
			{ type: "oauth", access: "access-bare", refresh: "refresh-bare", expires: Date.now() + HOUR_MS },
			{
				type: "oauth",
				access: "access-known",
				refresh: "refresh-known",
				expires: Date.now() + HOUR_MS,
				email: "known@example.com",
				orgName: "Known Org",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		const bareId = rows[0]?.id ?? 0;
		const knownId = rows[1]?.id ?? 0;

		const next = applyCredentialHealth(buildAccountInventory(storage), [
			{ id: bareId, provider: PROVIDER, type: "oauth", ok: true, email: "recovered@example.com", orgName: "Recovered Org" },
			{ id: knownId, provider: PROVIDER, type: "oauth", ok: true, email: "probe@example.com", orgName: "Probe Org" },
		]);
		const [bare, known] = next.providers[0]?.rows ?? [];

		expect([bare?.email, bare?.orgName]).toEqual(["recovered@example.com", "Recovered Org"]);
		expect([known?.email, known?.orgName]).toEqual(["known@example.com", "Known Org"]);
	});
});
