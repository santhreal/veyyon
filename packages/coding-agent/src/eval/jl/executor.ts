import { sessionCpuAdoption } from "../../session/cpu-limit";
import { createCancelledKernelResult, createKernelExecutionDriver, getExecutionDeadlineMs } from "../executor-base";
import { KERNEL_SHUTDOWN_GRACE_MS } from "../kernel-base";
import type { KernelToolBridgeInfo } from "../kernel-tool-bridge";
import type { JuliaExecutorOptions, JuliaResult } from "./executor-helpers";
import { checkJuliaKernelAvailability, JuliaKernel } from "./kernel";
import { resolveExplicitJuliaRuntime } from "./runtime";

export type { JuliaExecutorOptions };

class JuliaExecutionCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "Julia execution timed out" : "Julia execution cancelled");
		this.name = "JuliaExecutionCancelledError";
	}
}

/**
 * Julia's deadline rule: a timeout of zero means NO timeout.
 *
 * Named for the difference rather than sharing the shared owner's name. It used
 * to be called `getExecutionDeadlineMs`, the same name as
 * {@link getExecutionDeadlineMs} in `executor-base`, with a different answer for
 * `timeoutMs: 0` -- the shared owner returns an immediate deadline, this returns
 * none. Two behaviours behind one name is the shape a reader cannot see: a call
 * site that imported the wrong one still compiled, and jl's kernel path would
 * have rejected a still-valid session as already expired.
 *
 * The arithmetic is still the shared owner's; only the zero rule is here, so
 * there is one place that knows a deadline is `now + timeout`.
 */
export function deadlineForNonZeroTimeout(
	options?: Pick<JuliaExecutorOptions, "deadlineMs" | "timeoutMs">,
): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined || options.timeoutMs <= 0) return undefined;
	return getExecutionDeadlineMs(options);
}

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return undefined;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[cell timed out after ${rounded}s]`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const explanation = kernelKilled ? "; active subprocess terminated to recover" : "; kernel is still running";
	if (timeoutMs === undefined) return `[execution timed out${explanation}]`;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[execution timed out after ${rounded}s${explanation}]`;
}

export function createCancelledJuliaResult(timedOut: boolean, timeoutMs?: number): JuliaResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "[cell timed out]\n") : "[execution cancelled]\n";
	return createCancelledKernelResult(output);
}

function buildKernelEnvPatch(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: KernelToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string | undefined> {
	const patch: Record<string, string | undefined> = {};
	if (options.sessionFile) patch.VEYYON_SESSION_FILE = options.sessionFile;
	if (options.artifactsDir) patch.VEYYON_ARTIFACTS_DIR = options.artifactsDir;
	if (options.bridge) {
		patch.VEYYON_TOOL_BRIDGE_URL = options.bridge.url;
		patch.VEYYON_TOOL_BRIDGE_TOKEN = options.bridge.token;
		patch.VEYYON_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
	}
	if (options.localRoots) {
		patch.VEYYON_EVAL_LOCAL_ROOTS = JSON.stringify(options.localRoots);
	}
	return patch;
}

function buildKernelEnv(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: KernelToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string> | undefined {
	const patch = buildKernelEnvPatch(options);
	const keys = Object.keys(patch);
	if (keys.length === 0) return undefined;
	const realEnv: Record<string, string> = {};
	for (const key in patch) {
		const val = patch[key];
		if (typeof val === "string") realEnv[key] = val;
	}
	return realEnv;
}

async function startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
	const env: Record<string, string | undefined> = {};
	const patch = buildKernelEnv(options);
	if (patch) {
		for (const key in patch) {
			const value = patch[key];
			if (typeof value === "string") env[key] = value;
		}
	}
	return await JuliaKernel.start({
		cwd,
		interpreter: options.interpreter,
		env,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		adoptPid: sessionCpuAdoption(() => options.toolSession?.getSessionId?.() ?? null),
	});
}

const driver = createKernelExecutionDriver<JuliaExecutorOptions, JuliaKernel>({
	languageName: "Julia",
	logLabel: "julia",
	runIdPrefix: "jl",
	disposerName: "julia-kernels",
	cancelledErrorClass: JuliaExecutionCancelledError,
	startKernel,
	checkKernelAvailability: checkJuliaKernelAvailability,
	resolveInterpreterPath: (interpreter, cwd) => resolveExplicitJuliaRuntime(interpreter, cwd, {}).juliaPath,
	buildKernelEnvPatch,
	formatKernelTimeoutAnnotation,
	formatTimeoutAnnotation,
	createCancelledResult: createCancelledJuliaResult,
	resolveDeadlineMs: deadlineForNonZeroTimeout,
	isJulia: true,
	shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
	warnOnDiedSubprocess: true,
});

export const {
	disposeAll: disposeAllJuliaKernelSessions,
	disposeByOwner: disposeJuliaKernelSessionsByOwner,
	executeWithKernel: executeJuliaWithKernel,
	execute: executeJulia,
} = driver;
