function abortErrorFromSignal(signal: AbortSignal): unknown {
	return signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

export type AgentPauseListener = (paused: boolean) => void;

export class AgentPauseGate {
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();

	get paused(): boolean {
		return this.#gate !== undefined;
	}

	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		return true;
	}

	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		return Date.now() - this.#pausedAt;
	}

	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
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
				logger.warn("Agent pause listener threw; it missed this transition", {
					paused,
					error: errorMessage(error),
				});
			}
		}
	}
}

export const agentPauseGate = new AgentPauseGate();
