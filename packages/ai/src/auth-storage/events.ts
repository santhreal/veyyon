/**
 * The notices an `AuthStorage` emits and the generation counter it advances: subscriber sets, the
 * disabled-event backlog held while no subscriber is attached, and per-subscriber fault isolation.
 */

import * as logger from "@veyyon/utils/logger";
import type { CredentialDisabledEvent, CredentialFailoverEvent, UsageLimitWithheldEvent } from "./types";

/**
 * Cap on the buffered credential_disabled backlog held while no handler is attached.
 * In practice the backlog is 0–N where N ≈ active providers (≤ ~20). The cap exists so
 * pathological detach-without-reattach loops can't grow memory unboundedly.
 */
const MAX_PENDING_DISABLED_EVENTS = 32;

export class AuthStorageEvents {
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();
	/**
	 * Buffer for credential_disabled events fired while no listener is subscribed.
	 * Drained (in insertion order) to the first listener that triggers the empty→non-empty
	 * transition via {@link AuthStorage.onCredentialDisabled}. Bounded at
	 * {@link MAX_PENDING_DISABLED_EVENTS}; oldest entries are dropped to keep memory predictable
	 * if a long-lived AuthStorage somehow accumulates a backlog (provider count is naturally small,
	 * but a process that runs without subscribers for a long time shouldn't grow this unboundedly).
	 */
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	/**
	 * Auth-death failover subscribers.
	 *
	 * Not buffered the way disable events are: a failover notice is about what is happening to
	 * the request in flight, so replaying one to a listener that subscribes minutes later would
	 * announce a move the operator has long since lived through.
	 */
	#credentialFailoverListeners: Set<(event: CredentialFailoverEvent) => void | Promise<void>> = new Set();
	/**
	 * Withheld-quota subscribers, unbuffered for the same reason failover notices are: the news is
	 * about the turn that is waiting right now.
	 */
	#usageLimitWithheldListeners: Set<(event: UsageLimitWithheldEvent) => void | Promise<void>> = new Set();
	#generation = 1;
	#generationListeners: Set<(generation: number) => void> = new Set();

	get generation(): number {
		return this.#generation;
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationListeners.delete(listener);
	}

	bumpGeneration(reason: string): void {
		this.#generation += 1;
		for (const listener of [...this.#generationListeners]) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
	}

	/** See {@link AuthStorage.onCredentialDisabled}. */
	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		const wasEmpty = this.#credentialDisabledListeners.size === 0;
		this.#credentialDisabledListeners.add(listener);
		if (wasEmpty && this.#pendingDisabledEvents.length > 0) {
			const drained = this.#pendingDisabledEvents;
			this.#pendingDisabledEvents = [];
			for (const event of drained) {
				invokeListener("onCredentialDisabled", listener, event);
			}
		}
		return () => {
			this.#credentialDisabledListeners.delete(listener);
		};
	}

	emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			// No subscribers — buffer for later replay. Cap the backlog so a process that runs
			// without subscribers for a long time can't grow memory unboundedly; drop oldest
			// under pressure.
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}
		// Snapshot before iteration so a listener that subscribes/unsubscribes during fan-out
		// can't observe a partially-mutated set or receive an event it just registered for.
		const listeners = [...this.#credentialDisabledListeners];
		for (const listener of listeners) {
			invokeListener("onCredentialDisabled", listener, event);
		}
	}

	/** See {@link AuthStorage.onCredentialFailover}. */
	onCredentialFailover(listener: (event: CredentialFailoverEvent) => void | Promise<void>): () => void {
		this.#credentialFailoverListeners.add(listener);
		return () => {
			this.#credentialFailoverListeners.delete(listener);
		};
	}

	emitCredentialFailover(event: CredentialFailoverEvent): void {
		for (const listener of [...this.#credentialFailoverListeners]) {
			invokeListener("onCredentialFailover", listener, event);
		}
	}

	/** See {@link AuthStorage.onUsageLimitWithheld}. */
	onUsageLimitWithheld(listener: (event: UsageLimitWithheldEvent) => void | Promise<void>): () => void {
		this.#usageLimitWithheldListeners.add(listener);
		return () => {
			this.#usageLimitWithheldListeners.delete(listener);
		};
	}

	emitUsageLimitWithheld(event: UsageLimitWithheldEvent): void {
		for (const listener of [...this.#usageLimitWithheldListeners]) {
			invokeListener("onUsageLimitWithheld", listener, event);
		}
	}
}

/**
 * Deliver `event` to one subscriber of `hook`, isolating its fault: a throw or a rejection is
 * logged against the hook and never reaches the caller that is emitting.
 */
function invokeListener<E extends { provider: string }>(
	hook: "onCredentialDisabled" | "onCredentialFailover" | "onUsageLimitWithheld",
	listener: (event: E) => void | Promise<void>,
	event: E,
): void {
	const logListenerError = (error: unknown): void => {
		logger.warn(`${hook} listener threw`, { provider: event.provider, error: String(error) });
	};
	try {
		const result = listener(event);
		if (result && typeof (result as PromiseLike<void>).then === "function") {
			(result as Promise<void>).catch(logListenerError);
		}
	} catch (error) {
		logListenerError(error);
	}
}
