/**
 * WHY THIS FILE EXISTS. Choosing an account used to be a SESSION pin, and the credentials it named
 * are not session-scoped: they live in one machine-wide database every profile reads. So the switch
 * an operator made evaporated on the next `veyyon`, silently, and traffic went back to whichever
 * account ranked first. Recording it per row id would have failed the other way: ids churn every
 * time a provider's credential list is rewritten (a logout, a re-login, a token rotation), so a
 * choice keyed by id either dangles or, worse, lands on whoever inherited the integer.
 *
 * THE CLASS THIS CLOSES is "the account the operator chose stops being the account that serves,
 * without anyone saying so". Every member of that class is a way the choice can be lost or
 * misresolved: lost across a restart, lost when the row is rewritten under the same identity,
 * shadowed by the session pin it was supposed to retire, invisible to a caller that has no session
 * id, or recorded for an account that is not a live row of that provider at all. Each is pinned
 * below against a REAL sqlite store in a temp directory, reopened for anything that claims
 * durability, because an in-process object answers from its own memo without ever having persisted
 * a byte.
 *
 * WHAT IT DOES NOT CATCH. Nothing here covers a remote broker store, which implements none of the
 * three optional selection methods and is expected to answer "no choice" (`#readProviderSelection`
 * does not wrap the read in a try/catch, so a store whose `getProviderSelection` THROWS propagates
 * rather than degrading; that is deliberate and untested here). An `api_key` row has no identity of
 * its own, so its selection is keyed by row id and does NOT survive a re-login; that is a property
 * of `resolveAccountNameIdentity`, asserted here only as the oauth case's counterpart.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-durable-selection";
const OTHER_PROVIDER = "unit-durable-selection-sibling";
const HOUR_MS = 60 * 60_000;
const SESSION_ID = "session-that-made-the-choice";
const OTHER_SESSION_ID = "some-other-session";

describe("an account choice outlives the session that made it", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-durable-selection-"));
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

	function oauthRow(suffix: string, access: string) {
		return {
			type: "oauth" as const,
			access,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + HOUR_MS,
			accountId: `account-${suffix}`,
			email: `${suffix}@example.com`,
		};
	}

	async function seedTwoAccounts(storage: AuthStorage): Promise<[number, number]> {
		await storage.set(PROVIDER, [oauthRow("first", "access-first"), oauthRow("second", "access-second")]);
		const rows = storage.listStoredCredentials(PROVIDER);
		return [rows[0]!.id, rows[1]!.id];
	}

	/**
	 * Seed two accounts and report which one the resolver would NOT have picked on its own.
	 *
	 * Every assertion below has to distinguish "the choice was honored" from "the ranking happened to
	 * agree with it", so each test chooses the account that loses by default. Derived at run time
	 * rather than hardcoded, because the default is a property of credential ranking and this file is
	 * not the place that pins it.
	 */
	async function seedAndPickTheLosingAccount(
		storage: AuthStorage,
	): Promise<{ chosenId: number; chosenSuffix: string; defaultAccess: string; otherId: number }> {
		const [firstId, secondId] = await seedTwoAccounts(storage);
		const defaultAccess = await storage.getApiKey(PROVIDER, "ranking-probe-session");
		if (defaultAccess !== "access-first" && defaultAccess !== "access-second") {
			throw new Error(`ranking probe resolved to an unexpected credential: ${String(defaultAccess)}`);
		}
		return defaultAccess === "access-first"
			? { chosenId: secondId, chosenSuffix: "second", defaultAccess, otherId: firstId }
			: { chosenId: firstId, chosenSuffix: "first", defaultAccess, otherId: secondId };
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
	 * The whole point of the feature: the choice is still in force in a process that never saw the
	 * session it was made in, for a caller that names a different session and for a caller that
	 * names none at all. Proven over a genuinely reopened database.
	 */
	test("a choice made in one session serves a fresh process, another session, and no session", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { chosenId, chosenSuffix } = await seedAndPickTheLosingAccount(authStorage);

		expect(authStorage.selectProviderCredential(PROVIDER, chosenId, { sessionId: SESSION_ID })).toBe(true);
		expect(authStorage.selectedProviderCredentialId(PROVIDER)).toBe(chosenId);

		const reopened = await reopen();

		expect(reopened.selectedProviderCredentialId(PROVIDER)).toBe(chosenId);
		expect(await reopened.getApiKey(PROVIDER, OTHER_SESSION_ID)).toBe(`access-${chosenSuffix}`);
		expect(await reopened.getApiKey(PROVIDER)).toBe(`access-${chosenSuffix}`);
		expect(reopened.sessionCredentialRouting(PROVIDER, undefined)?.selectedCredentialId).toBe(chosenId);
		expect(reopened.getOAuthAccountIdentity(PROVIDER, OTHER_SESSION_ID)).toEqual({
			accountId: `account-${chosenSuffix}`,
			email: `${chosenSuffix}@example.com`,
		});
	});

	/**
	 * The choice names the ACCOUNT. A logout and a re-login rewrite the provider's rows, handing out
	 * fresh ids, and the operator's answer to "which account" has not changed. A selection keyed by
	 * row id would either resolve to nothing here or, once AUTOINCREMENT reuse handed the integer to
	 * somebody else, route to the wrong account.
	 */
	test("a re-login under the same identity keeps the choice, across new row ids", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { chosenId, chosenSuffix, defaultAccess } = await seedAndPickTheLosingAccount(authStorage);
		expect(authStorage.selectProviderCredential(PROVIDER, chosenId)).toBe(true);

		// A logout of the chosen account: the selection resolves to nothing and is deliberately LEFT
		// in the store, which a fresh process is the only honest way to observe.
		expect(await authStorage.removeCredential(PROVIDER, chosenId)).toBe(true);
		const withoutTheAccount = await reopen();
		expect(withoutTheAccount.selectedProviderCredentialId(PROVIDER)).toBeUndefined();
		expect(await withoutTheAccount.getApiKey(PROVIDER, SESSION_ID)).toBe(defaultAccess);

		// The re-login. Same account, new token, new row.
		const otherSuffix = chosenSuffix === "first" ? "second" : "first";
		await withoutTheAccount.set(PROVIDER, [
			oauthRow(otherSuffix, `access-${otherSuffix}`),
			oauthRow(chosenSuffix, `access-${chosenSuffix}-again`),
		]);
		const reloggedRow = withoutTheAccount
			.listStoredCredentials(PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.email === `${chosenSuffix}@example.com`);
		if (!reloggedRow) throw new Error("re-login did not store the chosen account");

		// The row really is a new one: this is the id churn a selection keyed by row id would lose to.
		expect(reloggedRow.id).not.toBe(chosenId);
		expect(withoutTheAccount.selectedProviderCredentialId(PROVIDER)).toBe(reloggedRow.id);
		expect(await withoutTheAccount.getApiKey(PROVIDER, SESSION_ID)).toBe(`access-${chosenSuffix}-again`);
		expect(await withoutTheAccount.getApiKey(PROVIDER)).toBe(`access-${chosenSuffix}-again`);
	});

	/**
	 * Recording a choice the resolver cannot honor is worse than refusing it: the card shows an
	 * account, every request goes somewhere else, and nothing says why. The boolean is the caller's
	 * only chance to tell the operator the switch did not happen, and an id that belongs to a
	 * DIFFERENT provider is the same refusal as an id that belongs to nobody.
	 */
	test("refuses an id that is not a live row of that provider, and records nothing", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const { defaultAccess } = await seedAndPickTheLosingAccount(storage);
		await storage.set(OTHER_PROVIDER, [oauthRow("sibling", "access-sibling")]);
		const siblingId = storage.listStoredCredentials(OTHER_PROVIDER)[0]!.id;

		expect(storage.selectProviderCredential(PROVIDER, 987_654)).toBe(false);
		expect(storage.selectProviderCredential(PROVIDER, siblingId)).toBe(false);

		expect(storage.selectedProviderCredentialId(PROVIDER)).toBeUndefined();
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(defaultAccess);
		const reopened = await reopen();
		expect(reopened.selectedProviderCredentialId(PROVIDER)).toBeUndefined();
	});

	/**
	 * A pin would outrank the global choice at the chokepoint, so the choice must retire it in the
	 * same call rather than sit behind it. Constructed so the two answers differ: the pin names the
	 * account ranking already prefers and the new choice names the other one, so a call that left the
	 * pin standing keeps serving the old account and fails here.
	 */
	test("choosing an account retires the session pin that would have shadowed it", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const { chosenId, chosenSuffix, defaultAccess, otherId } = await seedAndPickTheLosingAccount(storage);

		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, otherId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(defaultAccess);

		expect(storage.selectProviderCredential(PROVIDER, chosenId, { sessionId: SESSION_ID })).toBe(true);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(`access-${chosenSuffix}`);
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION_ID)?.selectedCredentialId).toBe(chosenId);
		// Durably retired: a fresh process must not resurrect the pin from the sticky cache row.
		const reopened = await reopen();
		expect(await reopened.getApiKey(PROVIDER, SESSION_ID)).toBe(`access-${chosenSuffix}`);
		expect(reopened.selectedProviderCredentialId(PROVIDER)).toBe(chosenId);
	});

	/**
	 * The other direction. A pin made after the global choice is a per-session override and must win
	 * for THAT session only: `/account use` is the machine-wide answer, and a one-session switch may
	 * not rewrite it for every other session and profile.
	 */
	test("a session pin outranks the global choice for that session alone", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const { chosenId, chosenSuffix, defaultAccess, otherId } = await seedAndPickTheLosingAccount(storage);

		expect(storage.selectProviderCredential(PROVIDER, chosenId)).toBe(true);
		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, otherId)).toBe(true);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(defaultAccess);
		expect(await storage.getApiKey(PROVIDER, OTHER_SESSION_ID)).toBe(`access-${chosenSuffix}`);
		expect(await storage.getApiKey(PROVIDER)).toBe(`access-${chosenSuffix}`);
		expect(storage.selectedProviderCredentialId(PROVIDER)).toBe(chosenId);
	});

	/**
	 * Clearing must be as durable as choosing, and must be scoped to the one provider. Several
	 * providers serve one session at once (main model, subagent roles, web search), so clearing
	 * Anthropic's choice may not touch the Codex one.
	 */
	test("clearProviderSelection forgets the choice durably, and only for its own provider", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const { chosenId, defaultAccess } = await seedAndPickTheLosingAccount(storage);
		await storage.set(OTHER_PROVIDER, [oauthRow("sibling", "access-sibling"), oauthRow("cousin", "access-cousin")]);
		const siblingRows = storage.listStoredCredentials(OTHER_PROVIDER);
		const otherProviderDefault = await storage.getApiKey(OTHER_PROVIDER, "ranking-probe-session");
		const otherProviderChoice = siblingRows.find(
			row => row.credential.type === "oauth" && row.credential.access !== otherProviderDefault,
		);
		if (!otherProviderChoice || otherProviderChoice.credential.type !== "oauth") {
			throw new Error("both sibling credentials resolved the same way");
		}
		expect(storage.selectProviderCredential(PROVIDER, chosenId)).toBe(true);
		expect(storage.selectProviderCredential(OTHER_PROVIDER, otherProviderChoice.id)).toBe(true);

		storage.clearProviderSelection(PROVIDER, { sessionId: SESSION_ID });

		expect(storage.selectedProviderCredentialId(PROVIDER)).toBeUndefined();
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(defaultAccess);
		const reopened = await reopen();
		expect(reopened.selectedProviderCredentialId(PROVIDER)).toBeUndefined();
		expect(reopened.selectedProviderCredentialId(OTHER_PROVIDER)).toBe(otherProviderChoice.id);
		expect(await reopened.getApiKey(OTHER_PROVIDER)).toBe(otherProviderChoice.credential.access);
	});

	/**
	 * A store written by a build that predates the selection table is the stale-persisted-shape case:
	 * the schema has to be brought forward on open rather than crashing a process that only wanted a
	 * credential, and a choice made afterwards has to round-trip. Dropping the table is how a store
	 * from before the feature looks, and the statements are prepared in the constructor, so a schema
	 * step that forgot this table turns the reopen itself into a throw.
	 */
	test("a store with no selection table opens, reports no choice, and accepts a new one", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { chosenId, chosenSuffix } = await seedAndPickTheLosingAccount(authStorage);
		expect(authStorage.selectProviderCredential(PROVIDER, chosenId)).toBe(true);

		store?.close();
		store = null;
		const raw = new Database(dbPath);
		raw.run("DROP TABLE auth_provider_selection");
		raw.close();

		store = await SqliteAuthCredentialStore.open(dbPath);
		const recovered = new AuthStorage(store);
		await recovered.reload();
		authStorage = recovered;
		const rows = recovered.listStoredCredentials(PROVIDER);
		expect(rows.length).toBe(2);
		expect(recovered.selectedProviderCredentialId(PROVIDER)).toBeUndefined();

		expect(recovered.selectProviderCredential(PROVIDER, chosenId)).toBe(true);
		const reopened = await reopen();
		expect(reopened.selectedProviderCredentialId(PROVIDER)).toBe(chosenId);
		expect(await reopened.getApiKey(PROVIDER)).toBe(`access-${chosenSuffix}`);
	});
});
