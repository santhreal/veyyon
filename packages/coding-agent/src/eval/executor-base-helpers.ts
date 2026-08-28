import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, getProjectDir, isCancellation, isTimeoutError, logger } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { gateSessionCpuSpawn } from "../session/cpu-limit";
import { registerOwnedResourceDisposer } from "../session/owned-resources";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { inlineBudgetFor } from "../tools/output-artifact";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP, isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import {
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelEnvPatch,
	type KernelExecutor,
	releaseKernel,
	type SessionKernel,
} from "./kernel-base";
import { ensureKernelToolBridge, type KernelToolBridgeInfo, registerKernelToolBridge } from "./kernel-tool-bridge";
import type { KernelDisplayOutput } from "./py/display";

import type { CancelledErrorClass, KernelExecutionResult, KernelExecutorBaseOptions } from "./executor-base";
import {
	KernelExecutionCancelledError,
	attachSessionOwner,
	buildEvalSessionKey,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	formatKernelTimeoutAnnotation,
	formatTimeoutAnnotation,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	normalizeSessionCwd,
	requireRemainingTimeoutMs,
	waitForPromiseWithCancellation,
} from "./executor-base";

export interface SessionOwnerState {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

export interface ManagedKernelSession<TKernel extends SessionKernel = SessionKernel> extends SessionOwnerState {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
}

export interface StartingManagedKernelSession<TKernel extends SessionKernel = SessionKernel> extends SessionOwnerState {
	promise: Promise<ManagedKernelSession<TKernel>>;
}

export interface KernelSessionPoolOptions<
	TOptions extends KernelExecutorBaseOptions,
	TKernel extends SessionKernel = SessionKernel,
> {
	languageName: string;
	logLabel: string;
	cancelledErrorClass?: CancelledErrorClass;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	shutdownGraceMs?: number;
	warnOnDiedSubprocess?: boolean;
}

export class KernelSessionPool<
	TOptions extends KernelExecutorBaseOptions,
	TKernel extends SessionKernel = SessionKernel,
> {
	readonly #sessions = new Map<string, ManagedKernelSession<TKernel>>();
	readonly #startingSessions = new Map<string, StartingManagedKernelSession<TKernel>>();
	readonly #resettingSessions = new Map<string, Promise<void>>();
	readonly #options: KernelSessionPoolOptions<TOptions, TKernel>;
	readonly #cancelledErrorClass: CancelledErrorClass;

	constructor(options: KernelSessionPoolOptions<TOptions, TKernel>) {
		this.#options = options;
		this.#cancelledErrorClass = options.cancelledErrorClass ?? KernelExecutionCancelledError;
	}

	get sessions(): Map<string, ManagedKernelSession<TKernel>> {
		return this.#sessions;
	}

	get startingSessions(): Map<string, StartingManagedKernelSession<TKernel>> {
		return this.#startingSessions;
	}

	get resettingSessions(): Map<string, Promise<void>> {
		return this.#resettingSessions;
	}

	hasSession(sessionKey: string, session: ManagedKernelSession<TKernel>): boolean {
		return this.#sessions.get(sessionKey) === session;
	}

	async acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<ManagedKernelSession<TKernel>> {
		const existing = this.#sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}

		const inFlight = this.#startingSessions.get(sessionKey);
		if (inFlight) {
			attachSessionOwner(inFlight, sessionId, options.kernelOwnerId);
			return await waitForPromiseWithCancellation(inFlight.promise, options, this.#cancelledErrorClass);
		}

		let startingSession!: StartingManagedKernelSession<TKernel>;
		const startPromise = (async () => {
			const kernel = await this.#options.startKernel(cwd, options);
			const session: ManagedKernelSession<TKernel> = {
				sessionKey,
				sessionId,
				cwd,
				kernel,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			};
			if (this.#startingSessions.get(sessionKey) === startingSession) {
				this.#sessions.set(sessionKey, session);
			}
			return session;
		})();

		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startPromise,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		this.#startingSessions.set(sessionKey, startingSession);
		try {
			return await waitForPromiseWithCancellation(startPromise, options, this.#cancelledErrorClass);
		} finally {
			if (this.#startingSessions.get(sessionKey) === startingSession) {
				this.#startingSessions.delete(sessionKey);
			}
		}
	}

	async replaceSessionKernel(session: ManagedKernelSession<TKernel>, cwd: string, options: TOptions): Promise<void> {
		if (this.#options.warnOnDiedSubprocess) {
			logger.warn(`${this.#options.languageName} subprocess died or is unresponsive; spawning fresh process`, {
				sessionKey: session.sessionKey,
			});
		}
		const oldKernel = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		await releaseKernel(
			oldKernel,
			`${this.#options.logLabel}-session-kernel-replaced`,
			remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined,
		);
		if (this.#sessions.get(session.sessionKey) !== session) {
			throw new this.#cancelledErrorClass(false);
		}
		requireRemainingTimeoutMs(options.deadlineMs, this.#cancelledErrorClass);
		const nextKernel = await this.#options.startKernel(cwd, options);
		if (this.#sessions.get(session.sessionKey) !== session) {
			await releaseKernel(nextKernel, `${this.#options.logLabel}-session-superseded-while-starting`);
			throw new this.#cancelledErrorClass(false);
		}
		session.kernel = nextKernel;
	}

	async resetSession(sessionKey: string): Promise<void> {
		const session =
			this.#sessions.get(sessionKey) ??
			(await this.#startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!session) return;
		this.#sessions.delete(sessionKey);
		const timeoutMs = this.#options.shutdownGraceMs ?? KERNEL_SHUTDOWN_GRACE_MS;
		await releaseKernel(session.kernel, `${this.#options.logLabel}-session-reset`, { timeoutMs });
	}

	async disposeAll(): Promise<void> {
		const pending = [...this.#startingSessions.values()].map(starting => starting.promise);
		this.#startingSessions.clear();
		this.#resettingSessions.clear();
		const started = await Promise.allSettled(pending);
		const all = [...this.#sessions.entries()];
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (!all.some(([, session]) => session === result.value)) {
				all.push([result.value.sessionKey, result.value]);
			}
		}
		for (const [id, session] of all) {
			if (this.#sessions.get(id) === session) this.#sessions.delete(id);
		}
		const results = await Promise.allSettled(all.map(([, session]) => session.kernel.shutdown()));
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${this.#options.languageName} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!this.#sessions.has(id)) this.#sessions.set(id, session);
		}
	}

	async disposeByOwner(ownerId: string): Promise<void> {
		const toShutdown: ManagedKernelSession<TKernel>[] = [];
		const startingToShutdown: StartingManagedKernelSession<TKernel>[] = [];
		for (const session of [...this.#sessions.values()]) {
			if (!session.ownerIds.has(ownerId)) continue;
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of [...this.#startingSessions.entries()]) {
			if (this.#sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				this.#startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			if (this.#sessions.get(session.sessionKey) === session) this.#sessions.delete(session.sessionKey);
		}
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			if (this.#sessions.get(session.sessionKey) === session) this.#sessions.delete(session.sessionKey);
			toShutdown.push(session);
		}
		const results = await Promise.allSettled(toShutdown.map(session => session.kernel.shutdown()));
		for (let i = 0; i < toShutdown.length; i += 1) {
			const session = toShutdown[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${this.#options.languageName} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!this.#sessions.has(session.sessionKey)) this.#sessions.set(session.sessionKey, session);
		}
	}
}

export interface KernelExecutionDriverOptions<
	TOptions extends KernelExecutorBaseOptions,
	TKernel extends SessionKernel = SessionKernel,
> {
	languageName: string;
	logLabel: string;
	runIdPrefix: string;
	disposerName: string;
	cancelledErrorClass?: CancelledErrorClass;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	checkKernelAvailability: (cwd: string, interpreter?: string) => Promise<{ ok: boolean; reason?: string }>;
	resolveInterpreterPath: (interpreter: string, cwd: string) => string;
	buildKernelEnvPatch?: (options: TOptions) => Record<string, string | null | undefined>;
	formatKernelTimeoutAnnotation?: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation?: (executionTimeoutMs: number | undefined) => string | undefined;
	createCancelledResult?: (timedOut: boolean, timeoutMs?: number) => KernelExecutionResult;
	resolveDeadlineMs?: (options?: TOptions) => number | undefined;
	isJulia?: boolean;
	shutdownGraceMs?: number;
	warnOnDiedSubprocess?: boolean;
}

export interface KernelExecutionDriver<
	TOptions extends KernelExecutorBaseOptions,
	TKernel extends SessionKernel = SessionKernel,
> {
	readonly pool: KernelSessionPool<TOptions, TKernel>;
	executeWithKernel(kernel: KernelExecutor, code: string, options?: TOptions): Promise<KernelExecutionResult>;
	execute(code: string, options?: TOptions): Promise<KernelExecutionResult>;
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string): Promise<void>;
}

export function createKernelExecutionDriver<
	TOptions extends KernelExecutorBaseOptions,
	TKernel extends SessionKernel = SessionKernel,
>(config: KernelExecutionDriverOptions<TOptions, TKernel>): KernelExecutionDriver<TOptions, TKernel> {
	const {
		languageName,
		logLabel,
		runIdPrefix,
		disposerName,
		cancelledErrorClass = KernelExecutionCancelledError,
		startKernel,
		checkKernelAvailability,
		resolveInterpreterPath,
		buildKernelEnvPatch = opts => buildManagedKernelEnvPatch({ ...opts, evalSessionId: opts.sessionId }),
		formatKernelTimeoutAnnotation: formatKernelTimeout = formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation: formatTimeout = formatTimeoutAnnotation,
		createCancelledResult = (timedOut, timeoutMs) =>
			createCancelledKernelResult(timedOut ? (formatTimeout(timeoutMs) ?? "") : ""),
		resolveDeadlineMs: customResolveDeadlineMs,
		isJulia,
		shutdownGraceMs,
		warnOnDiedSubprocess,
	} = config;

	const pool = new KernelSessionPool<TOptions, TKernel>({
		languageName,
		logLabel,
		cancelledErrorClass,
		startKernel,
		shutdownGraceMs,
		warnOnDiedSubprocess,
	});

	async function executeWithKernel(
		kernel: KernelExecutor,
		code: string,
		options: TOptions | undefined,
	): Promise<KernelExecutionResult> {
		return executeWithKernelBase<TOptions>({
			kernel,
			code,
			options,
			runIdPrefix,
			errorLogLabel: languageName,
			isJulia,
			cancelledErrorClass,
			buildKernelEnvPatch: buildKernelEnvPatch as (options: TOptions) => Record<string, string | null>,
			formatKernelTimeoutAnnotation: formatKernelTimeout,
			formatTimeoutAnnotation: formatTimeout,
			resolveDeadlineMs: customResolveDeadlineMs,
		});
	}

	async function ensureKernelAvailable(cwd: string, options: TOptions): Promise<void> {
		const availability = await waitForPromiseWithCancellation(
			checkKernelAvailability(cwd, options.interpreter),
			options,
			cancelledErrorClass,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? `${languageName} kernel unavailable`);
		}
	}

	async function ensureToolBridge(options: TOptions): Promise<void> {
		if (!options.toolSession || options.bridge) return;
		try {
			options.bridge = await ensureKernelToolBridge();
		} catch (err) {
			logger.warn(`Failed to start ${languageName} tool bridge`, {
				error: errorMessage(err),
			});
		}
	}

	async function executePerCall(code: string, cwd: string, options: TOptions): Promise<KernelExecutionResult> {
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = `${runIdPrefix}-bridge:${crypto.randomUUID()}`;
		}
		const kernel = await startKernel(cwd, options);
		try {
			return await executeWithKernel(kernel, code, { ...options, cwd });
		} finally {
			await releaseKernel(kernel, `${logLabel}-one-shot-finished`);
		}
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<KernelExecutionResult> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = buildEvalSessionKey({
			sessionId,
			cwd,
			interpreter: options.interpreter,
			resolveInterpreterPath,
		});
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
		if (options.reset) {
			const inFlight = pool.resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const resetPromise = pool.resetSession(sessionKey);
				pool.resettingSessions.set(
					sessionKey,
					resetPromise.then(() => undefined),
				);
				try {
					await resetPromise;
				} finally {
					pool.resettingSessions.delete(sessionKey);
				}
			}
		} else {
			const inFlight = pool.resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		const session = await pool.acquireSession(sessionKey, sessionId, cwd, options);
		if (options.signal?.aborted) {
			throw new cancelledErrorClass(
				isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal),
			);
		}
		if (!pool.hasSession(session.sessionKey, session)) {
			throw new cancelledErrorClass(false);
		}
		if (!session.kernel.isAlive()) {
			await pool.replaceSessionKernel(session, cwd, options);
			if (!pool.hasSession(session.sessionKey, session)) {
				throw new cancelledErrorClass(false);
			}
		}
		const runOptions = { ...options, cwd };
		try {
			return await executeWithKernel(session.kernel, code, runOptions);
		} catch (err) {
			if (isCancellationError(err, cancelledErrorClass) || options.signal?.aborted) throw err;
			if (session.kernel.isAlive()) throw err;
			if (!pool.hasSession(session.sessionKey, session)) {
				throw new cancelledErrorClass(false);
			}
			await pool.replaceSessionKernel(session, cwd, options);
			if (!pool.hasSession(session.sessionKey, session)) {
				throw new cancelledErrorClass(false);
			}
			return await executeWithKernel(session.kernel, code, runOptions);
		}
	}

	async function execute(code: string, options?: TOptions): Promise<KernelExecutionResult> {
		const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
		const deadlineMs = (customResolveDeadlineMs ?? getExecutionDeadlineMs)(options);
		const executionOptions = {
			...(options ?? {}),
			cwd,
			deadlineMs,
		} as TOptions;

		await gateSessionCpuSpawn(options?.toolSession?.getSessionId?.() ?? null, `a ${languageName} eval cell`);
		try {
			requireRemainingTimeoutMs(deadlineMs, cancelledErrorClass);
			if (executionOptions.signal?.aborted) {
				throw new cancelledErrorClass(
					isTimedOutCancellation(executionOptions.signal.reason, cancelledErrorClass, executionOptions.signal),
				);
			}
			await ensureKernelAvailable(cwd, executionOptions);
			await ensureToolBridge(executionOptions);

			const kernelMode = executionOptions.kernelMode ?? "session";
			if (kernelMode === "per-call") {
				return await executePerCall(code, cwd, executionOptions);
			}
			return await executeOnSession(code, cwd, executionOptions);
		} catch (err) {
			if (isCancellationError(err, cancelledErrorClass) || executionOptions.signal?.aborted) {
				return createCancelledResult(
					isTimedOutCancellation(err, cancelledErrorClass, executionOptions.signal),
					options?.timeoutMs,
				);
			}
			throw err;
		}
	}

	const disposeAll = () => pool.disposeAll();
	const disposeByOwner = (ownerId: string) => pool.disposeByOwner(ownerId);

	registerOwnedResourceDisposer({
		name: disposerName,
		scope: "eval-kernel-owner",
		dispose: disposeByOwner,
	});

	return {
		pool,
		executeWithKernel,
		execute,
		disposeAll,
		disposeByOwner,
	};
}
