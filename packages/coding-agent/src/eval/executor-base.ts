import * as fs from "node:fs";
import * as path from "node:path";
import { isCancellation, isTimeoutError, logger } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { inlineBudgetFor } from "../tools/output-artifact";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP, isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import type { KernelEnvPatch, KernelExecutor } from "./kernel-base";
import { registerKernelToolBridge } from "./kernel-tool-bridge";
import type { KernelDisplayOutput } from "./py/display";

/**
 * Constructor for a language executor's cancellation error. Each backend
 * subclasses {@link Error} and carries a `timedOut` flag distinguishing a
 * deadline expiry from a plain abort.
 */
export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

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
}

/** Normalised execution result produced by {@link executeWithKernelBase}. */
export interface KernelExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
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
] as const;

interface ManagedKernelEnvOptions {
	sessionFile?: string;
	artifactsDir?: string;
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
