import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type CredentialDisabledEvent, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-oauth-refresh-lease-renewal-test";

/**
 * Mirrors `OAUTH_REFRESH_LEASE_RENEW_MS` in auth-storage.ts (module-private). Every
 * test that needs the lease to lapse mid-refresh has to outlast one renewal tick, so
 * those tests are deliberately slow; keep this in sync if the source constant changes.
 */
const LEASE_RENEW_TICK_MS = 5_000;

/**
 * Both fenced refresh paths renew the lease through ONE helper
 * (`#withRefreshLeaseRenewal`), and these tests pin the contract that helper owes
 * its callers.
 *
 * There used to be two copies of the renewal loop, one per path, and they disagreed
 * about the most important case. The model-provider copy raised the ownership loss
 * from inside a `finally`, which means that when the refresh ITSELF failed, the
 * `throw` in `finally` replaced the refresh's error with a generic "OAuth refresh
 * ownership was lost before persistence". The real cause was destroyed on the way
 * out: an expired refresh token, a network failure, and a provider outage all
 * reported the same lease message, and the only actionable detail never reached a
 * log or a user. The MCP copy recorded the loss instead of throwing it, so identical
 * situations produced different errors depending on which path you came in through.
 *
 * The helper now REPORTS the loss alongside the result and never throws it, so
 * `fn`'s error always survives, and both paths get the same answer.
 *
 * The neighbouring auth-storage-oauth-refresh-lease-fence.test.ts covers the other
 * half: that a lease lost after a SUCCESSFUL rotation still persists the new token.
 */
describe("A lost refresh lease is reported to the caller, never thrown over the refresh's own error", () => {
	let tempDir = "";
	const closers: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-lease-renewal-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders(SOURCE_ID);
		for (const c of closers.splice(0)) {
			try {
				c.close();
			} catch {
				// A store closed by the test itself is fine.
			}
		}
		if (tempDir) await removeWithRetries(tempDir);
	});

	/** Store whose lease API is real, with a credential already expired so a refresh is due. */
	async function seedExpiredCredential(provider: string) {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		closers.push(store);
		const authStorage = new AuthStorage(store);
		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		return { store, authStorage };
	}

	test(
		"the MCP path surfaces the refresh's own error when the lease is lost at the same time",
		async () => {
			const provider = "unit-oauth-renewal-mcp-error";
			const { store, authStorage } = await seedExpiredCredential(provider);
			// The lease lapses and a peer steals the row: every renewal fails from here.
			vi.spyOn(store, "renewCredentialRefreshLease").mockReturnValue(false);

			const thrown = await authStorage
				.refreshStoredOAuthCredential(provider, {
					credentialFromRow: credential => credential,
					async refresh() {
						// Outlast the renewal tick so the ownership loss is recorded BEFORE
						// this throws, which is the exact ordering that used to clobber it.
						await Bun.sleep(LEASE_RENEW_TICK_MS + 400);
						throw new Error("refresh_token_expired: the identity provider rejected the token");
					},
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);

			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toContain("refresh_token_expired");
			// The generic lease message must not have replaced it.
			expect((thrown as Error).message).not.toContain("ownership");
		},
		LEASE_RENEW_TICK_MS * 4,
	);

	test(
		"the model-provider path classifies on the refresh's own error, not on a lost lease",
		async () => {
			// getApiKey does not rethrow: it CLASSIFIES the refresh error, and a revoked
			// grant is the one case that disables the row instead of blocking it for five
			// minutes. Replacing that error with "ownership was lost before persistence"
			// made every revoked credential look transient, so it stayed enabled and was
			// retried forever, and the cause recorded on the row named the lease rather
			// than the revocation. The disabled cause is the operator's only view of why.
			const provider = "unit-oauth-renewal-provider-error";
			oauthUtils.registerOAuthProvider({
				id: provider,
				name: "Unit OAuth Renewal Provider Error",
				sourceId: SOURCE_ID,
				async login() {
					return { access: "unused", refresh: "unused", expires: Date.now() + 60_000 };
				},
				async refreshToken() {
					// Outlast the renewal tick so the ownership loss is recorded BEFORE
					// this throws, which is the exact ordering that used to clobber it.
					await Bun.sleep(LEASE_RENEW_TICK_MS + 400);
					throw new Error("invalid_grant: refresh token has been revoked");
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});
			const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			closers.push(store);
			const disabled: CredentialDisabledEvent[] = [];
			const authStorage = new AuthStorage(store, {
				onCredentialDisabled: event => {
					disabled.push(event);
				},
			});
			await authStorage.set(provider, [
				{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
			]);
			vi.spyOn(store, "renewCredentialRefreshLease").mockReturnValue(false);

			const key = await authStorage.getApiKey(provider, "renewal-session");

			expect(key).toBeUndefined();
			expect(disabled).toHaveLength(1);
			expect(disabled[0]?.disabledCause).toContain("invalid_grant");
			expect(disabled[0]?.disabledCause).not.toContain("ownership");
			expect(store.listAuthCredentials(provider)).toHaveLength(0);
		},
		LEASE_RENEW_TICK_MS * 4,
	);

	test(
		"a caller that keeps its credential on refresh failure still keeps it when the lease is also lost",
		async () => {
			// The keep decision is made INSIDE the renewal helper now and its answer has
			// to cross that boundary intact. If the helper threw the ownership loss, this
			// caller would see a hard failure instead of the credential it asked to keep,
			// and a transient network blip would read as a logout.
			const provider = "unit-oauth-renewal-keep";
			const { store, authStorage } = await seedExpiredCredential(provider);
			vi.spyOn(store, "renewCredentialRefreshLease").mockReturnValue(false);
			const failures: unknown[] = [];

			const result = await authStorage.refreshStoredOAuthCredential(provider, {
				credentialFromRow: credential => credential,
				keepCredentialOnRefreshFailure: true,
				onRefreshFailure: error => failures.push(error),
				async refresh() {
					await Bun.sleep(LEASE_RENEW_TICK_MS + 400);
					throw new Error("network_unreachable");
				},
			});

			expect(result.refreshed).toBe(false);
			expect(result.removed).toBe(false);
			expect(result.credential?.access).toBe("stale-access");
			expect(result.credential?.refresh).toBe("stale-refresh");
			expect(failures).toHaveLength(1);
			expect(String(failures[0])).toContain("network_unreachable");
			// The row is untouched and still usable.
			const active = store.listAuthCredentials(provider);
			expect(active).toHaveLength(1);
			expect(active[0]?.disabledCause).toBe(null);
		},
		LEASE_RENEW_TICK_MS * 4,
	);

	/**
	 * A definitive failure (the provider says the grant is dead) must still disable the
	 * row. This is the second answer that crosses the helper boundary as a value rather
	 * than a throw, and getting it wrong would leave a permanently dead credential
	 * enabled and retried on every request.
	 */
	test("a definitive refresh failure still disables the row through the shared renewal helper", async () => {
		const provider = "unit-oauth-renewal-definitive";
		const { store, authStorage } = await seedExpiredCredential(provider);

		const result = await authStorage.refreshStoredOAuthCredential(provider, {
			credentialFromRow: credential => credential,
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			async refresh() {
				throw new Error("invalid_grant: refresh token has been revoked");
			},
		});

		expect(result.removed).toBe(true);
		expect(result.refreshed).toBe(false);
		expect(result.credential).toBeUndefined();
		expect(store.listAuthCredentials(provider)).toHaveLength(0);
	});

	/**
	 * The fast path. A refresh that finishes inside one renewal tick never loses the
	 * lease, so the helper must add nothing: same rotated token, persisted, no warning
	 * path taken. Without this the other tests here could all pass against a helper
	 * that reported a loss on every single refresh.
	 */
	test("a refresh that keeps its lease rotates and persists exactly as before", async () => {
		const provider = "unit-oauth-renewal-happy";
		const rotatedExpires = Date.now() + 60 * 60_000;
		const { store, authStorage } = await seedExpiredCredential(provider);
		let refreshCalls = 0;

		const result = await authStorage.refreshStoredOAuthCredential(provider, {
			credentialFromRow: credential => credential,
			async refresh(credential) {
				refreshCalls++;
				return { ...credential, access: "fresh-access", refresh: "fresh-refresh", expires: rotatedExpires };
			},
		});

		expect(refreshCalls).toBe(1);
		expect(result.refreshed).toBe(true);
		expect(result.credential?.access).toBe("fresh-access");
		expect(result.credential?.refresh).toBe("fresh-refresh");
		const active = store.listAuthCredentials(provider);
		expect(active).toHaveLength(1);
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.access).toBe("fresh-access");
			expect(active[0].credential.refresh).toBe("fresh-refresh");
		}
	});

	/**
	 * The lease is released even when the refresh throws. The release lives in the
	 * caller's `finally`, and a helper that swallowed or reordered the throw could skip
	 * it, stranding the row under a lease nobody holds until the TTL lapses. The proof
	 * is that a second refresh acquires immediately and succeeds.
	 */
	test("a failed refresh releases the lease, so the next attempt is not blocked", async () => {
		const provider = "unit-oauth-renewal-release";
		const { store, authStorage } = await seedExpiredCredential(provider);

		await authStorage
			.refreshStoredOAuthCredential(provider, {
				credentialFromRow: credential => credential,
				async refresh() {
					throw new Error("transient_failure");
				},
			})
			.catch(() => undefined);

		const retry = await authStorage.refreshStoredOAuthCredential(provider, {
			credentialFromRow: credential => credential,
			async refresh(credential) {
				return { ...credential, access: "retry-access", refresh: "retry-refresh", expires: Date.now() + 3_600_000 };
			},
		});

		expect(retry.refreshed).toBe(true);
		expect(retry.credential?.access).toBe("retry-access");
		const active = store.listAuthCredentials(provider);
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.refresh).toBe("retry-refresh");
		}
	});
});
