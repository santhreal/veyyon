/**
 * Session and provider routing state for `AuthStorage`: the sticky record of the credential that
 * served a session last, the session pin a user set, and the provider-wide account selection. Each
 * is held in memory, persisted through the credential store, and resolved to an index into the
 * rows loaded now.
 */

import * as logger from "@veyyon/utils/logger";
import { resolveAccountNameIdentity } from "../auth-credential-rows";
import type { StoredCredential } from "./credentials";
import type { AuthCredential, AuthCredentialStore } from "./types";

const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/**
 * Where a user's explicit account choice lives, kept apart from the sticky record above.
 *
 * The sticky record is ROUTING's own state: it is rewritten on every resolve and cleared
 * outright when a credential fails auth (`rotateSessionCredential`). A pin is the USER's
 * intent. Storing both in one row means rate-limit rotation silently overwrites the choice
 * the user made, and nothing is left to compare against, so the UI cannot say the account
 * changed under them. Two keys keeps the two facts separable, which is what makes the
 * divergence reportable instead of invisible.
 */
const SESSION_PIN_CACHE_PREFIX = "session:pin:";

/** How long a pin survives with no further use, matching the sticky record's window. */
const SESSION_PIN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A routed credential: its type and its index in the provider's loaded rows. */
export interface RoutedCredential {
	type: AuthCredential["type"];
	index: number;
}

/** A routed credential together with the row id it resolved from. */
export interface ChosenCredential extends RoutedCredential {
	credentialId: number;
}

export class CredentialRouting {
	readonly #store: AuthCredentialStore;
	readonly #rows: (provider: string) => StoredCredential[];
	/** `operation:provider` keys already warned about, so the warning fires once. */
	#reportedStickyCacheFailures = new Set<string>();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, Map<string, RoutedCredential>> = new Map();
	/**
	 * Explicit per-session account choice, mirroring the pin cache rows so the hot
	 * resolve path costs a map lookup rather than a store read per request.
	 */
	#sessionPinnedCredential: Map<string, Map<string, number>> = new Map();
	/**
	 * Global per-provider account choice, memoised. `null` means "asked the store, it has none",
	 * which is what keeps a provider without a choice from re-querying on every credential resolve.
	 */
	#providerSelection: Map<string, string | null> = new Map();

	/** `rows` returns the provider's loaded credential rows, in the order indices refer to. */
	constructor(store: AuthCredentialStore, rows: (provider: string) => StoredCredential[]) {
		this.#store = store;
		this.#rows = rows;
	}

	/**
	 * Records which credential served a session. The in-memory record is written whenever a
	 * session id is present; the persisted record only when the row id is known.
	 */
	recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		credentialId: number | undefined,
	): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			if (credentialId !== undefined) {
				const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId });
				// Expires in 30 days
				const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
				this.#store.setCache(cacheKey, cacheValue, expiresAtSec);
			}
		} catch (err) {
			this.reportStickyCacheFailure("write", provider, err);
		}
	}

	/**
	 * Report a session-stickiness cache failure LOUDLY, once per provider and
	 * operation, then let the request continue.
	 *
	 * All four of these paths used to be `logger.debug` and carry on, which is a
	 * silent fallback: the request still succeeds, so nothing looks wrong, but
	 * session stickiness has stopped working. Stickiness is what keeps one session
	 * pinned to one credential, so losing it means a conversation can hop between
	 * accounts mid-flight — the same wrong-account routing the index-only cache
	 * rows are explicitly dropped to prevent, arrived at by a different route. An
	 * operator debugging "why did this session switch accounts" would find nothing
	 * above debug level.
	 *
	 * Not fail-closed: a cache that cannot be written must not take down a request
	 * that is otherwise fine. Loud, bounded and recorded instead, which is the form
	 * of degrade this codebase does allow. Bounded matters here, because the usual
	 * cause is a store that is broken for the whole process (read-only file, disk
	 * full), and warning on every request would bury the line it is trying to make
	 * visible. The first failure per provider and operation warns; the rest are
	 * debug, so the signal survives without the flood.
	 */
	reportStickyCacheFailure(operation: string, provider: string, error: unknown): void {
		const key = `${operation}:${provider}`;
		const alreadyReported = this.#reportedStickyCacheFailures.has(key);
		this.#reportedStickyCacheFailures.add(key);
		const detail = {
			provider,
			operation,
			error: String(error),
		};
		if (alreadyReported) {
			logger.debug("Session sticky credential cache still failing", detail);
			return;
		}
		logger.warn(
			"Session sticky credential cache failed; this session is no longer pinned to one credential and may route to a different account",
			detail,
		);
	}

	/**
	 * Resolve a pin to a live credential index, dropping a pin whose credential is gone.
	 *
	 * Stored by row id, resolved to an index on every read, exactly like the sticky
	 * record: an index alone is meaningless once the row set changes, and honouring a
	 * stale one routes the session to somebody else's account.
	 */
	getSessionCredentialPin(provider: string, sessionId: string | undefined): ChosenCredential | undefined {
		if (!sessionId) return this.getSelectedCredential(provider);
		let credentialId = this.#sessionPinnedCredential.get(provider)?.get(sessionId);
		if (credentialId === undefined) {
			try {
				const raw = this.#store.getCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`);
				if (!raw) return this.getSelectedCredential(provider);
				const parsed = JSON.parse(raw) as { credentialId?: number };
				if (typeof parsed.credentialId !== "number") return this.getSelectedCredential(provider);
				credentialId = parsed.credentialId;
				const pinMap = this.#sessionPinnedCredential.get(provider) ?? new Map<string, number>();
				pinMap.set(sessionId, credentialId);
				this.#sessionPinnedCredential.set(provider, pinMap);
			} catch (err) {
				this.reportStickyCacheFailure("pin-read", provider, err);
				return this.getSelectedCredential(provider);
			}
		}
		const stored = this.#rows(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index === -1) {
			// The pinned account was logged out or replaced. Forget the pin rather than
			// leave a dangling id that would be re-resolved on every request.
			this.clearSessionCredentialPin(provider, sessionId);
			return this.getSelectedCredential(provider);
		}
		const credential = stored[index]?.credential;
		if (!credential) return this.getSelectedCredential(provider);
		return { type: credential.type, index, credentialId };
	}

	/**
	 * The credential this session prefers: an explicit user pin when one resolves,
	 * otherwise the last credential routing actually used.
	 *
	 * The pin is checked FIRST and this is the only place that decides it, because every
	 * consumer of session preference goes through here (OAuth selection, account-identity
	 * display, rotation, usage attribution). Honouring the pin at one chokepoint is what
	 * makes `/account` switching real rather than cosmetic: a pin the resolver ignored
	 * would show the new account in the UI while requests kept using the old one.
	 */
	getSessionCredential(provider: string, sessionId: string | undefined): RoutedCredential | undefined {
		// No early return on a missing session id: the GLOBAL selection is not session state, and a
		// caller with no session (a one-shot CLI, an agent role resolving outside a session) must
		// still route to the account the user picked.
		const pinned = this.getSessionCredentialPin(provider, sessionId);
		if (pinned) return { type: pinned.type, index: pinned.index };
		return this.getStickySessionCredential(provider, sessionId);
	}

	/**
	 * The credential this session LAST ACTUALLY USED, ignoring any pin.
	 *
	 * Separate from {@link CredentialRouting.getSessionCredential} because two different questions
	 * are being asked and answering both with the pin makes one of them un-askable: "what
	 * should serve the next request" is the pin, but "what served the last one" is this, and
	 * `sessionCredentialRouting` needs the second to notice the two have diverged. Reading the
	 * pin for both is how a rate-limit rotation reports itself as the user's own choice.
	 */
	getStickySessionCredential(provider: string, sessionId: string | undefined): RoutedCredential | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap?.has(sessionId)) {
			return sessionMap.get(sessionId);
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as { type: AuthCredential["type"]; index: number; credentialId?: number };

				if (val.credentialId !== undefined) {
					const stored = this.#rows(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionLastCredential.set(provider, sessionMap);
				}
				const sessionVal = { type: val.type, index: val.index };
				sessionMap.set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			this.reportStickyCacheFailure("read", provider, err);
		}
		return undefined;
	}

	/**
	 * The in-memory record of the credential that served this session, without reading the
	 * persisted record.
	 */
	peekStickySessionCredential(provider: string, sessionId: string): RoutedCredential | undefined {
		return this.#sessionLastCredential.get(provider)?.get(sessionId);
	}

	/** Deletes the in-memory record of the credential that served this session. */
	forgetStickySessionCredential(provider: string, sessionId: string): void {
		this.#sessionLastCredential.get(provider)?.delete(sessionId);
	}

	/** Clears the last credential used by a session for a provider. */
	clearSessionCredential(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			this.reportStickyCacheFailure("clear", provider, err);
		}
	}

	/**
	 * Deletes every session's record of the credential that served it for one provider, in
	 * memory and in the store.
	 */
	clearProviderSessionCredentials(provider: string): void {
		this.#sessionLastCredential.delete(provider);
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			this.reportStickyCacheFailure("clear-provider", provider, err);
		}
	}

	/** See {@link AuthStorage.pinSessionCredential}. */
	pinSessionCredential(provider: string, sessionId: string | undefined, credentialId: number): boolean {
		if (!sessionId) return false;
		const stored = this.#rows(provider);
		if (!stored.some(entry => entry.id === credentialId)) return false;
		const pinMap = this.#sessionPinnedCredential.get(provider) ?? new Map<string, number>();
		pinMap.set(sessionId, credentialId);
		this.#sessionPinnedCredential.set(provider, pinMap);
		try {
			this.#store.setCache(
				`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`,
				JSON.stringify({ credentialId }),
				Math.floor(Date.now() / 1000) + SESSION_PIN_TTL_SECONDS,
			);
		} catch (err) {
			// The in-memory pin still holds for this process, so the switch the user just
			// made does take effect; it simply will not survive a restart. Loud, because a
			// pin that quietly evaporates looks like the switch was ignored.
			this.reportStickyCacheFailure("pin-write", provider, err);
		}
		// Drop the routing record so the next resolve re-ranks from the pin instead of
		// re-using whichever credential served the previous request.
		this.clearSessionCredential(provider, sessionId);
		return true;
	}

	/** See {@link AuthStorage.clearSessionCredentialPin}. */
	clearSessionCredentialPin(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const pinMap = this.#sessionPinnedCredential.get(provider);
		if (pinMap) {
			pinMap.delete(sessionId);
			if (pinMap.size === 0) this.#sessionPinnedCredential.delete(provider);
		}
		try {
			this.#store.setCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`, "", 0);
		} catch (err) {
			this.reportStickyCacheFailure("pin-clear", provider, err);
		}
	}

	/**
	 * The account identity chosen for a provider, memoised per process.
	 *
	 * `null` in the memo means "the store was asked and has none", so a provider with no choice
	 * costs one query per process rather than one per credential resolve.
	 */
	#readProviderSelection(provider: string): string | undefined {
		const memo = this.#providerSelection.get(provider);
		if (memo !== undefined) return memo ?? undefined;
		const read = this.#store.getProviderSelection;
		const identity = read ? read.call(this.#store, provider) : undefined;
		this.#providerSelection.set(provider, identity ?? null);
		return identity;
	}

	/**
	 * The globally selected credential of a provider, resolved against the rows loaded now.
	 *
	 * Resolved on every read rather than cached as an index, for the same reason the pin is: an
	 * index is meaningless once the row set changes, and honouring a stale one routes to somebody
	 * else's account. A selection naming an account that is no longer stored resolves to nothing
	 * and is deliberately LEFT in the store — a re-login rewrites the row under the same identity,
	 * and forgetting the choice in between would silently move the user to a different account.
	 */
	getSelectedCredential(provider: string): ChosenCredential | undefined {
		const identity = this.#readProviderSelection(provider);
		if (!identity) return undefined;
		const stored = this.#rows(provider);
		const index = stored.findIndex(entry => resolveAccountNameIdentity(provider, entry) === identity);
		const entry = index === -1 ? undefined : stored[index];
		if (!entry) return undefined;
		return { type: entry.credential.type, index, credentialId: entry.id };
	}

	/** See {@link AuthStorage.selectProviderCredential}. */
	selectProviderCredential(provider: string, credentialId: number, sessionId: string | undefined): boolean {
		const entry = this.#rows(provider).find(row => row.id === credentialId);
		if (!entry) return false;
		const identity = resolveAccountNameIdentity(provider, entry);
		this.#providerSelection.set(provider, identity);
		const write = this.#store.setProviderSelection;
		if (write) {
			try {
				write.call(this.#store, provider, identity);
			} catch (err) {
				// The in-process choice still holds, so the switch the user just made does take
				// effect; it simply will not survive a restart. Loud, because a choice that quietly
				// evaporates looks like the switch was ignored.
				this.reportStickyCacheFailure("selection-write", provider, err);
			}
		}
		// A session pin would outrank the global choice at the chokepoint, so the switch the user
		// just made must retire it rather than sit behind it.
		this.clearSessionCredentialPin(provider, sessionId);
		this.clearSessionCredential(provider, sessionId);
		return true;
	}

	/** See {@link AuthStorage.clearProviderSelection}. */
	clearProviderSelection(provider: string, sessionId: string | undefined): void {
		this.#providerSelection.set(provider, null);
		const clear = this.#store.clearProviderSelection;
		if (clear) {
			try {
				clear.call(this.#store, provider);
			} catch (err) {
				this.reportStickyCacheFailure("selection-clear", provider, err);
			}
		}
		this.clearSessionCredential(provider, sessionId);
	}
}
