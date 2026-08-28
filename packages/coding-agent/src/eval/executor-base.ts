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

export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

export type { KernelEnvPatch } from "./kernel-base";

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

export function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

export function buildEvalSessionKey(options: {
	sessionId: string;
	cwd: string;
	interpreter: string | undefined;
	resolveInterpreterPath: (interpreter: string, cwd: string) => string;
}): string {
	const cwd = normalizeSessionCwd(options.cwd);
	let interpreter = "";
	if (options.interpreter !== undefined) {
		const resolved = options.resolveInterpreterPath(options.interpreter, cwd);
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

export function isCancellationError(error: unknown, cancelledErrorClass: CancelledErrorClass): boolean {
	return error instanceof cancelledErrorClass || isCancellation(error);
}

export function isTimedOutCancellation(
	error: unknown,
	cancelledErrorClass: CancelledErrorClass,
	signal?: AbortSignal,
): boolean {
	if (error instanceof cancelledErrorClass) return error.timedOut;
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

export function timeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.round(timeoutMs / 1000));
}

export function formatTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	return `Command timed out after ${timeoutSeconds(timeoutMs)} seconds`;
}

export function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = timeoutMs === undefined ? "the configured timeout" : `${timeoutSeconds(timeoutMs)}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

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

export interface ExecuteWithKernelBaseParams<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
> {
	kernel: KernelExecutor;
	code: string;
	options: TOptions | undefined;
	runIdPrefix: string;
	errorLogLabel: string;
	isJulia?: boolean;
	cancelledErrorClass: CancelledErrorClass;
	buildKernelEnvPatch: (options: TOptions) => TEnv;
	formatKernelTimeoutAnnotation: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation: (executionTimeoutMs: number | undefined) => string | undefined;
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
