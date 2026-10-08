/**
 * OAuth token refresh for `AuthStorage`: the per-credential single-flight, the cross-process
 * refresh lease with its renewal loop, adoption of a token a peer process already rotated, and
 * the bounded call to the provider's token endpoint.
 */

import * as logger from "@veyyon/utils/logger";
import { clamp } from "@veyyon/utils/math";
import * as AIError from "../error";
import { getOAuthProvider, refreshOAuthToken } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import { raceWithSignal } from "../utils/abort";
import type { AuthCredential, AuthCredentialStore, AuthStorageOptions, OAuthCredential } from "./types";

const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link AuthStorage} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
export const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
export const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;

export class OAuthRefresher {
	readonly #store: AuthCredentialStore;
	readonly #override: AuthStorageOptions["refreshOAuthCredential"];
	readonly #persistRefreshedCredentialById: (provider: string, id: number, credential: AuthCredential) => void;
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();

	/**
	 * `override` replaces the store hook and the local provider refresh when set.
	 * `persistRefreshedCredentialById` writes a rotated credential onto its row.
	 */
	constructor(
		store: AuthCredentialStore,
		override: AuthStorageOptions["refreshOAuthCredential"],
		persistRefreshedCredentialById: (provider: string, id: number, credential: AuthCredential) => void,
	) {
		this.#store = store;
		this.#override = override;
		this.#persistRefreshedCredentialById = persistRefreshedCredentialById;
	}

	/** Whether the store exposes the full durable-lease surface both fenced paths need. */
	storeSupportsDurableLease(): boolean {
		return (
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease
		);
	}

	/**
	 * Run `fn` while holding a refresh lease, renewing it in the background so a
	 * refresh slower than the lease TTL does not lose ownership mid-flight.
	 *
	 * The ownership loss is REPORTED alongside the result, never thrown. By the time
	 * it is known the provider has usually already spent the single-use refresh token,
	 * and throwing would discard a rotation that can never be obtained again, which is
	 * the "logged out after a rebuild" failure the lease exists to prevent. Each caller
	 * decides what a lost lease means for its own persist.
	 *
	 * `credentialId === undefined` means the refresh is not lease-fenced at all (the
	 * store lacks the durable-lease surface, or the row was never leased), so no
	 * renewal loop runs and `ownershipLost` is always undefined.
	 *
	 * This is the one renewal loop. Both fenced refresh paths, `#leaseFencedRefresh`
	 * for model providers and `refreshStoredOAuthCredential` for MCP, go through it.
	 */
	async withRefreshLeaseRenewal<T>(
		credentialId: number | undefined,
		owner: string,
		fn: () => Promise<T>,
	): Promise<{ result: T; ownershipLost: unknown }> {
		if (credentialId === undefined) return { result: await fn(), ownershipLost: undefined };
		let stop = false;
		let ownershipLost: unknown;
		// The renewal loop must wake IMMEDIATELY when the refresh finishes, not at the
		// end of its current sleep. Waiting out a full renew interval would delay the
		// rotation's persistence by seconds — long enough for a caller that already
		// aborted to be gone, and long enough to be a latency bug on every refresh even
		// when nothing goes wrong.
		const stopped = Promise.withResolvers<void>();
		const renewal = (async () => {
			while (!stop) {
				await Promise.race([Bun.sleep(OAUTH_REFRESH_LEASE_RENEW_MS), stopped.promise]);
				if (stop) return;
				const renewed = this.#store.renewCredentialRefreshLease?.(
					credentialId,
					owner,
					Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
				);
				if (!renewed) {
					ownershipLost = new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
					return;
				}
			}
		})().catch(error => {
			ownershipLost = error;
		});

		// The teardown runs in `finally` so it happens on every path, but nothing is
		// raised from inside it: a `throw` in `finally` replaces whatever the block was
		// already doing, so when `fn` itself fails it would discard that error and
		// report a generic ownership one in its place, hiding the actual cause.
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			stop = true;
			stopped.resolve();
			await renewal;
			if (ownershipLost !== undefined) {
				// `fn`'s error is the one that explains the failure and the one the caller
				// gets. This one is real too and only one can be thrown, so surface it
				// rather than dropping it (Law 10).
				logger.warn("OAuth refresh lost its lease while already failing", {
					credentialId,
					owner,
					ownershipError: String(ownershipLost),
				});
			}
			throw error;
		}
		stop = true;
		stopped.resolve();
		await renewal;
		return { result, ownershipLost };
	}

	/**
	 * The credential a PEER already rotated, if one exists and is usable.
	 *
	 * Reads by id including disabled rows, because the peer's winning row may be the
	 * one a loser disabled. Returns it only when the row still belongs to the provider
	 * we are refreshing, the refresh token actually differs from what we hold (proof of
	 * a rotation, not a re-read of our own row), and it is not about to expire, so we
	 * never hand back a token that would immediately need refreshing again.
	 *
	 * The provider check is what makes reading by a bare id safe. Nothing in the
	 * lookup constrains WHICH provider the returned row belongs to: `readAuthCredentialById`
	 * is an optional method on the `AuthCredentialStore` interface, so the row comes
	 * from whatever store is plugged in, and the ids in the shipped SQLite store are
	 * not the only ones that can appear there — the explicit-id INSERT paths used by
	 * migration and import write ids chosen elsewhere. A row for another provider is
	 * a live, unexpired OAuth credential whose refresh token differs from ours, which
	 * is exactly the signature this function reads as "a peer rotated it", so without
	 * the check that provider's token would be returned here and sent upstream as
	 * ours. Refuse, loudly (Law 10), instead of falling through to a credential that
	 * merely has the right shape.
	 *
	 * (The shipped `SqliteAuthCredentialStore` declares `id INTEGER PRIMARY KEY
	 * AUTOINCREMENT`, so it will not hand a freed id back on its own. This is a
	 * boundary check on the interface, not a fix for a race in that one store.)
	 */
	#freshRotatedCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
	): OAuthCredentials | undefined {
		const readById = this.#store.readAuthCredentialById?.bind(this.#store);
		if (!readById) return undefined;
		const latest = readById(credentialId);
		if (latest?.credential.type !== "oauth") return undefined;
		if (latest.provider !== provider) {
			// Names only: the row is somebody else's credential, and nothing about its
			// contents belongs in a log.
			logger.warn("OAuth credential row changed provider mid-refresh; refusing the peer's token", {
				credentialId,
				expectedProvider: provider,
				storedProvider: latest.provider,
			});
			return undefined;
		}
		const rotated = latest.credential;
		if (rotated.refresh === previous.refresh) return undefined;
		if (Date.now() + OAUTH_REFRESH_SKEW_MS >= rotated.expires) return undefined;
		return rotated;
	}

	/**
	 * Merge a rotated credential onto the row and persist it, independently of
	 * whatever the caller is doing.
	 *
	 * This exists because the caller's `await` can be abandoned — a shutdown, a
	 * rebuild, or an ESC aborts the caller while the refresh itself keeps going and
	 * resolves a moment later with a rotated, single-use token. If only the caller
	 * persisted, that token would be lost while the provider had already invalidated
	 * the old one, and the NEXT run would refresh with a dead token, be told
	 * `invalid_grant`, and permanently disable a perfectly good login. Committing
	 * here, inside the single-flight, makes the rotation durable no matter who is
	 * still listening.
	 */
	#commitRotatedOAuthCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
		refreshed: OAuthCredentials,
	): void {
		// Never clobber a peer that rotated FORWARD while we were in flight. Our write
		// can land arbitrarily late (the caller may have aborted seconds ago), and the
		// stored row may by then hold a strictly newer single-use token. Overwriting it
		// with ours would spend the peer's rotation for nothing and put a dead token on
		// disk, which is the very failure this path exists to prevent.
		const peerFresh = this.#freshRotatedCredential(provider, credentialId, previous);
		if (peerFresh && peerFresh.refresh !== refreshed.refresh) return;

		const merged: OAuthCredential = { ...previous, ...refreshed, type: "oauth" };
		this.#persistRefreshedCredentialById(provider, credentialId, merged);
	}

	/**
	 * Refresh under a CROSS-PROCESS lease, so a single-use refresh token is spent
	 * exactly once even when several veyyon processes share one credential store.
	 *
	 * The in-process single-flight cannot help here: the racing refreshes live in
	 * different processes. Whoever takes the lease refreshes; everyone else waits and
	 * then reads the peer's rotated token instead of burning their own now-dead one.
	 * That converts the rotation race from something to be healed after the fact into
	 * something that cannot happen.
	 *
	 * Note carefully what `signal` gates: ONLY the wait for ownership. Once the
	 * refresh is under way it must run to completion and persist, because aborting
	 * after the provider has rotated the token would strand it — the same loss this
	 * whole path exists to prevent.
	 */
	async #leaseFencedRefresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (!this.storeSupportsDurableLease()) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, credentialId);
		}

		const owner = crypto.randomUUID();
		for (;;) {
			if (signal?.aborted) throw new AIError.RequestAbortError("OAuth refresh ownership aborted by caller");
			// A peer may have finished while we waited; prefer its token over spending ours.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;
			if (
				this.#store.tryAcquireCredentialRefreshLease?.(credentialId, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)
			) {
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(credentialId);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: clamp(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS, 250);
			await raceWithSignal(Bun.sleep(waitMs), signal, "OAuth refresh ownership wait aborted by caller");
		}

		try {
			// Re-check under the lease: a peer may have rotated between our last check
			// and acquiring ownership.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;

			const { result: refreshed, ownershipLost } = await this.withRefreshLeaseRenewal(credentialId, owner, () =>
				this.#refreshOAuthCredentialUnshared(provider, credential, credentialId),
			);

			if (ownershipLost !== undefined) {
				// The token is already rotated and the old one is dead at the provider, so
				// discarding it here would guarantee the logout. Commit on the data CAS
				// alone, then prefer whatever the store ended up holding.
				logger.warn("OAuth refresh lease lost mid-rotation; reconciling against the stored row", {
					provider,
					credentialId,
				});
				this.#commitRotatedOAuthCredential(provider, credentialId, credential, refreshed);
				const winner = this.#freshRotatedCredential(provider, credentialId, credential);
				if (winner) return winner;
			}
			return refreshed;
		} finally {
			this.#store.releaseCredentialRefreshLease?.(credentialId, owner);
		}
	}

	/**
	 * The credential with a usable access token: `credential` itself while it is outside the
	 * refresh skew, else a refreshed one. Concurrent refreshes of one row share one flight.
	 */
	async refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceWithSignal(existing, signal, "credential refresh aborted");
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal);
		}
		const id = credentialId;
		const promise = this.#leaseFencedRefresh(provider, credential, id, signal)
			.then(refreshed => {
				// Commit as a SAFETY NET for the one case the caller cannot cover: its own
				// abort. Normally the caller that awaited this refresh persists the
				// credential itself, and it often knows more than we do here (the usage path
				// adds the provider's resolved `apiEndpoint`), so writing again would be
				// both redundant and less complete.
				//
				// When the caller aborted, though, nobody persists. The refresh still
				// completed and the provider has already invalidated the old token, so
				// leaving it on disk is exactly the "logged out after a rebuild" failure:
				// the next run refreshes with a dead token, gets `invalid_grant`, and
				// disables a perfectly good login. So commit precisely then.
				if (signal?.aborted) {
					this.#commitRotatedOAuthCredential(provider, id, credential, refreshed);
				}
				return refreshed;
			})
			.finally(() => {
				this.#oauthCredentialRefreshInFlight.delete(id);
			});
		this.#oauthCredentialRefreshInFlight.set(id, promise);
		return raceWithSignal(promise, signal, "credential refresh aborted");
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;
		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#override ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal);
		} else {
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				if (!customProvider.refreshToken) {
					throw new AIError.OAuthError(`OAuth provider "${provider}" does not support token refresh`, {
						kind: "configuration",
						provider,
					});
				}
				refreshPromise = customProvider.refreshToken(credential);
			} else {
				refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential);
			}
		}
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cancellation = Promise.withResolvers<never>();
		timeout = setTimeout(
			() =>
				cancellation.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			return await Promise.race([refreshPromise, cancellation.promise]);
		} finally {
			clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
}
