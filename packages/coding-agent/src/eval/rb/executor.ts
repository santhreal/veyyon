/**
 * Subprocess-backed Ruby execution driver.
 *
 * Manages Ruby kernel subprocesses, per-cell and session-mode execution,
 * explicit runtime resolution (`ruby.interpreter`), and owner-scoped teardown
 * via the shared KernelExecutionDriver.
 */
import { sessionCpuAdoption } from "../../session/cpu-limit";
import { buildManagedKernelEnv, createKernelExecutionDriver, type KernelExecutorBaseOptions } from "../executor-base";
import { checkRubyKernelAvailability, type KernelDisplayOutput, RubyKernel } from "./kernel";
import { resolveExplicitRubyRuntime } from "./runtime";

export type { KernelDisplayOutput };

export interface RubyExecutorOptions extends KernelExecutorBaseOptions {}

async function startKernel(cwd: string, options: RubyExecutorOptions): Promise<RubyKernel> {
	return await RubyKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
		adoptPid: sessionCpuAdoption(() => options.toolSession?.getSessionId?.() ?? null),
	});
}

const driver = createKernelExecutionDriver<RubyExecutorOptions, RubyKernel>({
	languageName: "Ruby",
	logLabel: "ruby",
	runIdPrefix: "rb",
	disposerName: "ruby-kernels",
	startKernel,
	checkKernelAvailability: checkRubyKernelAvailability,
	resolveInterpreterPath: (interpreter, cwd) => resolveExplicitRubyRuntime(interpreter, cwd, {}).rubyPath,
});

export const {
	disposeAll: disposeAllRubyKernelSessions,
	disposeByOwner: disposeRubyKernelSessionsByOwner,
	executeWithKernel: executeRubyWithKernel,
	execute: executeRuby,
} = driver;
