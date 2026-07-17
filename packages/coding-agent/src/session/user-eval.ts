/**
 * User-initiated bash/python execution controller: runs `!`/`$` commands
 * against the shared executors, records results into agent context and
 * session history (deferred while a turn streams to preserve tool ordering),
 * tracks in-flight executions and abort controllers, and settles/aborts
 * everything on dispose before retained kernels are cleaned up.
 */
import type { Agent } from "@veyyon/pi-agent-core";
import { logger } from "@veyyon/pi-utils";
import type { Settings } from "../config/settings";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py";
import { executePython as executePythonCommand, type PythonResult } from "../eval/py/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage, PythonExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Session facilities the controller drives; closures over AgentSession privates. */
export interface UserEvalExecutionDeps {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	getSessionId(): string;
	isStreaming(): boolean;
	getExtensionRunner(): ExtensionRunner | undefined;
	/** Eval tool's configured session id, when one is active (kernel sharing). */
	getEvalSessionId(): string | null;
}

export class UserEvalExecution {
	readonly #deps: UserEvalExecutionDeps;
	/** Owner id for retained kernel sessions (python/ruby/julia) cleaned up on dispose. */
	readonly kernelOwnerId: string;
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];
	#evalAbortControllers = new Set<AbortController>();
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#disposing = false;

	constructor(kernelOwnerId: string, deps: UserEvalExecutionDeps) {
		this.kernelOwnerId = kernelOwnerId;
		this.#deps = deps;
	}

	/** Refuse new eval executions from this point on; part of session disposal. */
	beginDispose(): void {
		this.#disposing = true;
	}

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.#deps.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#deps.sessionManager.getCwd();

		const extensionRunner = this.#deps.getExtensionRunner();
		if (extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#bashAbortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.#deps.getSessionId(),
				cwd,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveBashOriginalArtifact(originalText),
				useUserShell: options?.useUserShell,
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.#bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.#deps.isStreaming()) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			this.#appendToContext(bashMessage);
		}
	}

	/** Cancel running bash command. */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	#appendToContext(message: BashExecutionMessage | PythonExecutionMessage): void {
		this.#deps.agent.appendMessage(message);
		this.#deps.sessionManager.appendMessage(message);
	}

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#deps.sessionManager.getCwd();
		this.assertExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			const extensionRunner = this.#deps.getExtensionRunner();
			if (extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing.
			const sessionId =
				this.#deps.getEvalSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.#deps.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.kernelOwnerId,
				kernelMode: this.#deps.settings.get("python.kernelMode"),
				interpreter: this.#deps.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackExecution(execution, abortController);
	}

	assertExecutionAllowed(): void {
		if (this.#disposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Track Python work started outside executePython so dispose can await and abort it too.
	 */
	trackExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.#deps.isStreaming()) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.#appendToContext(pythonMessage);
		}
	}

	/** Cancel running Python execution. */
	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	/** Settle (or abort, then settle) active executions before retained kernel cleanup on dispose. */
	async prepareForDispose(): Promise<boolean> {
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending bash/python messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPendingMessages(): void {
		for (const bashMessage of this.#pendingBashMessages) {
			this.#appendToContext(bashMessage);
		}
		this.#pendingBashMessages = [];
		for (const pythonMessage of this.#pendingPythonMessages) {
			this.#appendToContext(pythonMessage);
		}
		this.#pendingPythonMessages = [];
	}
}
