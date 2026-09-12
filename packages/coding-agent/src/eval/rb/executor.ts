/**
 * Subprocess-backed Ruby execution driver.
 *
 * Manages Ruby kernel subprocesses, per-cell and session-mode execution,
 * explicit runtime resolution (`ruby.interpreter`), and owner-scoped teardown
 * via the shared KernelExecutionDriver.
 */
import {
	createKernelExecutionDriver,
	type KernelExecutionResult,
	type KernelExecutorBaseOptions,
} from "../executor-base";
import { checkRubyKernelAvailability, type KernelDisplayOutput, RubyKernel } from "./kernel";
import { resolveExplicitRubyRuntime } from "./runtime";

export type { KernelDisplayOutput };

export interface RubyExecutorOptions extends KernelExecutorBaseOptions {}

export type RubyResult = KernelExecutionResult;

const driver = createKernelExecutionDriver<RubyExecutorOptions, RubyKernel>({
	languageName: "Ruby",
	logLabel: "ruby",
	runIdPrefix: "rb",
	disposerName: "ruby-kernels",
	kernelClass: RubyKernel,
	checkKernelAvailability: checkRubyKernelAvailability,
	resolveInterpreterPath: (interpreter, cwd) => resolveExplicitRubyRuntime(interpreter, cwd, {}).rubyPath,
});
export const {
	disposeAll: disposeAllRubyKernelSessions,
	disposeByOwner: disposeRubyKernelSessionsByOwner,
	executeWithKernel: executeRubyWithKernel,
	execute: executeRuby,
} = driver;
