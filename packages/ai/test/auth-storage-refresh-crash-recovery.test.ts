import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type CredentialDisabledEvent, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-refresh-crash-recovery-test";

/**
 * What the NEXT run does after a process was SIGKILLed mid-OAuth-refresh (SIG-4).
 *
 * A SIGKILL runs no handlers. Whatever the dying process was holding stays
 * exactly as it was: the refresh lease row it took is never released, and
 * whatever it had already written to the shared store stays written. The
 * question this suite answers is not whether the crash can be prevented (it
 * cannot) but whether the run after it RECOVERS or FAILS LOUDLY. The one
 * outcome that is unacceptable is the middle: a silent logout, or a wait with
 * no bound.
 *
 * Three crash points matter, and they are the three cases below.
 *
 *   1. Killed BEFORE the token endpoint was called. The refresh token is still
 *      good and only the orphaned lease is in the way. The next run must take
 *      the lease over and refresh normally.
 *   2. Killed AFTER the provider rotated but BEFORE the response was persisted.
 *      This is the documented residual in AUTH-ROTATION-CRASH: the token the
 *      provider issued was never received, so no client can persist it, and the
 *      token on disk is dead. The next run cannot recover; it must therefore be
 *      LOUD, surfacing a disable event naming the failure rather than quietly
 *      producing no credential.
 *   3. Killed while another process was mid-refresh. The survivor must not
 *      inherit an unbounded wait from the corpse's lease.
 *
 * The lease TTL is what bounds all of this, so these tests drive the real
 * `auth_credential_refresh_leases` table rather than a stand-in.
 */
describe("recovering the OAuth refresh path after a process was killed mid-refresh", () => {
	let tempDir = "";
	const closers: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-refresh-crash-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders(SOURCE_ID);
		for (const closer of closers.splice(0)) {
			try {
				closer.close();
			} catch {
				// already closed
			}
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Register a provider whose refresh either rotates or rejects, and report
	 * how many times the token endpoint was actually reached. */
	function registerProvider(
		provider: string,
		behaviour: { rotate: true; expires: number } | { rotate: false; error: string },
	): { calls: () => number } {
		let calls = 0;
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: provider,
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				calls += 1;
				if (!behaviour.rotate) throw new Error(behaviour.error);
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: behaviour.expires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		return { calls: () => calls };
	}

	it("takes over the lease a killed process left behind and refreshes normally", async () => {
		// Crash point 1: the dead process claimed the lease and died before ever
		// reaching the token endpoint, so the refresh token on disk is still good.
		// The lease it left is the only obstacle, and it must not be a permanent
		// one — nothing will ever release it, because its owner no longer exists.
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-crash-orphaned-lease";
		const refresh = registerProvider(provider, { rotate: true, expires: Date.now() + 60 * 60_000 });

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const auth = new AuthStorage(store);
		closers.push(auth);
		await auth.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		// The corpse's lease: taken, never released, with a little life left on it.
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "killed-process", Date.now() + 300)).toBe(true);

		expect(await auth.getApiKey(provider, "after-crash")).toBe("rotated-access");
		expect(refresh.calls()).toBe(1);
		const [row] = store.listAuthCredentials(provider);
		expect(row?.credential.type).toBe("oauth");
		if (row?.credential.type === "oauth") expect(row.credential.refresh).toBe("rotated-refresh");
	});

	it("releases the killed process's lease rather than leaving the row owned forever", async () => {
		// The corpse cannot release its own lease, so recovery depends entirely on
		// the row's expiry being honoured by the next acquire. Asserted directly
		// against the store so a change to the acquire guard cannot make an
		// orphaned lease permanent without failing here.
		const dbPath = path.join(tempDir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		store.saveApiKey("unit-crash-lease-expiry", "key-a");
		const credentialId = store.listAuthCredentials("unit-crash-lease-expiry")[0]!.id;

		const expiresAt = Date.now() + 120;
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "killed-process", expiresAt)).toBe(true);
		// While it is live, the survivor correctly waits rather than double-refreshing.
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "survivor", Date.now() + 15_000)).toBe(false);

		await Bun.sleep(200);

		expect(store.getCredentialRefreshLeaseExpiresAt(credentialId)).toBeUndefined();
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "survivor", Date.now() + 15_000)).toBe(true);
	});

	it("fails LOUDLY when the crash consumed the refresh token, instead of silently producing nothing", async () => {
		// Crash point 2, the documented residual: the provider rotated the token
		// and the process died before the response arrived, so what is on disk is
		// a token the provider has already invalidated. No client can recover a
		// token it never received. What it CAN do is say so — the credential is
		// disabled with a cause that names the failure and a `credential_disabled`
		// event fires, so the operator sees a reason instead of a login that
		// quietly stopped existing.
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-crash-consumed-token";
		const refresh = registerProvider(provider, {
			rotate: false,
			error: 'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const disabled: CredentialDisabledEvent[] = [];
		const auth = new AuthStorage(store, {
			onCredentialDisabled: event => {
				disabled.push(event);
			},
		});
		closers.push(auth);
		await auth.set(provider, [
			{ type: "oauth", access: "dead-access", refresh: "consumed-refresh", expires: Date.now() - 60_000 },
		]);

		expect(await auth.getApiKey(provider, "after-crash")).toBeUndefined();

		// Loud: exactly one disable, naming this provider and the provider's own
		// rejection. A bare "no API key found" with nothing in the event stream is
		// the failure mode this asserts against.
		//
		// EXACTLY one token call. `#resolveOAuthSelection` runs a best-effort
		// preflight refresh and `#tryOAuthCredential` owns the disable decision, so
		// the two used to refresh the same dead grant in sequence: a guaranteed
		// second 400 on every startup with a consumed token, and a full round trip
		// of delay before the operator was told anything. The preflight's
		// definitive verdict is now carried to the attempt loop instead of the
		// request being repeated. A transient failure still gets its second
		// attempt, which the next test covers.
		expect(refresh.calls()).toBe(1);
		expect(disabled).toHaveLength(1);
		expect(disabled[0]?.provider).toBe(provider);
		expect(disabled[0]?.disabledCause).toContain("invalid_grant");
	});

	it("does not disable a credential whose refresh fails transiently, so a crash plus an outage is not a logout", async () => {
		// The negative twin of the case above, and the more dangerous direction to
		// get wrong. A network failure during the recovery attempt looks like a
		// failed refresh too, and disabling on it would turn a five-second outage
		// into a forced re-login. Only a definitive dead-grant rejection may
		// disable the row.
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-crash-transient-failure";
		const refresh = registerProvider(provider, { rotate: false, error: "fetch failed: ECONNREFUSED" });

		const store = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(store);
		const disabled: CredentialDisabledEvent[] = [];
		const auth = new AuthStorage(store, {
			onCredentialDisabled: event => {
				disabled.push(event);
			},
		});
		closers.push(auth);
		await auth.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "still-good-refresh", expires: Date.now() - 60_000 },
		]);

		await auth.getApiKey(provider, "after-crash").catch(() => undefined);

		expect(disabled).toHaveLength(0);
		// THREE attempts, and each one is deliberate: the preflight refresh, the
		// first selection pass, and the last-resort pass that deliberately allows
		// blocked credentials (the transient failure blocks this one for five
		// minutes, and a single-credential user would otherwise be hard-failed for
		// that whole window over a blip that may already have cleared).
		//
		// The count is asserted because the dead-grant short-circuit must never
		// collapse this path: a transient failure is not a verdict about the
		// grant, so every retry that can still recover has to survive. If a later
		// change makes the last-resort pass skip a credential whose refresh just
		// failed, this becomes 2 and the reasoning above has to be revisited
		// first — it is an availability trade, not an oversight.
		expect(refresh.calls()).toBe(3);
		// The credential is still on disk with its refresh token intact, so the
		// next attempt once the network returns can still rotate it.
		const [row] = store.listAuthCredentials(provider);
		expect(row?.credential.type).toBe("oauth");
		if (row?.credential.type === "oauth") expect(row.credential.refresh).toBe("still-good-refresh");
	});

	it("lets the surviving process reuse the rotation a killed peer had already persisted", async () => {
		// Crash point 3. The dead process got far enough to persist the rotation
		// before it was killed, and only the lease outlived it. The survivor must
		// notice the row already moved forward and use that token, NOT replay its
		// own copy of the now-dead one, which would earn an invalid_grant and
		// disable a login that is perfectly alive.
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "unit-crash-peer-rotated";
		const refresh = registerProvider(provider, { rotate: true, expires: Date.now() + 60 * 60_000 });

		const crashedStore = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(crashedStore);
		const crashedAuth = new AuthStorage(crashedStore);
		closers.push(crashedAuth);
		await crashedAuth.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = crashedStore.listAuthCredentials(provider)[0]!.id;

		// The survivor opened the store before the crash and still holds the old
		// snapshot in memory, exactly as a second process would.
		const survivorStore = await SqliteAuthCredentialStore.open(dbPath);
		closers.push(survivorStore);
		const survivorAuth = new AuthStorage(survivorStore);
		closers.push(survivorAuth);
		await survivorAuth.reload();

		// The doomed process rotates, persists, and is killed with the lease held.
		expect(await crashedAuth.getApiKey(provider, "doomed")).toBe("rotated-access");
		expect(store_refreshToken(crashedStore, provider)).toBe("rotated-refresh");
		expect(crashedStore.tryAcquireCredentialRefreshLease(credentialId, "killed-process", Date.now() + 250)).toBe(
			true,
		);

		expect(await survivorAuth.getApiKey(provider, "survivor")).toBe("rotated-access");
		// The token endpoint was reached once in total: by the process that died.
		// A second call would mean the survivor replayed the dead token.
		expect(refresh.calls()).toBe(1);
	});
});

/** The refresh token currently on disk for a provider's single OAuth row. */
function store_refreshToken(store: SqliteAuthCredentialStore, provider: string): string | undefined {
	const [row] = store.listAuthCredentials(provider);
	return row?.credential.type === "oauth" ? row.credential.refresh : undefined;
}
