/**
 * A provider whose ONLY login was torn down must still appear, carrying the reason.
 *
 * This is the case the disabled-credential note exists for and the one that is hardest to notice is
 * missing. `listAuthCredentials` filters disabled rows, so a provider whose refresh failed holds no
 * active credential and never enters the account list at all: it reads exactly like a provider you
 * never signed into. The user is told to log in, and never told that the login they had was thrown
 * away or why.
 *
 * Driven through a REAL `SqliteAuthCredentialStore`, because the behaviour under test is precisely
 * what the store hides from the ordinary list: a fake store returning rows would prove nothing about
 * whether the disabled ones are reachable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { buildAccountInventory, loadAccountInventory } from "@veyyon/coding-agent/session/account-inventory";

const PROVIDER = "unit-dead-login";
const REFRESH_FAILURE = "oauth refresh failed: invalid_grant: the authorization grant is invalid";

describe("an inventory surfaces a login a failed refresh tore down", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-dead-login-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	/** Soft-delete with a refresh-failure cause: exactly what the refresh path writes. */
	async function seedThenKill(storage: AuthStorage, activeStore: SqliteAuthCredentialStore): Promise<number> {
		await storage.set(PROVIDER, [
			{ type: "oauth", access: "access-dead", refresh: "refresh-dead", expires: Date.now() + 3_600_000 },
		]);
		const id = storage.listStoredCredentials(PROVIDER)[0]!.id;
		activeStore.deleteAuthCredential(id, REFRESH_FAILURE);
		await storage.reload();
		return id;
	}

	/**
	 * The total-loss case. Nothing is left in the account list, so unless the provider is seeded from
	 * the disabled rows it vanishes entirely and the note has nothing to attach to.
	 */
	test("keeps the provider with no accounts and carries the cause", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await seedThenKill(authStorage, store);

		expect(authStorage.listStoredCredentials(PROVIDER)).toHaveLength(0);

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);
		expect(entry).toBeDefined();
		expect(entry?.rows).toHaveLength(0);
		expect(entry?.disabledCause).toBe(REFRESH_FAILURE);
	});

	/**
	 * The accountless entry must not inflate the tally. A provider with a dead login has zero
	 * spendable accounts, and a count that said otherwise would contradict the rows on screen.
	 */
	test("does not count a dead login as an account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await seedThenKill(authStorage, store);

		expect(buildAccountInventory(authStorage).totalAccounts).toBe(0);
	});

	/**
	 * A deliberate logout is a disable the user performed and already knows about. Resurrecting it as
	 * a warning would train them to ignore the warning that matters, so only refresh failures speak.
	 */
	test("stays silent for a deliberate logout", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "access-bye", refresh: "refresh-bye", expires: Date.now() + 3_600_000 },
		]);
		await authStorage.logout(PROVIDER);

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);
		expect(entry?.disabledCause).toBeUndefined();
	});

	/**
	 * A provider that still has a working sibling reports the dead one too, and keeps its live account
	 * as a real row. Losing one of two logins must not read as losing the provider.
	 */
	test("reports a dead login beside a surviving account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await seedThenKill(authStorage, store);
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "access-live", refresh: "refresh-live", expires: Date.now() + 3_600_000 },
		]);

		const inventory = await loadAccountInventory(authStorage);
		const entry = inventory.providers.find(group => group.provider === PROVIDER);
		expect(entry?.rows).toHaveLength(1);
		expect(entry?.disabledCause).toBe(REFRESH_FAILURE);
		expect(inventory.totalAccounts).toBe(1);
	});
});
