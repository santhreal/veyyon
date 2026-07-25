import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-oauth-refresh-abort-persist-test";

/**
 * Regression suite for the intermittent "logged out after a rebuild" bug.
 *
 * Providers such as Anthropic invalidate a refresh token the instant it is used
 * and hand back a rotated one in the response. Token refresh happens through a
 * per-credential single-flight whose RETURNED promise the caller races against
 * its abort signal (`raceCredentialRefreshWithSignal` → `Promise.race([promise,
 * abort])`). Aborting the caller — which is exactly what a shutdown, a rebuild,
 * or an ESC does — abandons the caller's await but does NOT cancel the in-flight
 * refresh: it still resolves a moment later with the rotated token.
 *
 * Before the fix, nobody persisted that rotated token on the aborted path, so the
 * old (now dead at the provider) refresh token stayed on disk. The next run then
 * refreshed with the dead token, got `invalid_grant`, classified it as a
 * definitive failure, and PERMANENTLY DISABLED a perfectly good login — the user
 * saw "No API key found" and had to sign in again, over and over, after every
 * rebuild. These tests pin that the rotation is committed to disk regardless of
 * the caller aborting, that no credential is disabled as a result, and that a
 * genuinely newer peer token is never clobbered by a late post-abort persist.
 */
describe("AuthStorage OAuth refresh survives a caller abort mid-rotation", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-abort-persist-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		oauthUtils.unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Poll the persisted row until `predicate` holds or the deadline passes. */
	async function waitForStoredRefresh(provider: string, expected: string, timeoutMs = 2000): Promise<string | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const rows = store!.listAuthCredentials(provider);
			const credential = rows[0]?.credential;
			if (credential?.type === "oauth") {
				if (credential.refresh === expected) return credential.refresh;
			}
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const credential = store!.listAuthCredentials(provider)[0]?.credential;
		return credential?.type === "oauth" ? credential.refresh : null;
	}

	test("commits the rotated refresh token to disk even when the caller aborts before the refresh resolves", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-abort-commit";
		const expired = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Abort Commit",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				// The provider has now consumed the stale refresh token; it is dead.
				refreshStarted.resolve();
				// Hold the response until the caller has aborted, reproducing a rebuild
				// landing during the sub-second refresh window.
				await allowRefresh.promise;
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);

		const controller = new AbortController();
		const pending = authStorage.getApiKey(provider, "abort-session", { signal: controller.signal });

		// Refresh is in flight (stale token already consumed at the provider).
		await refreshStarted.promise;
		// Rebuild / shutdown / ESC: the caller stops waiting.
		controller.abort();
		await expect(pending).resolves.toBeUndefined();

		// The provider now responds with the rotated token.
		allowRefresh.resolve();

		// Despite the abort, the rotation must be durably committed so the next run
		// never refreshes with the dead token.
		const persisted = await waitForStoredRefresh(provider, "rotated-refresh");
		expect(persisted).toBe("rotated-refresh");

		const stored = store.listAuthCredentials(provider);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("rotated-access");
			expect(stored[0].credential.refresh).toBe("rotated-refresh");
		}
		// The abort itself must never disable the credential.
		expect(events).toHaveLength(0);
	});

	test("a caller abort during refresh never disables the login; the next request still returns a working token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-abort-nodisable";
		const expired = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Abort NoDisable",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);

		const controller = new AbortController();
		const aborted = authStorage.getApiKey(provider, "abort-session", { signal: controller.signal });
		await refreshStarted.promise;
		controller.abort();
		await expect(aborted).resolves.toBeUndefined();
		allowRefresh.resolve();
		expect(await waitForStoredRefresh(provider, "rotated-refresh")).toBe("rotated-refresh");

		// The next request finds the rotated, still-fresh access token on disk and
		// returns it directly — no second refresh, no disable, no re-login.
		const key = await authStorage.getApiKey(provider, "next-session");
		expect(key).toBe("rotated-access");
		expect(refreshCalls).toBe(1);
		expect(events).toHaveLength(0);
		expect(authStorage.list()).toContain(provider);
	});

	test("a late post-abort persist does not overwrite a token a peer rotated forward in the meantime", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-abort-cas";
		const expired = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Abort CAS",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "our-rotated-access",
					refresh: "our-rotated-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		const controller = new AbortController();
		const pending = authStorage.getApiKey(provider, "abort-session", { signal: controller.signal });
		await refreshStarted.promise;
		controller.abort();
		await expect(pending).resolves.toBeUndefined();

		// A peer process rotated the row forward with a genuinely newer, live token
		// while our aborted refresh was still hanging.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "peer-access",
			refresh: "peer-refresh",
			expires: refreshedExpires,
		});

		// Our refresh finally resolves; its late persist must lose the CAS and leave
		// the peer's newer token untouched rather than resurrecting our stale-derived one.
		allowRefresh.resolve();
		// Give the background persist ample time to run and (correctly) do nothing.
		await new Promise(resolve => setTimeout(resolve, 100));

		const stored = store.listAuthCredentials(provider);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.refresh).toBe("peer-refresh");
			expect(stored[0].credential.access).toBe("peer-access");
		}
		expect(events).toHaveLength(0);
	});

	test("commits AND re-enables when a peer disabled the row on our pre-rotation token mid-abort", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-abort-disable-heal";
		const expired = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Abort Disable Heal",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		// A real second process on its own connection to the same shared DB.
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const controller = new AbortController();
			const pending = authStorage.getApiKey(provider, "abort-session", { signal: controller.signal });
			await refreshStarted.promise;
			// Rebuild aborts the caller...
			controller.abort();
			await expect(pending).resolves.toBeUndefined();

			// ...and a peer, whose own refresh of the SAME stale token got invalid_grant,
			// disables the row (its data still shows the pre-rotation token). The row is
			// now disabled and hidden from the active list — the exact state that used to
			// strand our incoming live token.
			peerStore.deleteAuthCredential(credentialId, "oauth refresh failed: HTTP 400 invalid_grant");
			expect(peerStore.listAuthCredentials(provider)).toHaveLength(0);

			// Our aborted refresh finally resolves; the crash-safe commit must both land
			// the rotated token AND re-enable the row a peer disabled on the token we
			// legitimately rotated from.
			allowRefresh.resolve();
			await new Promise(resolve => setTimeout(resolve, 100));
		} finally {
			peerStore.close();
		}

		const active = store.listAuthCredentials(provider);
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(credentialId);
		expect(active[0]?.credential.type).toBe("oauth");
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.refresh).toBe("rotated-refresh");
			expect(active[0].credential.access).toBe("rotated-access");
		}
	});
});
