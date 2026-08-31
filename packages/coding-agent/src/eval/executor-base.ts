import * as fs from "node:fs";
import * as path from "node:path";
import { registerOwnedResourceDisposer } from "@veyyon/kernel/session/owned-resources";
import { errorMessage, getProjectDir, isCancellation, isTimeoutError, logger } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { gateSessionCpuSpawn } from "../session/cpu-limit";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { inlineBudgetFor } from "../tools/core/output-artifact";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/core/output-meta";
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

/**
 * Constructor for a language executor's cancellation error. Each backend
 * subclasses {@link Error} and carries a `timedOut` flag distinguishing a
 * deadline expiry from a plain abort.
 */
export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

export class KernelExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = timedOut ? "TimeoutError" : "AbortError";
		this.timedOut = timedOut;
	}
}

// Managed-env patch values (`null` clears, `undefined` skips) are owned by kernel-base,
// beside the execute options that carry them. Re-exported here because the language
// executors import it alongside the rest of this module's surface.
export type { KernelEnvPatch } from "./kernel-base";

/**
 * Options every kernel-backed language executor shares. Per-language option
 * interfaces structurally extend this; the base executor only reads these.
 */
/**
 * Whether a language's kernel outlives one eval call.
 *
 * `session` keeps one kernel per session, so a later cell sees variables an earlier one defined, which
 * is what makes eval feel like a notebook. `per-call` starts a kernel, runs the cell and shuts it down,
 * so nothing carries over: the choice a user makes when they want a run to be reproducible rather than
 * cumulative, or when leftover state from an earlier cell is what is confusing them.
 *
 * One type for every language, because it is one user-facing concept. Python owned a
 * `PythonKernelMode` alias of exactly this shape while Ruby and Julia had no concept at all, so the
 * setting existed for one language out of three.
 */
export type KernelMode = "session" | "per-call";

export interface KernelExecutorBaseOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	onStatus?: (event: JsStatusEvent) => void;
	emitStatus?: (event: JsStatusEvent) => void;
	toolSession?: ToolSession;
	bridgeSessionId?: string;
	artifactId?: string;
	artifactPath?: string;
	sessionId?: string;
	kernelOwnerId?: string;
	kernelMode?: KernelMode;
	interpreter?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	bridge?: KernelToolBridgeInfo;
}

/** Normalised execution result produced by {@link executeWithKernelBase}. */
export interface KernelExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Cancellation helpers
// ---------------------------------------------------------------------------

/**
 * The cwd a retained kernel session is keyed by.
 *
 * One owner for all three managed runtimes. Two callers that disagree about
 * whether `./foo` and `/abs/foo` are the same directory would keep two kernels
 * for one project, which is a doubled interpreter and a cell that cannot see
 * the variable the previous cell defined.
 */
export function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

/**
 * The key a retained kernel session is stored under: session id, cwd, and the
 * explicit interpreter, if the caller named one.
 *
 * Python, Ruby and Julia each had their own copy of this, and the copies had
 * drifted in two ways that both cost a kernel:
 *
 *  - Python and Ruby canonicalised the interpreter with `realpath`, so
 *    `/usr/bin/python3` and the versioned binary it links to keyed the same
 *    session. Julia only called `path.resolve`, which does not follow a
 *    symlink, so reaching the same Julia through a link started a SECOND kernel
 *    that shared no state with the first.
 *  - Julia joined the parts with `::`, which can occur inside a session id or a
 *    path, so two different sessions could in principle produce one key. The NUL
 *    byte the other two used cannot appear in either.
 *
 * The unified version canonicalises and uses NUL, so all three behave the way
 * the two that were checked did.
 */
export function buildEvalSessionKey(options: {
	sessionId: string;
	cwd: string;
	/** The interpreter the caller asked for, or undefined to let the runtime choose. */
	interpreter: string | undefined;
	/** The language's own explicit-runtime resolution, e.g. `resolveExplicitPythonRuntime`. */
	resolveInterpreterPath: (interpreter: string, cwd: string) => string;
}): string {
	const cwd = normalizeSessionCwd(options.cwd);
	let interpreter = "";
	if (options.interpreter !== undefined) {
		const resolved = options.resolveInterpreterPath(options.interpreter, cwd);
		// A path that cannot be canonicalised is keyed as written. This is not a
		// fallback to a different mechanism: the string is only ever a map key, and
		// an interpreter that does not exist yet gets its own key either way. The
		// failure surfaces where it matters, when the kernel is started.
		try {
			interpreter = fs.realpathSync.native(resolved);
		} catch {
			interpreter = resolved;
		}
	}
	return `${options.sessionId}\0${cwd}\0${interpreter}`;
}

export function getExecutionDeadlineMs(options?: { deadlineMs?: number; timeoutMs?: number }): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined) return undefined;
	return Date.now() + options.timeoutMs;
}

export function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return deadlineMs - Date.now();
}
export function requireRemainingTimeoutMs(
	deadlineMs?: number,
	cancelledErrorClass?: CancelledErrorClass,
): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		if (cancelledErrorClass) {
			throw new cancelledErrorClass(true);
		}
		const error = new Error("Command timed out");
		error.name = "TimeoutError";
		throw error;
	}
	return remainingMs;
}

/**
 * True when an error means the execution was cancelled or timed out, either through
 * the kernel's own error class or through a standard abort/timeout.
 *
 * The standard half is {@link isCancellation} from `@veyyon/utils`, the repo-wide
 * owner: this function adds only the kernel-specific class the caller passes in.
 */
export function isCancellationError(error: unknown, cancelledErrorClass: CancelledErrorClass): boolean {
	return error instanceof cancelledErrorClass || isCancellation(error);
}

export function isTimedOutCancellation(
	error: unknown,
	cancelledErrorClass: CancelledErrorClass,
	signal?: AbortSignal,
): boolean {
	if (error instanceof cancelledErrorClass) return error.timedOut;
	// The error itself, or the reason the signal carries: `AbortSignal.timeout()` fires an
	// abort whose reason is the TimeoutError, so the deadline is only visible there.
	return isTimeoutError(error) || isTimeoutError(signal?.reason);
}

export async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: { signal?: AbortSignal; deadlineMs?: number },
	cancelledErrorClass: CancelledErrorClass,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new cancelledErrorClass(isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal));
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined && remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	if (!options.signal && remainingMs === undefined) {
		return await promise;
	}

	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (cb: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		cb();
	};
	if (options.signal) {
		const onAbort = (): void =>
			finish(() =>
				reject(
					new cancelledErrorClass(
						isTimedOutCancellation(options.signal?.reason, cancelledErrorClass, options.signal),
					),
				),
			);
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}
	if (remainingMs !== undefined) {
		const timer = setTimeout(() => finish(() => reject(new cancelledErrorClass(true))), remainingMs);
		timer.unref();
		cleanups.push(() => clearTimeout(timer));
	}
	promise.then(
		value => finish(() => resolve(value)),
		err => finish(() => reject(err)),
	);
	return await resultPromise;
}

interface BridgeAbortShield {
	signal: AbortSignal | undefined;
	abortRequested: boolean;
	timedOut: boolean;
	handleStatus?: (event: JsStatusEvent) => void;
	dispose?: () => void;
}

function createBridgeAbortShield(source: AbortSignal | undefined): BridgeAbortShield {
	const shield: BridgeAbortShield = {
		signal: undefined,
		abortRequested: false,
		timedOut: false,
	};
	if (!source) return shield;

	const controller = new AbortController();
	let pauseDepth = 0;
	let abortReason: unknown;
	let removeAbortListener: (() => void) | undefined;

	const requestAbort = (reason: unknown): void => {
		shield.abortRequested = true;
		shield.timedOut = shield.timedOut || isTimeoutError(reason);
		abortReason = reason;
		if (pauseDepth > 0 || controller.signal.aborted) return;
		controller.abort(reason);
	};

	const onAbort = (): void => {
		const reason = source.reason;
		requestAbort(reason);
	};

	shield.signal = controller.signal;
	shield.handleStatus = (event: JsStatusEvent): void => {
		if (event.deferExternalAbort !== true) return;
		if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
			pauseDepth++;
			return;
		}
		if (event.op !== EVAL_TIMEOUT_RESUME_OP || pauseDepth === 0) return;
		pauseDepth--;
		if (shield.abortRequested && !controller.signal.aborted) controller.abort(abortReason);
	};
	shield.dispose = (): void => {
		removeAbortListener?.();
		removeAbortListener = undefined;
	};

	if (source.aborted) {
		requestAbort(source.reason);
	} else {
		source.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => {
			source.removeEventListener("abort", onAbort);
		};
		if (source.aborted) {
			source.removeEventListener("abort", onAbort);
			removeAbortListener = undefined;
			requestAbort(source.reason);
		}
	}

	return shield;
}

export function createCancelledKernelResult(output: string): KernelExecutionResult {
	const outputBytes = Buffer.byteLength(output, "utf-8");
	const outputLines = output.length > 0 ? 1 : 0;
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		artifactId: undefined,
		totalLines: outputLines,
		totalBytes: outputBytes,
		outputLines,
		outputBytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

// ---------------------------------------------------------------------------
// Timeout annotations (shared by every kernel executor: python, ruby, ...)
// ---------------------------------------------------------------------------

/** Whole seconds for a timeout label, floored at 1 so a sub-second budget never reads "0 seconds". */
export function timeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.round(timeoutMs / 1000));
}

/**
 * One-line "command timed out" annotation for a cancelled kernel cell. Always a
 * string: with no known budget it states the bare timeout, otherwise it names
 * the whole-second budget.
 */
export function formatTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	return `Command timed out after ${timeoutSeconds(timeoutMs)} seconds`;
}

/**
 * Richer annotation for a kernel-level timeout that distinguishes a killed
 * kernel (state gone, will be recreated) from an interrupted-but-alive kernel.
 */
export function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = timeoutMs === undefined ? "the configured timeout" : `${timeoutSeconds(timeoutMs)}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

// ---------------------------------------------------------------------------
// Managed environment helpers
// ---------------------------------------------------------------------------

export const MANAGED_KERNEL_ENV_KEYS = [
	"VEYYON_SESSION_FILE",
	"VEYYON_ARTIFACTS_DIR",
	"VEYYON_TOOL_BRIDGE_URL",
	"VEYYON_TOOL_BRIDGE_TOKEN",
	"VEYYON_TOOL_BRIDGE_SESSION",
	"VEYYON_EVAL_LOCAL_ROOTS",
	"VEYYON_EVAL_SESSION_ID",
] as const;

interface ManagedKernelEnvOptions {
	sessionFile?: string;
	artifactsDir?: string;
	/** The eval session's stable id; the `kv` store keys its file by it, bridge or no bridge. */
	evalSessionId?: string;
	bridgeSessionId?: string;
	bridge?: { url: string; token: string };
	localRoots?: Record<string, string>;
}

export function buildManagedKernelEnvPatch(options: ManagedKernelEnvOptions): Record<string, string | null> {
	const localRoots = options.localRoots;
	return {
		VEYYON_SESSION_FILE: options.sessionFile ?? null,
		VEYYON_ARTIFACTS_DIR: options.artifactsDir ?? null,
		VEYYON_TOOL_BRIDGE_URL: options.bridge?.url ?? null,
		VEYYON_TOOL_BRIDGE_TOKEN: options.bridge?.token ?? null,
		VEYYON_TOOL_BRIDGE_SESSION: options.bridge && options.bridgeSessionId ? options.bridgeSessionId : null,
		VEYYON_EVAL_LOCAL_ROOTS: localRoots && Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : null,
		VEYYON_EVAL_SESSION_ID: options.evalSessionId ?? null,
	};
}

export function buildManagedKernelEnv(options: ManagedKernelEnvOptions): Record<string, string> | undefined {
	const patch = buildManagedKernelEnvPatch(options);
	const env: Record<string, string> = {};
	let hasKeys = false;
	for (const key of MANAGED_KERNEL_ENV_KEYS) {
		const value = patch[key];
		if (value !== null) {
			env[key] = value;
			hasKeys = true;
		}
	}
	return hasKeys ? env : undefined;
}

export function attachSessionOwner(
	session: { ownerIds: Set<string>; hasFallbackOwner: boolean },
	sessionId: string,
	ownerId: string | undefined,
): void {
	if (ownerId !== undefined) {
		if (session.hasFallbackOwner) {
			session.ownerIds.delete(sessionId);
			session.hasFallbackOwner = false;
		}
		session.ownerIds.add(ownerId);
		return;
	}
	if (session.hasFallbackOwner || session.ownerIds.size === 0) {
		session.ownerIds.add(sessionId);
		session.hasFallbackOwner = true;
	}
}

// ---------------------------------------------------------------------------
// Base executor implementation
// ---------------------------------------------------------------------------

export interface ExecuteWithKernelBaseParams<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
> {
	kernel: KernelExecutor;
	code: string;
	options: TOptions | undefined;
	/** Prefix for the per-execution run id (e.g. `"py"`, `"rb"`, `"jl"`). */
	runIdPrefix: string;
	/** Human-readable language label used in the failure log line. */
	errorLogLabel: string;
	/**
	 * Julia surfaces eval-timeout control events through its normal status path,
	 * so they must NOT be filtered out the way the JS-status backends do.
	 */
	isJulia?: boolean;
	cancelledErrorClass: CancelledErrorClass;
	buildKernelEnvPatch: (options: TOptions) => TEnv;
	formatKernelTimeoutAnnotation: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation: (executionTimeoutMs: number | undefined) => string | undefined;
	/**
	 * Override how the wall-clock deadline is derived from options. Defaults to
	 * {@link getExecutionDeadlineMs}; Julia passes the pre-computed `deadlineMs`
	 * straight through instead of re-deriving from `timeoutMs`.
	 */
	resolveDeadlineMs?: (options: TOptions | undefined) => number | undefined;
}

export async function executeWithKernelBase<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
>(params: ExecuteWithKernelBaseParams<TOptions, TEnv>): Promise<KernelExecutionResult> {
	const {
		kernel,
		code,
		options,
		runIdPrefix,
		errorLogLabel,
		isJulia,
		cancelledErrorClass,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs,
	} = params;

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		// Priced by how long the result will sit in context, through the same
		// owner every other tool uses. Without this the sink keeps a flat 50KB
		// tail, which is why eval results reached 71KB and then cost a re-read on
		// every subsequent turn. A session-less caller gets the flat budget.
		...(options?.toolSession ? { spillThreshold: inlineBudgetFor(options.toolSession) } : {}),
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = (resolveDeadlineMs ?? getExecutionDeadlineMs)(options);
	let executionTimeoutMs: number | undefined;
	const abortShield = createBridgeAbortShield(options?.signal);

	const collectDisplay = (output: KernelDisplayOutput): void => {
		if (output.type === "status") {
			abortShield.handleStatus?.(output.event);
			options?.onStatus?.(output.event);
			if (!isJulia && isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};

	const emitStatus: (event: JsStatusEvent) => void =
		options?.emitStatus ?? (event => collectDisplay({ type: "status", event }));
	const runId = `${runIdPrefix}-${crypto.randomUUID()}`;
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerKernelToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: abortShield.signal,
					emitStatus,
					abortRequested: () => {
						return abortShield.abortRequested;
					},
				})
			: null;

	try {
		const remainingMs = getRemainingTimeoutMs(deadlineMs);
		if (remainingMs !== undefined) {
			if (remainingMs <= 0) {
				throw new cancelledErrorClass(true);
			}
			executionTimeoutMs = remainingMs;
		}

		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildKernelEnvPatch(options ?? ({} as TOptions)),
			id: runId,
			signal: abortShield.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled && result.kernelKilled && !result.timedOut && !abortShield.abortRequested) {
			throw new Error(`${errorLogLabel} kernel exited during execution`);
		}

		if (result.cancelled || abortShield.abortRequested) {
			const timedOut = result.timedOut || abortShield.timedOut;
			const annotation = timedOut
				? formatKernelTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs, result.kernelKilled ?? false)
				: undefined;
			const dumped = await sink.dump(annotation);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: !!result.stdinRequested,
			};
		}

		if (result.stdinRequested) {
			const dumped = await sink.dump("Kernel requested stdin; interactive input is not supported.");
			return {
				exitCode: 1,
				cancelled: false,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: true,
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const dumped = await sink.dump();
		return {
			exitCode,
			cancelled: false,
			truncated: dumped.truncated,
			output: dumped.output,
			artifactId: dumped.artifactId ?? undefined,
			totalLines: dumped.totalLines,
			totalBytes: dumped.totalBytes,
			outputLines: dumped.outputLines,
			outputBytes: dumped.outputBytes,
			displayOutputs,
			stdinRequested: false,
		};
	} catch (err) {
		if (isCancellationError(err, cancelledErrorClass) || abortShield.abortRequested || abortShield.signal?.aborted) {
			const timedOut = abortShield.timedOut || isTimedOutCancellation(err, cancelledErrorClass, abortShield.signal);
			const dumped = await sink.dump(
				timedOut ? formatTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs) : undefined,
			);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: false,
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error(`${errorLogLabel} execution failed`, { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
		abortShield.dispose?.();
	}
}

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
