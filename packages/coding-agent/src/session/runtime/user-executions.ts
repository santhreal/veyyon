/**
 * The shell commands and Python cells the user runs directly (`!`, `$`), and the eval runs a tool
 * starts, from their start to their record in the transcript.
 *
 * This is a session collaborator. It holds the abort controller of every running command and cell,
 * the eval runs still in flight and the results recorded while a turn streamed, and reaches the
 * session only through {@link UserExecutionsHost}.
 *
 * A result recorded while a turn streams waits for the next prompt: appending it mid-turn would put
 * a message between a tool call and its result. Shell results are appended before Python results.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@veyyon/utils";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../tools/shell/execution-messages";

/** How long dispose waits for eval runs to finish on their own, then after aborting them. */
const EVAL_SETTLE_MS = 3_000;
const EVAL_ABORT_SETTLE_MS = 1_000;

/** What {@link UserExecutions} needs from the session that owns it. */
export interface UserExecutionsHost {
	/** Whether a turn is streaming, so a recorded result waits for the next prompt. */
	isStreaming(): boolean;
	/** Add `message` to the agent's context and the session log. */
	append(message: BashExecutionMessage | PythonExecutionMessage): void;
}

export class UserExecutions {
	readonly #host: UserExecutionsHost;
	readonly #bashRuns = new Set<AbortController>();
	readonly #evalRuns = new Set<AbortController>();
	readonly #evalExecutions = new Set<Promise<unknown>>();
	#deferredBash: BashExecutionMessage[] = [];
	#deferredPython: PythonExecutionMessage[] = [];
	#evalStopped = false;

	constructor(host: UserExecutionsHost) {
		this.#host = host;
	}

	/** Run a shell command under an abort controller {@link abortBash} reaches. */
	async runBash<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		this.#bashRuns.add(controller);
		try {
			return await run(controller.signal);
		} finally {
			this.#bashRuns.delete(controller);
		}
	}

	abortBash(): void {
		for (const controller of this.#bashRuns) controller.abort();
	}

	get bashRunning(): boolean {
		return this.#bashRuns.size > 0;
	}

	get hasDeferredBash(): boolean {
		return this.#deferredBash.length > 0;
	}

	/** Record a result: appended now, or at the next prompt while a turn streams. */
	record(message: BashExecutionMessage | PythonExecutionMessage): void {
		if (!this.#host.isStreaming()) {
			this.#host.append(message);
		} else if (message.role === "bashExecution") {
			this.#deferredBash.push(message);
		} else {
			this.#deferredPython.push(message);
		}
	}

	/** Append the results recorded while the last turn streamed. */
	flush(): void {
		const deferred = [...this.#deferredBash, ...this.#deferredPython];
		if (deferred.length === 0) return;
		this.#deferredBash = [];
		this.#deferredPython = [];
		for (const message of deferred) this.#host.append(message);
	}

	/** @throws Once the session began disposing, since its kernels are about to be released. */
	assertEvalAllowed(): void {
		if (this.#evalStopped) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/** Track an eval run so {@link abortEval} reaches it and dispose waits for it. */
	trackEval<T>(execution: Promise<T>, controller: AbortController): Promise<T> {
		this.#evalRuns.add(controller);
		this.#evalExecutions.add(execution);
		const untrack = () => {
			this.#evalRuns.delete(controller);
			this.#evalExecutions.delete(execution);
		};
		void execution.then(untrack, untrack);
		return execution;
	}

	abortEval(): void {
		for (const controller of this.#evalRuns) controller.abort();
	}

	get evalRunning(): boolean {
		return this.#evalRuns.size > 0;
	}

	get hasDeferredPython(): boolean {
		return this.#deferredPython.length > 0;
	}

	/** Refuse every eval run from now on: the session began disposing. */
	stopEval(): void {
		this.#evalStopped = true;
	}

	/**
	 * Wait for the eval runs to finish, aborting them after {@link EVAL_SETTLE_MS}. `false` when one is
	 * still running {@link EVAL_ABORT_SETTLE_MS} after the abort, so its kernel is released under it.
	 */
	async settleEvalForDispose(): Promise<boolean> {
		if (await this.#settleEval(EVAL_SETTLE_MS)) return true;
		logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
		this.abortEval();
		if (await this.#settleEval(EVAL_ABORT_SETTLE_MS)) return true;
		logger.warn(
			"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
		);
		return false;
	}

	/** Whether every eval run finished within `timeoutMs`, including runs tracked while waiting. */
	async #settleEval(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#evalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			// The timer is cancelled once the runs settle, so it holds neither the event loop nor a
			// dispose that already finished.
			const timer = new AbortController();
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#evalExecutions)).then(() => true),
				sleep(remainingMs, false, { signal: timer.signal }).catch(() => false),
			]);
			timer.abort();
			if (!settled && this.#evalExecutions.size > 0) return false;
		}
		return true;
	}
}
