function abortErrorFromSignal(signal: AbortSignal): unknown {
	return signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

/** Process-global pause gate for agent loops. */

import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

/** Freeze switch shared by every agent loop in the process. See module docs. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	/** Engage the gate. Returns false (and does nothing) when already paused. */
	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		return true;
	}

	/** Release the gate, waking every parked loop. Returns the pause duration in */
	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Park until the gate is released. Resolves immediately when not paused. */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) {
				throw abortErrorFromSignal(signal);
			}
			const gate = this.#gate.promise;
			if (!signal) {
				await gate;
				continue;
			}
			const abort = Promise.withResolvers<never>();
			const onAbort = () => abort.reject(abortErrorFromSignal(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await Promise.race([gate, abort.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
		if (signal?.aborted) {
			throw abortErrorFromSignal(signal);
		}
	}

	#notify(paused: boolean): void {
		for (const listener of this.#listeners) {
			try {
				listener(paused);
			} catch (error) {
				// The loop must continue for the other listeners, which is why this is
				// caught. It is reported because a listener that throws keeps its
				// subscription and keeps missing transitions, so a host indicator can
				// sit on "running" through a pause with nothing explaining the lie.
				logger.warn("Agent pause listener threw; it missed this transition", {
					paused,
					error: errorMessage(error),
				});
			}
		}
	}
}

/** The process-wide gate polled by the agent loop. */
export const agentPauseGate = new AgentPauseGate();
