import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, type StoredAuthCredential } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { logger } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-refresh-row-provider-mismatch-test";

/**
 * A refresh in flight must never hand back a token that belongs to a DIFFERENT
 * provider, even when the store row it is watching does.
 *
 * WHY THIS IS REACHABLE. The refresh path holds a bare numeric `credentialId` and
 * re-reads the row under it to see whether a peer process already rotated the
 * token (`#freshRotatedCredential`, reached from the lease wait, the re-check
 * under the lease, and the commit path). Nothing in that lookup constrains which
 * provider the row belongs to. `readAuthCredentialById` is an OPTIONAL method on
 * the `AuthCredentialStore` interface, so the row comes from whichever store is
 * plugged in, and even in the SQLite store the explicit-id INSERT paths used by
 * migration and import write ids chosen somewhere else.
 *
 * What makes a mismatched row dangerous rather than merely wrong is that it looks
 * exactly like the thing being searched for: a live, unexpired OAuth credential
 * whose refresh token differs from the one held. That is the peer-rotated
 * signature, so the row was returned as the caller's own freshly rotated token and
 * sent upstream to the wrong provider.
 *
 * SCOPE, stated so nobody reads more into this than is there: the shipped
 * `SqliteAuthCredentialStore` declares `id INTEGER PRIMARY KEY AUTOINCREMENT` and
 * therefore never recycles an id on its own. This is a fail-closed check at an
 * interface boundary, not a fix for an observed race in that store.
 *
 * These tests pin both directions, because the cheap way to pass the first one is
 * to disable the peer-reuse short circuit entirely, which would silently cost
 * every waiter a redundant token-endpoint round trip and re-spend a single-use
 * refresh token.
 */
describe("An OAuth refresh refuses a store row that has become another provider's", () => {
	let tempDir = "";
	const closers: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-row-provider-mismatch-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders(SOURCE_ID);
		for (const c of closers.splice(0)) {
			try {
				c.close();
			} catch {
				// already closed
			}
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Register a provider whose refresh is observable and whose tokens are distinctive. */
	function registerProvider(id: string, rotated: { access: string; refresh: string }): () => number {
		let calls = 0;
		const expires = Date.now() + 60 * 60_000;
		oauthUtils.registerOAuthProvider({
			id,
			name: id,
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires };
			},
			async refreshToken(credentials) {
				calls += 1;
				return { ...credentials, access: rotated.access, refresh: rotated.refresh, expires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		return () => calls;
	}

	test("a row that now belongs to another provider is not mistaken for a peer's rotation", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const victim = "unit-mismatch-victim";
		const squatter = "unit-mismatch-squatter";
		const victimCalls = registerProvider(victim, { access: "victim-rotated", refresh: "victim-rotated-refresh" });

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const authStorage = new AuthStorage(store);

		// The victim holds an EXPIRED credential, so getApiKey must refresh it.
		await authStorage.set(victim, [
			{ type: "oauth", access: "victim-stale", refresh: "victim-stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(victim)[0]?.id;
		expect(credentialId).toBeGreaterThan(0);

		// The row under this id is the squatter's: a live, unexpired OAuth credential with
		// a different refresh token, which is precisely the peer-rotated signature.
		const squatterRow: StoredAuthCredential = {
			id: credentialId as number,
			provider: squatter,
			credential: {
				type: "oauth",
				access: "squatter-access",
				refresh: "squatter-refresh",
				expires: Date.now() + 60 * 60_000,
			},
			disabledCause: null,
		};
		vi.spyOn(store, "readAuthCredentialById").mockImplementation(() => squatterRow);

		const key = await authStorage.getApiKey(victim, "session-mismatch");

		// The squatter's secret must never reach the victim's caller, by any route.
		expect(key).not.toBe("squatter-access");
		expect(key).toBe("victim-rotated");
		// And the refusal is not silent inaction: the real token endpoint was used.
		expect(victimCalls()).toBe(1);
	});

	test("a matching row still short-circuits, so the peer-reuse optimisation survives the guard", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-mismatch-matching";
		const calls = registerProvider(provider, { access: "should-not-happen", refresh: "should-not-happen" });

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const authStorage = new AuthStorage(store);

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]?.id as number;
		// A genuine peer rotation: same provider, same id, newer refresh token.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "peer-rotated-access",
			refresh: "peer-rotated-refresh",
			expires: Date.now() + 60 * 60_000,
		});

		const key = await authStorage.getApiKey(provider, "session-matching");

		expect(key).toBe("peer-rotated-access");
		// Zero token-endpoint calls is the whole point of the short circuit: the
		// waiter reuses the winner's rotation instead of spending its dead token.
		expect(calls()).toBe(0);
	});

	test("the refusal is reported by name and never carries a token", async () => {
		// Law 10: a silent refusal is as bad as a silent fallback, because the
		// operator cannot tell a working store from one handing out other people's
		// rows. Equally, the thing being refused is a credential, so the warning has
		// to be diagnosable WITHOUT quoting any part of it.
		const dbPath = path.join(tempDir, "agent.db");
		const victim = "unit-mismatch-logged";
		const squatter = "unit-mismatch-logged-squatter";
		registerProvider(victim, { access: "victim-rotated", refresh: "victim-rotated-refresh" });

		const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields });
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const authStorage = new AuthStorage(store);
		await authStorage.set(victim, [
			{ type: "oauth", access: "victim-stale", refresh: "victim-stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(victim)[0]?.id as number;
		vi.spyOn(store, "readAuthCredentialById").mockImplementation(() => ({
			id: credentialId,
			provider: squatter,
			credential: {
				type: "oauth",
				access: "squatter-access-secret",
				refresh: "squatter-refresh-secret",
				expires: Date.now() + 60 * 60_000,
			},
			disabledCause: null,
		}));

		await authStorage.getApiKey(victim, "session-logged");

		const refusal = warnings.find(w => w.message.includes("changed provider mid-refresh"));
		expect(refusal).toBeDefined();
		expect(refusal?.fields?.expectedProvider).toBe(victim);
		expect(refusal?.fields?.storedProvider).toBe(squatter);
		expect(refusal?.fields?.credentialId).toBe(credentialId);

		// No token material anywhere in the emitted diagnostics.
		const emitted = JSON.stringify(warnings);
		expect(emitted).not.toContain("squatter-access-secret");
		expect(emitted).not.toContain("squatter-refresh-secret");
		expect(emitted).not.toContain("victim-stale-refresh");
	});
});
