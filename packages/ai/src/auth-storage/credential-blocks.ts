/**
 * Temporary rate-limit blocks on credentials: the in-memory deadline per `provider:type` key and
 * credential index, the earliest time live usage may clear a fresh block, and the persisted copy
 * read and written through the credential store.
 */

import * as logger from "@veyyon/utils/logger";
import { USAGE_REPORT_TTL_MS } from "../auth-credential-rows";
import { isRecordFromFutureClock } from "../credential-clock";
import type { StoredCredential } from "./credentials";
import { toScopedBackoffKey } from "./credentials";
import type { AuthCredentialStore } from "./types";

/** One in-memory rate-limit block: its deadline plus the clock reading that set it. */
interface InMemoryCredentialBlock {
	/** Epoch milliseconds the credential becomes usable again. */
	blockedUntilMs: number;
	/** Epoch milliseconds the block was set, used to detect a backward clock jump. */
	blockedAtMs: number;
}

export class CredentialBlocks {
	readonly #store: AuthCredentialStore;
	readonly #rows: (provider: string) => StoredCredential[];
	readonly #onBlocked: (provider: string) => void;
	/**
	 * Maps provider:type -> credentialIndex -> the temporary backoff entry.
	 *
	 * The write time rides along with the deadline so a backward clock jump can
	 * be detected on read; see {@link isRecordFromFutureClock}.
	 */
	#credentialBackoff: Map<string, Map<number, InMemoryCredentialBlock>> = new Map();
	/** Earliest time a freshly-set in-memory block may be cleared by live usage reconciliation. */
	#credentialBackoffProbeAfter: Map<string, Map<number, number>> = new Map();

	/**
	 * `rows` returns the provider's loaded credential rows, in the order indices refer to.
	 * `onBlocked` runs after a block is recorded in memory and before it is persisted.
	 */
	constructor(
		store: AuthCredentialStore,
		rows: (provider: string) => StoredCredential[],
		onBlocked: (provider: string) => void,
	) {
		this.#store = store;
		this.#rows = rows;
		this.#onBlocked = onBlocked;
	}

	/** Returns in-memory block expiry timestamp for a credential/key pair, cleaning up expired entries. */
	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number, nowMs: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const entry = backoffMap.get(credentialIndex);
		if (!entry?.blockedUntilMs) return undefined;
		const { blockedUntilMs: blockedUntil, blockedAtMs } = entry;
		// A block written by a clock ahead of this one has a deadline measured in
		// units this clock no longer shares, so honouring it would block the
		// credential for the length of the jump. Drop it exactly like an expired
		// one; the provider re-blocks on the next real rate-limit response.
		if (blockedUntil <= nowMs || isRecordFromFutureClock(blockedAtMs, nowMs)) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(backoffKey);
			}
			const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey);
			probeAfterMap?.delete(credentialIndex);
			if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(backoffKey);
			return undefined;
		}
		return blockedUntil;
	}

	#readPersistedCredentialBlock(
		credentialId: number,
		providerKey: string,
		blockScope: string | undefined,
	): number | undefined {
		const getCredentialBlock = this.#store.getCredentialBlock?.bind(this.#store);
		if (!getCredentialBlock) return undefined;
		try {
			return getCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			logger.debug("Failed to read credential block from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return undefined;
		}
	}

	/** Returns block expiry timestamp for a credential, checking unscoped and scoped blocks. */
	getCredentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): number | undefined {
		const nowMs = Date.now();
		let blockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialIndex, nowMs);
		if (blockScope) {
			const scopedBlockedUntil = this.#getCredentialBlockedUntilForKey(
				toScopedBackoffKey(providerKey, blockScope),
				credentialIndex,
				nowMs,
			);
			if (scopedBlockedUntil !== undefined && (blockedUntil === undefined || scopedBlockedUntil > blockedUntil)) {
				blockedUntil = scopedBlockedUntil;
			}
		}

		const credentialId = this.#rows(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return blockedUntil;
		// The one place where the persisted read deliberately DIVERGES from the
		// in-memory read above, which honours an unscoped block under every scope.
		// The asymmetry is about where each copy can have come from, so it is not
		// the inconsistency it looks like:
		//
		//  - An in-memory unscoped block was written by THIS process, by one of the
		//    three credential-wide writers (a transient token-refresh failure, or a
		//    rotate-away after an upstream rejection). Those really are global — the
		//    credential itself is unusable — so every scope must see them.
		//  - A PERSISTED unscoped row for `openai-codex` may instead be LEGACY data:
		//    older versions recorded Codex rate-limit windows without a scope, so a
		//    row that reads as "globally blocked for a week" may really have been one
		//    quota window. Honouring it under a scope would strand an account that a
		//    scoped read can see is fine, for as long as the stale deadline runs.
		//
		// Hence: a scoped Codex read skips the persisted global row and trusts the
		// scoped one. Pinned by `auth-storage-global-block-scope-agreement.test.ts`
		// and by "ignores legacy global Codex blocks when a scoped quota window has
		// fresh siblings" in `auth-storage-codex-selection.test.ts`. Do not
		// "simplify" this to an unconditional read; that was tried and it broke the
		// legacy case.
		if (!blockScope || provider !== "openai-codex") {
			const persistedGlobalBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, "");
			if (
				persistedGlobalBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedGlobalBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedGlobalBlockedUntil;
			}
		}
		if (blockScope) {
			const persistedScopedBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope);
			if (
				persistedScopedBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedScopedBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedScopedBlockedUntil;
			}
		}
		return blockedUntil;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	isCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): boolean {
		return this.getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
	markCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
	): void {
		const backoffKey = toScopedBackoffKey(providerKey, blockScope);
		const nowMs = Date.now();
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, InMemoryCredentialBlock>();
		const existing = backoffMap.get(credentialIndex);
		// A block already invalidated by a backward jump must not raise the new
		// deadline through MAX, or the jump would survive being re-blocked.
		const carryForward =
			existing && !isRecordFromFutureClock(existing.blockedAtMs, nowMs) ? existing.blockedUntilMs : 0;
		const nextBlockedUntil = Math.max(carryForward, blockedUntilMs);
		backoffMap.set(credentialIndex, { blockedUntilMs: nextBlockedUntil, blockedAtMs: nowMs });
		this.#credentialBackoff.set(backoffKey, backoffMap);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey) ?? new Map<number, number>();
		probeAfterMap.set(credentialIndex, Math.min(nextBlockedUntil, nowMs + USAGE_REPORT_TTL_MS));
		this.#credentialBackoffProbeAfter.set(backoffKey, probeAfterMap);
		this.#onBlocked(provider);

		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		const credentialId = this.#rows(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return;
		try {
			upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: blockScope ?? "",
				blockedUntilMs: nextBlockedUntil,
			});
		} catch (err) {
			logger.debug("Failed to persist credential block", {
				err,
				credentialId,
				provider,
				providerKey,
				blockScope,
				blockedUntilMs: nextBlockedUntil,
			});
		}
	}

	/**
	 * The latest in-memory time before which live usage reconciliation may not clear the block
	 * under `providerKey` or its `blockScope` derivative, or 0 when neither holds one.
	 */
	reconcileAfterMs(providerKey: string, blockScope: string | undefined, credentialIndex: number): number {
		const scopedBackoffKey = toScopedBackoffKey(providerKey, blockScope);
		const globalProbeAfterMs = this.#credentialBackoffProbeAfter.get(providerKey)?.get(credentialIndex) ?? 0;
		const scopedProbeAfterMs = this.#credentialBackoffProbeAfter.get(scopedBackoffKey)?.get(credentialIndex) ?? 0;
		return Math.max(globalProbeAfterMs, scopedProbeAfterMs);
	}

	/**
	 * Deletes the in-memory blocks, and the reconcile times, of one credential under
	 * `providerKey` and its scoped `\0` derivatives.
	 */
	clearCredentialBlocks(providerKey: string, credentialIndex: number): void {
		const scopedPrefix = `${providerKey}\0`;
		for (const [key, backoffMap] of this.#credentialBackoff) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) this.#credentialBackoff.delete(key);
		}
		for (const [key, probeAfterMap] of this.#credentialBackoffProbeAfter) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			probeAfterMap.delete(credentialIndex);
			if (probeAfterMap.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		}
	}

	/**
	 * Deletes the in-memory blocks under every key of `provider`. Reconcile times and persisted
	 * blocks are kept.
	 */
	clearProviderBlocks(provider: string): void {
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}
}
