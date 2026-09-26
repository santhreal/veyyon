/**
 * The work a turn leaves behind after `prompt()` returned control: the `agent_end` handler, deferred
 * compaction, scheduled continuations and idle flushes, from the moment each is scheduled to the
 * moment it settles.
 *
 * This is a session collaborator. It holds every task in flight, the promise that resolves when they
 * drain and the abort signal handed to scheduled work, and reaches the session only through
 * {@link PostPromptTasksHost}.
 *
 * A prompt resolves only after {@link PostPromptTasks.drained} does. An abort, dispose or branch
 * switch calls {@link PostPromptTasks.cancel}: scheduled work that has not started is skipped, and
 * the call waits for the work that already started.
 */
import { scheduler } from "node:timers/promises";
import type { PostPromptSkipReason } from "../agent-session-types";

/** What {@link PostPromptTasks} needs from the session that owns it. */
export interface PostPromptTasksHost {
	/** The session's prompt generation; a task scheduled for an earlier one is stale. */
	promptGeneration(): number;
}

export interface PostPromptTaskOptions {
	/** Wait this long before starting; a cancel during the wait skips the task. */
	delayMs?: number;
	/** Skip the task when the session moved past this prompt generation before it started. */
	generation?: number;
	/** Called instead of the task when it is skipped. A cancel during `delayMs` reports nothing. */
	onSkip?: (reason: PostPromptSkipReason) => void;
}

export class PostPromptTasks {
	readonly #host: PostPromptTasksHost;
	readonly #tasks = new Set<Promise<unknown>>();
	#drained: PromiseWithResolvers<void> | undefined;
	#abort = new AbortController();

	constructor(host: PostPromptTasksHost) {
		this.#host = host;
	}

	/** Whether a task is still in flight. */
	get pending(): boolean {
		return this.#tasks.size > 0;
	}

	/** Resolves once every tracked task settled; `undefined` when none was tracked since the last drain. */
	get drained(): Promise<void> | undefined {
		return this.#drained?.promise;
	}

	/** Track `task` until it settles. Its failure is reported where it was created, not here. */
	track(task: Promise<unknown>): void {
		this.#tasks.add(task);
		this.#drained ??= Promise.withResolvers<void>();
		void task
			.catch(() => {})
			.finally(() => {
				this.#tasks.delete(task);
				if (this.#tasks.size === 0) this.#resolveDrained();
			});
	}

	/** Run `task` after the current turn unless a cancel or a newer prompt reaches it first. */
	schedule(task: (signal: AbortSignal) => Promise<void>, options?: PostPromptTaskOptions): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#abort.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.("aborted");
				return;
			}
			if (options?.generation !== undefined && this.#host.promptGeneration() !== options.generation) {
				options.onSkip?.("stale-generation");
				return;
			}
			await task(signal);
		})();
		this.track(scheduled);
	}

	/** Abort every scheduled task and wait for the ones that already started. */
	async cancel(): Promise<void> {
		this.#abort.abort();
		this.#abort = new AbortController();
		const started = Array.from(this.#tasks);
		if (started.length > 0) {
			await Promise.allSettled(started);
			if (this.#tasks.size > 0) return;
		}
		this.#resolveDrained();
	}

	#resolveDrained(): void {
		this.#drained?.resolve();
		this.#drained = undefined;
	}
}
