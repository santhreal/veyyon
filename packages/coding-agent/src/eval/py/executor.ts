/**
 * Subprocess-backed Python execution driver.
 *
 * Manages persistent Python kernel sessions, per-call execution, environment
 * propagation (including VEYYON_EVAL_SESSION_ID for KV store access), and lifecycle
 * disposal via the shared KernelExecutionDriver.
 */
import {
	createKernelExecutionDriver,
	type KernelExecutionResult,
	type KernelExecutorBaseOptions,
	type KernelMode,
} from "../executor-base";
import { checkPythonKernelAvailability, type KernelDisplayOutput, PythonKernel } from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";

export type { KernelDisplayOutput };

/**
 * Kept as an alias of the shared {@link KernelMode} rather than its own union: the type is exported and
 * `python.kernelMode` reads it in `py/index.ts`, so removing the name would break callers for nothing,
 * while a second literal union would let the two drift.
 */
export type PythonKernelMode = KernelMode;

export interface PythonExecutorOptions extends KernelExecutorBaseOptions {
	kernelMode?: PythonKernelMode;
}

export type PythonResult = KernelExecutionResult;

const driver = createKernelExecutionDriver<PythonExecutorOptions, PythonKernel>({
	languageName: "Python",
	logLabel: "python",
	runIdPrefix: "py",
	disposerName: "python-kernels",
	kernelClass: PythonKernel,
	checkKernelAvailability: checkPythonKernelAvailability,
	resolveInterpreterPath: (interpreter, cwd) => resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath,
});
export const {
	disposeAll: disposeAllKernelSessions,
	disposeByOwner: disposeKernelSessionsByOwner,
	executeWithKernel: executePythonWithKernel,
	execute: executePython,
} = driver;
