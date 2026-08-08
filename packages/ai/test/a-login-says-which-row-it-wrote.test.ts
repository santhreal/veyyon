/**
 * WHY: an upsert answers with every row a provider has, not the one it just wrote.
 *
 * `AuthStorage.login` returned an identity slice with no row id, so a caller holding a fresh login
 * had no way to act on THAT account. Naming it, selecting it, or reporting it meant guessing, and the
 * guess is wrong exactly where it matters: two Anthropic subscriptions share an email, an account id,
 * and an organization, so any match other than the stored secret names a sibling.
 *
 * THE CLASS THIS CLOSES: both branches of `login` (a flow that returns a pasted key, and a flow that
 * returns OAuth credentials) report the row they wrote, in the presence of a sibling row that a
 * looser match would have picked instead. Every case below writes a SECOND credential and asserts
 * the id moves with the write rather than staying on the first row or drifting to the last one in the
 * list.
 *
 * WHAT IT DOES NOT CATCH: a remote store that renumbers rows between the write and its answer (the
 * id is then absent, which callers must handle and this suite asserts only for the empty-login case),
 * and whatever the caller does with the id afterwards. The naming UI is covered in the coding-agent
 * package.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "@veyyon/ai/registry/oauth/types";

const FIXTURE_SOURCE = "a-login-says-which-row-it-wrote";
const CONTROLLER = { onAuth: () => {}, onPrompt: async () => "" };

afterEach(() => {
	unregisterOAuthProviders(FIXTURE_SOURCE);
});

/** A provider whose login hands back whatever the case queues, one answer per call. */
function fixtureProvider(id: string, answers: readonly (string | OAuthCredentials)[]): void {
	const queue = [...answers];
	registerOAuthProvider({
		id,
		name: `Fixture ${id}`,
		sourceId: FIXTURE_SOURCE,
		login: async () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("fixture login called more times than the case queued");
			return next;
		},
	});
}

async function freshStorage(): Promise<{ store: SqliteAuthCredentialStore; storage: AuthStorage }> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	await storage.reload();
	return { store, storage };
}

function keyOf(credential: { type: string } & Record<string, unknown>): string | undefined {
	return credential.type === "api_key" ? (credential.key as string) : (credential.access as string);
}

/** Row id holding `secret`, read back from the store rather than from the value under test. */
function rowIdHolding(store: SqliteAuthCredentialStore, provider: string, secret: string): number {
	const row = store.listAuthCredentials(provider).find(entry => keyOf(entry.credential) === secret);
	if (!row) throw new Error(`no stored row holds ${secret}`);
	return row.id;
}

function oauthCredentials(access: string, email: string): OAuthCredentials {
	return { access, refresh: `refresh-${access}`, expires: Date.now() + 3_600_000, email };
}

describe("a login says which row it wrote", () => {
	it("names the api-key row it stored, with a sibling row present", async () => {
		const { store, storage } = await freshStorage();
		fixtureProvider("fixture-keys", ["key-one", "key-two"]);

		const first = await storage.login("fixture-keys" as OAuthProvider, CONTROLLER);
		const second = await storage.login("fixture-keys" as OAuthProvider, CONTROLLER);

		expect(store.listAuthCredentials("fixture-keys")).toHaveLength(2);
		expect(first?.credentialId).toBe(rowIdHolding(store, "fixture-keys", "key-one"));
		expect(second?.credentialId).toBe(rowIdHolding(store, "fixture-keys", "key-two"));
		expect(second?.credentialId).not.toBe(first?.credentialId);
	});

	it("reports the reused row when the same key is pasted again", async () => {
		const { store, storage } = await freshStorage();
		fixtureProvider("fixture-same", ["same-key", "same-key"]);

		const first = await storage.login("fixture-same" as OAuthProvider, CONTROLLER);
		const again = await storage.login("fixture-same" as OAuthProvider, CONTROLLER);

		// One row, so the second login must report that row rather than a row it did not create.
		expect(store.listAuthCredentials("fixture-same")).toHaveLength(1);
		expect(again?.credentialId).toBe(first?.credentialId);
	});

	it("names the oauth row it stored, with a sibling account present", async () => {
		const { store, storage } = await freshStorage();
		fixtureProvider("fixture-oauth", [
			oauthCredentials("access-alice", "alice@example.test"),
			oauthCredentials("access-bob", "bob@example.test"),
		]);

		const alice = await storage.login("fixture-oauth" as OAuthProvider, CONTROLLER);
		const bob = await storage.login("fixture-oauth" as OAuthProvider, CONTROLLER);

		expect(alice?.type).toBe("oauth");
		expect(alice?.credentialId).toBe(rowIdHolding(store, "fixture-oauth", "access-alice"));
		expect(bob?.credentialId).toBe(rowIdHolding(store, "fixture-oauth", "access-bob"));
		expect(bob?.email).toBe("bob@example.test");
	});

	it("reports nothing at all when the flow stored nothing", async () => {
		const { store, storage } = await freshStorage();
		fixtureProvider("fixture-empty", [""]);

		const identity = await storage.login("fixture-empty" as OAuthProvider, CONTROLLER);

		// An empty answer means "no key was entered": there is no row, so there is no id to invent.
		expect(identity).toBeUndefined();
		expect(store.listAuthCredentials("fixture-empty")).toHaveLength(0);
	});
});
