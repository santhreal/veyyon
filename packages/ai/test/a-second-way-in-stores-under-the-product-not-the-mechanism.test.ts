/**
 * A provider entry describes one login MECHANISM, and `storeCredentialsAs` says which PRODUCT the
 * credential belongs to. `openai-codex-device` writes to `openai-codex`; `nous-research-api-key`
 * writes to `nous-research`. Everything downstream — the model manager, the account card, the model
 * list, the env-var fallback — is keyed on the product id and has never heard of the mechanism id.
 *
 * THE DEFECT THIS CLOSES: `AuthStorage.login` honored the redirection on the OAuth branch and not on
 * the api-key branch, so a pasted key was filed under the mechanism's id. Nothing read it there. The
 * login reported success, the account appeared, and the provider stayed unusable — the same shape as
 * a login that silently does nothing, one layer down.
 *
 * The suite derives its subjects from `PROVIDER_REGISTRY` at run time and drives the real
 * `AuthStorage.login`, so adding a redirected provider extends the sweep without an edit here, and a
 * mechanism that returns the other credential shape is covered by the same assertion.
 *
 * NOT CAUGHT: whether the product id a given entry redirects to is the RIGHT one. That is a claim
 * about a vendor's account model, and the sweep can only check that the redirection is obeyed.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import * as aiStream from "@veyyon/ai/stream";

/** Every entry that files its credential under another provider's id, read from the registry. */
const REDIRECTED = PROVIDER_REGISTRY.filter(
	(provider): provider is typeof provider & { storeCredentialsAs: string } =>
		typeof provider.storeCredentialsAs === "string" && provider.storeCredentialsAs.length > 0,
);

/** The rows SQLite actually holds, which is the only place the redirection is observable. */
function providersWithRows(db: Database): string[] {
	const rows = db.prepare("SELECT DISTINCT provider FROM auth_credentials ORDER BY provider").all() as {
		provider: string;
	}[];
	return rows.map(row => row.provider);
}

describe("a second way in stores under the product, not the mechanism", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;
	let db: Database | null = null;

	beforeEach(async () => {
		// An ambient NOUS_API_KEY (or any sibling) must not stand in for a stored row.
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		storage = null;
		db = null;
	});

	/**
	 * The sweep. Every redirected entry is driven through the real login with its own flow stubbed at
	 * the definition, so the assertion is about where `AuthStorage` puts the answer rather than about
	 * any one provider's protocol.
	 */
	it("files every redirected provider's credential under the id it names", async () => {
		expect(REDIRECTED.length).toBeGreaterThan(0);
		for (const provider of REDIRECTED) {
			const database = new Database(":memory:");
			const scopedStore = new SqliteAuthCredentialStore(database);
			const scopedStorage = new AuthStorage(scopedStore);
			await scopedStorage.reload();
			try {
				// Stub this entry's own flow, not the storage: what is under test is the branch
				// `AuthStorage` takes with the value the flow returns.
				const definition = provider as { login?: unknown };
				const original = definition.login;
				definition.login = async () => `sk-${provider.id}`;
				try {
					await scopedStorage.login(provider.id as Parameters<AuthStorage["login"]>[0], {
						onAuth: () => {},
						onProgress: () => {},
						onPrompt: async () => "",
					});
				} finally {
					definition.login = original;
				}

				expect(providersWithRows(database)).toEqual([provider.storeCredentialsAs]);
				expect(await scopedStorage.getApiKey(provider.storeCredentialsAs, "s")).toBe(`sk-${provider.id}`);
				// And nothing is readable under the mechanism id, which is what looked
				// like a login that succeeded and changed nothing.
				expect(await scopedStorage.getApiKey(provider.id, "s")).toBeFalsy();
			} finally {
				scopedStore.close();
			}
		}
	});

	/**
	 * Nous by name, because it is the pair that motivated this: one product, two ways in. A key pasted
	 * through the API-key entry has to be the same credential the device flow would have produced, or
	 * the operator holding a Portal key is told to complete a browser round trip they do not need.
	 */
	it("lets a Nous key pasted through the api-key entry serve the OAuth provider id", async () => {
		if (!storage || !db) throw new Error("test setup failed");
		const entry = PROVIDER_REGISTRY.find(provider => provider.id === "nous-research-api-key");
		if (!entry) throw new Error("nous-research-api-key is not registered");
		expect(entry.storeCredentialsAs).toBe("nous-research");

		const definition = entry as { login?: unknown };
		const original = definition.login;
		definition.login = async () => "sk-nous-portal";
		try {
			await storage.login("nous-research-api-key" as Parameters<AuthStorage["login"]>[0], {
				onAuth: () => {},
				onProgress: () => {},
				onPrompt: async () => "",
			});
		} finally {
			definition.login = original;
		}

		expect(await storage.getApiKey("nous-research", "s")).toBe("sk-nous-portal");
		expect(providersWithRows(db)).toEqual(["nous-research"]);
	});

	/**
	 * Both ways in are offered. A second mechanism nobody can reach is not a feature, and the login
	 * list is where an operator meets it: `/login` and the account card both build from this list.
	 */
	it("offers both Nous mechanisms in the login list", async () => {
		const { getOAuthProviders } = await import("@veyyon/ai/oauth");
		const listed = getOAuthProviders()
			.filter(provider => provider.id.startsWith("nous-research"))
			.map(provider => provider.id)
			.sort();
		expect(listed).toEqual(["nous-research", "nous-research-api-key"]);
	});

	/**
	 * The unredirected majority must not move. `storeCredentialsAs` is absent for almost every entry,
	 * and a fix that resolved a target for all of them could have redirected the wrong ones.
	 */
	it("leaves a provider without a redirection filed under its own id", async () => {
		if (!storage || !db) throw new Error("test setup failed");
		const entry = PROVIDER_REGISTRY.find(
			provider => provider.id === "command-code" && provider.storeCredentialsAs === undefined,
		);
		if (!entry) throw new Error("command-code is not registered, or now redirects");

		const definition = entry as { login?: unknown };
		const original = definition.login;
		definition.login = async () => "sk-command-code";
		try {
			await storage.login("command-code" as Parameters<AuthStorage["login"]>[0], {
				onAuth: () => {},
				onProgress: () => {},
				onPrompt: async () => "",
			});
		} finally {
			definition.login = original;
		}

		expect(providersWithRows(db)).toEqual(["command-code"]);
	});
});
