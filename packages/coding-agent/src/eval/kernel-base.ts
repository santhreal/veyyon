import * as path from "node:path";
import { errorMessage, isTimeoutError, logger, Snowflake } from "@veyyon/utils";
import type { Subprocess } from "bun";
import { type KernelDisplayOutput, renderKernelDisplay } from "./py/display";

export type KernelRuntimeEnv = Record<string, string | null>;

export type KernelEnvPatch = Record<string, string | null | undefined>;

export interface KernelExecuteOptions {
	id?: string;
	cwd?: string;
	env?: KernelEnvPatch;
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	kernelKilled?: boolean;
}

export interface KernelShutdownResult {
	confirmed: boolean;
}

interface KernelExitObservation {
	code: number | null;
}

export interface KernelShutdownOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface KernelStartOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	interpreter?: string;
	signal?: AbortSignal;
	deadlineMs?: number;
	adoptPid?: (pid: number) => void;
}

export interface BaseKernelOptions<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions> {
	languageName: string;
	traceIpc: boolean;
	exitPayload: string;
	interruptEscalationMs: number;
	shutdownGraceMs: number;
	buildPayload: (code: string, msgId: string, options?: TExecuteOptions) => string;
}

export type FrameType = "started" | "stdout" | "stderr" | "display" | "result" | "error" | "done";

export interface Frame {
	type: FrameType;
	id?: string;
	data?: string;
	bundle?: Record<string, unknown>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
	status?: "ok" | "error";
	executionCount?: number;
	cancelled?: boolean;
}

interface PendingExecution {
	resolve: (result: KernelExecuteResult) => void;
	options?: KernelExecuteOptions;
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	kernelKilled: boolean;
	settled: boolean;
	escalationTimer?: NodeJS.Timeout;
	finalize?: () => void;
}

export const DEFAULT_KERNEL_STARTUP_TIMEOUT_MS = 10_000;

export const KERNEL_SHUTDOWN_GRACE_MS = 1_000;

export const KERNEL_INTERRUPT_ESCALATION_MS = 5_000;

export function kernelIpcTraceEnvVar(language: string): string {
	return `VEYYON_${language}_IPC_TRACE`;
}

export function kernelRunnerCacheDir(tmpDir: string, language: string): string {
	return path.join(tmpDir, `veyyon-${language}-runner`);
}

export function getRemainingTimeMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

export function createAbortError(name: "AbortError" | "TimeoutError", message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

export function throwIfKernelAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw createAbortError("AbortError", typeof reason === "string" ? reason : fallbackReason);
}

export interface KernelExecutor<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions> {
	execute(code: string, options?: TExecuteOptions): Promise<KernelExecuteResult>;
}

export interface SessionKernel<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions>
	extends KernelExecutor<TExecuteOptions> {
	isAlive(): boolean;
	shutdown(options?: KernelShutdownOptions): Promise<KernelShutdownResult>;
}

export async function releaseKernel(
	kernel: Pick<SessionKernel, "shutdown">,
	context: string,
	options?: KernelShutdownOptions,
): Promise<void> {
	try {
		const result = await kernel.shutdown(options);
		if (!result.confirmed) {
			logger.warn("kernel shutdown was not confirmed", { context });
		}
	} catch (error) {
		logger.warn("kernel shutdown failed", { context, error: errorMessage(error) });
	}
}

export abstract class BaseKernel<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions>
	implements SessionKernel<TExecuteOptions>
{
	readonly id: string;
	#proc: Subprocess | null = null;
	#stdin: Bun.FileSink | null = null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null = null;
	#pending = new Map<string, PendingExecution>();
	#readBuffer = "";
	readonly #options: BaseKernelOptions<TExecuteOptions>;

	constructor(id: string, options: BaseKernelOptions<TExecuteOptions>) {
		this.id = id;
		this.#options = options;
	}

	setProcess(proc: Subprocess<"pipe", "pipe", "pipe">) {
		this.#proc = proc;
		this.#stdin = proc.stdin;
		this.#exitedPromise = proc.exited;
		void this.#exitedPromise.then(code => {
			this.#alive = false;
			this.#abortPendingExecutions(`${this.#options.languageName} kernel exited with code ${code}`, {
				kernelKilled: true,
			});
		});

		this.#startReader(proc.stdout as ReadableStream<Uint8Array>);
		this.#startStderrDrain(proc.stderr as ReadableStream<Uint8Array>);
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed;
	}

	async execute(code: string, options?: TExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error(`${this.#options.languageName} kernel is not running`);
		}

		const msgId = options?.id ?? Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<KernelExecuteResult>();
		const pending: PendingExecution = {
			resolve,
			options,
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
			settled: false,
			kernelKilled: false,
		};
		this.#pending.set(msgId, pending);

		const finalize = () => {
			if (pending.settled) return;
			pending.settled = true;
			this.#pending.delete(msgId);
			cleanup();
			resolve({
				status: pending.status,
				executionCount: pending.executionCount,
				error: pending.error,
				cancelled: pending.cancelled,
				timedOut: pending.timedOut,
				stdinRequested: pending.stdinRequested,
				kernelKilled: pending.kernelKilled,
			});
		};

		let requestWritten = false;
		const requestCancel = () => {
			if (pending.settled || pending.escalationTimer) return;
			if (!requestWritten) {
				finalize();
				return;
			}
			void this.interrupt();
			const escalation = setTimeout(() => {
				if (pending.settled) return;
				logger.warn(`${this.#options.languageName} runner did not respond to SIGINT; terminating subprocess`, {
					kernelId: this.id,
				});
				pending.kernelKilled = true;
				void this.shutdown();
			}, this.#options.interruptEscalationMs);
			escalation.unref?.();
			pending.escalationTimer = escalation;
		};

		const onAbort = () => {
			pending.cancelled = true;
			pending.timedOut = pending.timedOut || isTimeoutError(options?.signal?.reason);
			requestCancel();
		};
		const timeoutId =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0
				? setTimeout(() => {
						pending.timedOut = true;
						pending.cancelled = true;
						requestCancel();
					}, options.timeoutMs)
				: undefined;

		const cleanup = () => {
			clearTimeout(timeoutId);
			clearTimeout(pending.escalationTimer);
			pending.escalationTimer = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
				if (options.signal.aborted) {
					options.signal.removeEventListener("abort", onAbort);
					onAbort();
				}
			}
		}

		pending.finalize = finalize;

		const payload = this.#options.buildPayload(code, msgId, options);

		if (pending.settled) {
			return promise;
		}

		requestWritten = true;
		try {
			await this.#writeLine(payload);
		} catch (err) {
			pending.cancelled = true;
			pending.error = {
				name: "TransportError",
				value: errorMessage(err),
				traceback: [],
			};
			finalize();
		}

		return promise;
	}

	async interrupt(): Promise<void> {
		if (!this.#proc || this.#disposed) return;
		try {
			this.#proc.kill("SIGINT");
		} catch (err) {
			logger.warn(`Failed to interrupt ${this.#options.languageName.toLowerCase()} runner`, {
				error: errorMessage(err),
			});
		}
	}

	async shutdown(options?: KernelShutdownOptions): Promise<KernelShutdownResult> {
		if (this.#shutdownConfirmed) return { confirmed: true };

		this.#alive = false;
		this.#abortPendingExecutions(`${this.#options.languageName} kernel shutdown`, { kernelKilled: true });

		const timeoutMs = options?.timeoutMs ?? this.#options.shutdownGraceMs;
		const proc = this.#proc;
		if (!proc) {
			this.#shutdownConfirmed = true;
			this.#disposed = true;
			return { confirmed: true };
		}

		try {
			await this.#writeLine(this.#options.exitPayload).catch(() => {});
		} catch {}

		try {
			this.#stdin?.end();
		} catch {}

		const exited = this.#waitForExitWithTimeout(timeoutMs);
		let result = await exited;
		if (!result) {
			try {
				proc.kill("SIGTERM");
			} catch {}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}
		if (!result) {
			try {
				proc.kill("SIGKILL");
			} catch {}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}

		const confirmed = !!result;
		this.#shutdownConfirmed = confirmed;
		this.#disposed = true;
		return { confirmed };
	}

	#abortPendingExecutions(reason: string, options?: { kernelKilled?: boolean }): void {
		if (this.#pending.size === 0) return;
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		const kernelKilledDefault = options?.kernelKilled ?? false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			void entry.options?.onChunk?.(`[kernel] ${reason}\n`);
			entry.resolve({
				status: "error",
				cancelled: true,
				timedOut: entry.timedOut,
				stdinRequested: entry.stdinRequested,
				executionCount: entry.executionCount,
				error: entry.error,
				kernelKilled: entry.kernelKilled || kernelKilledDefault,
			});
		}
	}

	async #writeLine(line: string): Promise<void> {
		if (!this.#stdin) {
			throw new Error(`${this.#options.languageName} kernel stdin is not open`);
		}
		if (this.#options.traceIpc) {
			logger.debug(`${this.#options.languageName}Kernel send`, { preview: line.slice(0, 120) });
		}
		this.#stdin.write(`${line}\n`);
		this.#stdin.flush();
	}

	#startReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					this.#readBuffer += decoder.decode(value, { stream: true });
					await this.#flushFrames();
				}
				this.#readBuffer += decoder.decode();
				await this.#flushFrames();
			} catch (err) {
				logger.warn(`${this.#options.languageName} kernel reader failed`, {
					error: errorMessage(err),
				});
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		};
		void loop();
	}

	#startStderrDrain(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value);
					if (text.trim()) {
						logger.warn(`${this.#options.languageName} runner stderr`, { text });
					}
				}
			} catch {
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		};
		void loop();
	}

	async #flushFrames(): Promise<void> {
		while (true) {
			const nl = this.#readBuffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.#readBuffer.slice(0, nl);
			this.#readBuffer = this.#readBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch (err) {
				logger.warn(`${this.#options.languageName} runner emitted invalid JSON`, {
					line: line.slice(0, 200),
					error: errorMessage(err),
				});
				continue;
			}
			if (this.#options.traceIpc) {
				logger.debug(`${this.#options.languageName}Kernel recv`, { type: frame.type, id: frame.id });
			}
			await this.#handleFrame(frame);
		}
	}

	async #handleFrame(frame: Frame): Promise<void> {
		const rid = frame.id;
		if (!rid) return;
		const pending = this.#pending.get(rid);
		if (!pending) return;

		switch (frame.type) {
			case "started":
				return;
			case "stdout":
			case "stderr": {
				const text = frame.data ?? "";
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				return;
			}
			case "display":
			case "result": {
				const bundle = frame.bundle ?? {};
				const { text, outputs } = await renderKernelDisplay(bundle);
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				if (outputs.length > 0 && pending.options?.onDisplay) {
					for (const output of outputs) {
						await pending.options.onDisplay(output);
					}
				}
				return;
			}
			case "error": {
				const traceback = Array.isArray(frame.traceback) ? frame.traceback.map(String) : [];
				pending.status = "error";
				pending.error = {
					name: String(frame.ename ?? "Error"),
					value: String(frame.evalue ?? ""),
					traceback,
				};
				const message =
					traceback.length > 0 ? `${traceback.join("\n")}\n` : `${pending.error.name}: ${pending.error.value}\n`;
				if (pending.options?.onChunk) {
					await pending.options.onChunk(message);
				}
				return;
			}
			case "done": {
				if (typeof frame.executionCount === "number") {
					pending.executionCount = frame.executionCount;
				}
				if (frame.status === "error" && pending.status === "ok") {
					pending.status = "error";
				}
				if (frame.cancelled) {
					pending.cancelled = true;
				}
				pending.finalize?.();
				return;
			}
		}
	}

	async executeWithBudget(
		code: string,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		label: string,
	): Promise<void> {
		const controller = new AbortController();
		const cleanups: Array<() => void> = [];
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				const onAbort = () => controller.abort(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onAbort));
			}
		}
		const timer =
			timeoutMs > 0
				? setTimeout(() => controller.abort(createAbortError("TimeoutError", `${label} timed out`)), timeoutMs)
				: undefined;
		if (timer) cleanups.push(() => clearTimeout(timer));
		try {
			throwIfKernelAborted(controller.signal, label);
			const result = await this.execute(code, {
				signal: controller.signal,
				silent: true,
				storeHistory: false,
			} as TExecuteOptions);
			if (result.cancelled) {
				throw createAbortError(result.timedOut ? "TimeoutError" : "AbortError", `${label} cancelled`);
			}
			if (result.status === "error") {
				const reason = result.error?.value ?? `${this.#options.languageName} kernel init failed`;
				throw new Error(`${label} failed: ${reason}`);
			}
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	}

	#waitForExitWithTimeout(timeoutMs: number): Promise<KernelExitObservation | null> {
		if (!this.#exitedPromise) return Promise.resolve({ code: 0 });
		const exitedPromise = this.#exitedPromise;
		const timeout = new Promise<null>(resolve => {
			const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
			timer.unref?.();
		});
		return Promise.race([exitedPromise.then(code => ({ code: (code as number | null) ?? null })), timeout]);
	}
}
