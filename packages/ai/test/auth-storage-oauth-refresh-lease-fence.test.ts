import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-oauth-refresh-lease-fence-test";

/**
 * Mirrors `OAUTH_REFRESH_LEASE_RENEW_MS` in auth-storage.ts (module-private). The
 * ownership-loss test has to outlast one renewal tick to reach the window it covers,
 * so it is the one test here that is deliberately slow; keep it in sync if the source
 * constant changes.
 */
const LEASE_RENEW_TICK_MS = 5_000;

/**
 * Prevention half of the "logged out after a rebuild" fix (the durable heal is
 * regression-locked separately in auth-storage-oauth-refresh-reenable.test.ts).
 *
 * Providers like Anthropic invalidate the OLD refresh token the instant it is used
 * and hand back a rotated one. When two veyyon processes share the machine-wide
 * credential store — the exact situation after a rebuild, when an old process and a
 * freshly built one overlap — both can decide the same credential is expired and
 * refresh it at once. Without a fence, both replay the same single-use token: one
 * wins (R1 -> R2), the other gets `invalid_grant` on the now-dead R1 and churns a
 * perfectly good login (CAS-disable, then heal). The healed row is invisible until
 * the heal lands, so the user flickers logged-out.
 *
 * The main getApiKey refresh path (`#refreshOAuthCredential`) fences the refresh with
 * the cross-process lease (`auth_credential_refresh_leases`): exactly one process
 * rotates the token; every other process waits for the winner to release, then
 * REUSES the freshly rotated token from disk instead of spending its own dead one.
 * These tests pin that the single-use token is consumed exactly once and no login is
 * ever disabled by the race.
 */
describe("The main OAuth refresh path is fenced across processes so a single-use token is spent once", () => {
	let tempDir = "";
	const closers: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-lease-fence-"));
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

	test("two processes refreshing the same expired credential rotate the token exactly once; neither is logged out", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-oauth-lease-race";
		const expired = Date.now() - 60_000;
		const rotatedExpires = Date.now() + 60 * 60_000;

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Lease Race",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: rotatedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				// Hold the lease open long enough that the peer's acquire attempt fails
				// and it must wait — the window where the pre-fix code double-refreshed.
				await Bun.sleep(120);
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: rotatedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		// Two independent processes: separate stores and AuthStorage instances over the
		// same shared DB file (WAL), the way two veyyon processes on one machine run.
		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		const storeB = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(storeA, storeB);
		const disabledA: CredentialDisabledEvent[] = [];
		const disabledB: CredentialDisabledEvent[] = [];
		const authA = new AuthStorage(storeA, {
			onCredentialDisabled: e => {
				disabledA.push(e);
			},
		});
		const authB = new AuthStorage(storeB, {
			onCredentialDisabled: e => {
				disabledB.push(e);
			},
		});

		await authA.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);
		// Process B learns about the same row from disk.
		await authB.reload();
		const credentialId = storeA.listAuthCredentials(provider)[0]!.id;
		expect(storeB.listAuthCredentials(provider)[0]?.id).toBe(credentialId);

		// Both processes hit getApiKey at the same time on the expired credential.
		const [keyA, keyB] = await Promise.all([
			authA.getApiKey(provider, "session-a"),
			authB.getApiKey(provider, "session-b"),
		]);

		// Both get the live rotated token...
		expect(keyA).toBe("rotated-access");
		expect(keyB).toBe("rotated-access");
		// ...but the single-use refresh token was spent EXACTLY once (the fence made the
		// loser reuse the winner's rotation instead of replaying the dead token).
		expect(refreshCalls).toBe(1);
		// No login was disabled by the race, in either process.
		expect(disabledA).toHaveLength(0);
		expect(disabledB).toHaveLength(0);

		// The row is active and carries the rotated token on disk.
		for (const store of [storeA, storeB]) {
			const active = store.listAuthCredentials(provider);
			expect(active).toHaveLength(1);
			expect(active[0]?.credential.type).toBe("oauth");
			if (active[0]?.credential.type === "oauth") {
				expect(active[0].credential.refresh).toBe("rotated-refresh");
				expect(active[0].credential.access).toBe("rotated-access");
			}
		}
	});

	test("a waiter reuses a peer's already-rotated token without calling the token endpoint (short-circuit)", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-oauth-lease-shortcircuit";
		const rotatedExpires = Date.now() + 60 * 60_000;

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Lease Short Circuit",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: rotatedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "should-not-happen",
					refresh: "should-not-happen",
					expires: rotatedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		const storeB = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(storeA, storeB);
		const authA = new AuthStorage(storeA);
		// Seed an EXPIRED credential, then have a "peer" rotate it to a fresh token on
		// disk before A ever refreshes.
		await authA.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = storeA.listAuthCredentials(provider)[0]!.id;
		storeB.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "peer-rotated-access",
			refresh: "peer-rotated-refresh",
			expires: rotatedExpires,
		});

		// A still holds the stale token in memory; its refresh must observe the peer's
		// fresh rotation on disk and reuse it rather than replay the dead single-use token.
		const key = await authA.getApiKey(provider, "session-a");
		expect(key).toBe("peer-rotated-access");
		expect(refreshCalls).toBe(0);
	});

	test(
		"losing the refresh lease mid-rotation does NOT discard the rotated token",
		async () => {
			const dbPath = path.join(tempDir, "agent.db");
			const provider = "unit-oauth-lease-lost";
			const rotatedExpires = Date.now() + 60 * 60_000;

			oauthUtils.registerOAuthProvider({
				id: provider,
				name: "Unit OAuth Lease Lost",
				sourceId: SOURCE_ID,
				async login() {
					return { access: "unused", refresh: "unused", expires: rotatedExpires };
				},
				async refreshToken(credentials) {
					// Outlast the lease-renewal tick so the (mocked-failing) renewal fires
					// while the rotation is still in flight — the ownership-lost window.
					await Bun.sleep(LEASE_RENEW_TICK_MS + 400);
					return {
						...credentials,
						access: "rotated-access",
						refresh: "rotated-refresh",
						expires: rotatedExpires,
					};
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});

			const store = await SqliteAuthCredentialStore.open(dbPath);
			closers.push(store);
			const disabled: CredentialDisabledEvent[] = [];
			const authStorage = new AuthStorage(store, {
				onCredentialDisabled: e => {
					disabled.push(e);
				},
			});
			await authStorage.set(provider, [
				{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
			]);
			const credentialId = store.listAuthCredentials(provider)[0]!.id;

			// Our lease TTL lapses and a peer steals the row: every renewal now fails.
			// The renew loop raises "ownership was lost before persistence" AFTER the
			// provider has already issued the rotated token and killed the old one.
			vi.spyOn(store, "renewCredentialRefreshLease").mockReturnValue(false);

			const key = await authStorage.getApiKey(provider, "lease-lost-session");

			// The request still succeeds with the freshly rotated token: losing the lease
			// must not turn a completed rotation into a failure.
			expect(key).toBe("rotated-access");
			// And — the whole point — the rotation is PERSISTED. Discarding it would leave
			// the dead `stale-refresh` on disk and log the user out on the next run.
			const active = store.listAuthCredentials(provider);
			expect(active).toHaveLength(1);
			expect(active[0]?.id).toBe(credentialId);
			if (active[0]?.credential.type === "oauth") {
				expect(active[0].credential.refresh).toBe("rotated-refresh");
				expect(active[0].credential.access).toBe("rotated-access");
			}
			// A lost lease is not an auth failure, so nothing may be disabled.
			expect(disabled).toHaveLength(0);
		},
		LEASE_RENEW_TICK_MS * 4,
	);

	test(
		"the MCP refresh path also keeps a rotation whose lease was lost mid-flight",
		async () => {
			// Same failure as the model-provider path above, on `refreshStoredOAuthCredential`
			// (the path MCP OAuth uses). Its persist is CAS-guarded on lease OWNERSHIP as
			// well as the data, so a lost lease used to both re-throw and make the write
			// unlandable — discarding a live token and leaving the MCP server "logged out".
			const provider = "unit-oauth-mcp-lease-lost";
			const rotatedExpires = Date.now() + 60 * 60_000;
			const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			closers.push(store);
			const authStorage = new AuthStorage(store);
			await authStorage.set(provider, [
				{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
			]);

			vi.spyOn(store, "renewCredentialRefreshLease").mockReturnValue(false);

			const result = await authStorage.refreshStoredOAuthCredential(provider, {
				credentialFromRow: credential => credential,
				async refresh(credential) {
					await Bun.sleep(LEASE_RENEW_TICK_MS + 400);
					return {
						...credential,
						access: "mcp-rotated-access",
						refresh: "mcp-rotated-refresh",
						expires: rotatedExpires,
					};
				},
			});

			// The rotation is reported AND persisted rather than thrown away.
			expect(result.refreshed).toBe(true);
			expect(result.removed).toBe(false);
			expect(result.credential?.access).toBe("mcp-rotated-access");
			const active = store.listAuthCredentials(provider);
			expect(active).toHaveLength(1);
			if (active[0]?.credential.type === "oauth") {
				expect(active[0].credential.refresh).toBe("mcp-rotated-refresh");
				expect(active[0].credential.access).toBe("mcp-rotated-access");
			}
		},
		LEASE_RENEW_TICK_MS * 4,
	);

	test("force-refresh re-enables a row a peer disabled, instead of stranding the live token on a disabled row", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-oauth-force-reenable";
		const rotatedExpires = Date.now() + 60 * 60_000;

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Force Re-enable",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: rotatedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "force-rotated-access",
					refresh: "force-rotated-refresh",
					expires: rotatedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		const peerStore = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store, peerStore);
		const authStorage = new AuthStorage(store);
		await authStorage.set(provider, [
			{ type: "oauth", access: "live-access", refresh: "live-refresh", expires: Date.now() + 60_000 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		// A peer disables the row on disk (its own failed refresh). The row is now
		// invisible to the active list, but `store` still holds it in memory.
		peerStore.deleteAuthCredential(credentialId, "oauth refresh failed: HTTP 400 invalid_grant");
		expect(peerStore.listAuthCredentials(provider)).toHaveLength(0);

		// A forced refresh succeeds — proof the grant is alive — so it must clear the
		// peer's disable when it persists (the gap the fix closed: force-refresh used the
		// non-re-enabling write and left a live token on a disabled row).
		const entry = await authStorage.forceRefreshCredentialById(credentialId);
		expect(entry.credential.type).toBe("oauth");

		const active = store.listAuthCredentials(provider);
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(credentialId);
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.refresh).toBe("force-rotated-refresh");
			expect(active[0].credential.access).toBe("force-rotated-access");
		}
	});

	test("a store without durable-lease support still refreshes (unfenced fallback), never throwing on the missing lease API", async () => {
		const provider = "unit-oauth-lease-fallback";
		const rotatedExpires = Date.now() + 60 * 60_000;

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Lease Fallback",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: rotatedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return { ...credentials, access: "fallback-access", refresh: "fallback-refresh", expires: rotatedExpires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		// A minimal store WITHOUT any lease methods (the shape a remote/broker gateway
		// presents). `#storeSupportsDurableLease()` is false, so the fence must fall back
		// to the plain refresh rather than dereferencing the absent lease API.
		const store = new NoLeaseMemoryStore();
		const authStorage = new AuthStorage(store);
		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);

		const key = await authStorage.getApiKey(provider, "session");
		expect(key).toBe("fallback-access");
		expect(refreshCalls).toBe(1);
		const active = store.listAuthCredentials(provider);
		expect(active).toHaveLength(1);
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.refresh).toBe("fallback-refresh");
		}
	});
});

/**
 * A store with no cross-process lease API and no re-enabling write — the reduced
 * surface a remote/broker gateway exposes. Exists so the fence's durable-lease
 * capability probe has a genuine negative to fall back from.
 */
class NoLeaseMemoryStore implements AuthCredentialStore {
	#rows: StoredAuthCredential[] = [];
	#nextId = 1;

	close(): void {}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		return this.#rows.filter(row => row.disabledCause === null && (!provider || row.provider === provider));
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const row = this.#rows.find(entry => entry.id === id);
		if (row) row.credential = credential;
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		const row = this.#rows.find(entry => entry.id === id);
		if (row) row.disabledCause = disabledCause;
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		const row = this.#rows.find(entry => entry.id === id && entry.disabledCause === null);
		if (!row || serializeOAuthData(row.credential) !== expectedData) return false;
		row.disabledCause = disabledCause;
		return true;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		for (const row of this.#rows) {
			if (row.provider === provider && row.disabledCause === null)
				row.disabledCause = "replaced by newer credential";
		}
		const rows = credentials.map(
			(credential): StoredAuthCredential => ({ id: this.#nextId++, provider, credential, disabledCause: null }),
		);
		this.#rows.push(...rows);
		return rows;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		return this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		for (const row of this.#rows) {
			if (row.provider === provider && row.disabledCause === null) row.disabledCause = disabledCause;
		}
	}

	getCache(): string | null {
		return null;
	}

	setCache(): void {}

	cleanExpiredCache(): void {}
}

function serializeOAuthData(credential: AuthCredential): string {
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return JSON.stringify(rest);
	}
	if (credential.type === "api_key") return JSON.stringify({ key: credential.key });
	return "";
}
