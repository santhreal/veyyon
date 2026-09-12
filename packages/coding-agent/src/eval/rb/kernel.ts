/**
 * Subprocess-backed Ruby runner.
 *
 * Speaks NDJSON with `runner.rb` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is delivered as SIGINT (clean interrupt, kernel state preserved) and escalates
 * to a full shutdown only when the runner ignores it. Mirrors the Python kernel
 * (eval/py/kernel.ts); the IPC loop, lifecycle, and display rendering are shared
 * with it via BaseKernel.
 */
import { $flag } from "@veyyon/utils";
import { $ } from "bun";
import {
	BaseKernel,
	createLanguageAvailabilityChecker,
	createRunnerScriptPublisher,
	DEFAULT_KERNEL_STARTUP_TIMEOUT_MS,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelEnvPatch,
	type KernelExecuteOptions,
	type KernelStartOptions,
	kernelIpcTraceEnvVar,
	launchKernelSubprocess,
} from "../kernel-base";
import { RUBY_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.rb" with { type: "text" };
import {
	enumerateRubyRuntimes,
	filterEnv,
	type RubyRuntime,
	resolveExplicitRubyRuntime,
	resolveRubyRuntime,
} from "./runtime";

export type { KernelExecuteOptions, KernelExecuteResult, KernelRuntimeEnv, KernelShutdownResult } from "../kernel-base";
export type { KernelDisplayOutput, PythonStatusEvent } from "../py/display";
export { renderKernelDisplay } from "../py/display";

const TRACE_IPC = $flag(kernelIpcTraceEnvVar("RUBY"));

const ensureRunnerScript = createRunnerScriptPublisher("ruby", RUNNER_SCRIPT, "rb");

const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS;
// How long to wait after SIGINT for the runner to emit `done` before escalating
// to a full subprocess shutdown so the host queue unblocks instead of hanging.

export interface RubyKernelAvailability {
	ok: boolean;
	rubyPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: RubyRuntime;
}

export const checkRubyKernelAvailability = createLanguageAvailabilityChecker<RubyRuntime, "rubyPath">(
	{
		skipFlag: "VEYYON_RUBY_SKIP_CHECK",
		filterEnv,
		enumerateRuntimes: (cwd, baseEnv, interpreter) => enumerateRubyRuntimes(cwd, baseEnv, interpreter),
		missingReason: "Ruby executable not found on PATH",
		probeRuntime: (runtime, cwd) => $`${runtime.rubyPath} -e ${"exit 0"}`.quiet().nothrow().cwd(cwd).env(runtime.env),
		getExecutablePath: runtime => runtime.rubyPath,
		includeFailedExecutablePath: true,
		formatFailureReason: failures => `No working Ruby interpreter found. Tried: ${failures.join("; ")}`,
	},
	"rubyPath",
);

export class RubyKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Ruby",
			traceIpc: TRACE_IPC,
			interruptEscalationMs: KERNEL_INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
		});
	}

	static async start(options: KernelStartOptions): Promise<RubyKernel> {
		return await launchKernelSubprocess({
			languageName: "Ruby",
			options,
			checkAvailability: checkRubyKernelAvailability,
			resolveRuntimeFallback: (cwd, interpreter, shellEnv) =>
				interpreter
					? resolveExplicitRubyRuntime(interpreter, cwd, filterEnv(shellEnv))
					: resolveRubyRuntime(cwd, filterEnv(shellEnv)),
			ensureRunnerScript,
			createKernel: id => new RubyKernel(id),
			getExecutableCommand: (runtime, scriptPath) => [runtime.rubyPath, scriptPath],
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
			initScript: buildInitScript(options.cwd, options.env),
			preludeScript: RUBY_PRELUDE,
			releaseReason: "ruby-kernel-startup-failed",
		});
	}
}

/**
 * The `cd` + env preamble prepended to a Ruby execution request.
 *
 * `null` CLEARS a variable and `undefined` leaves it alone, which is the contract
 * {@link KernelEnvPatch} documents and the Python runner already honoured. This
 * function used to take `Record<string, string | undefined>` and test only
 * `value !== undefined`, so a `null` fell through to `ENV["k"] = null` -- and `null`
 * is not a Ruby literal, so the whole preamble raised a NameError and took the user's
 * actual code down with it.
 *
 * Exported so the regression suite can assert the emitted bytes directly. The
 * alternative is a live kernel, which needs the interpreter installed and would not
 * run in CI, and this contract is precisely about what text gets generated.
 */
export function buildInitScript(cwd: string, env?: KernelEnvPatch): string {
	// JSON string literals are valid Ruby string literals. Emit one
	// `ENV["k"] = "v"` per key — a `{"k":"v"}` object literal would parse as a
	// SYMBOL-keyed hash in Ruby (`:"k" => "v"`), which `ENV[]=` rejects.
	const lines = [`__veyyon_init_cwd = ${JSON.stringify(cwd)}`, "Dir.chdir(__veyyon_init_cwd) rescue nil"];
	for (const key in env) {
		const value = env[key];
		if (value === undefined) continue;
		lines.push(
			value === null
				? `ENV.delete(${JSON.stringify(key)})`
				: `ENV[${JSON.stringify(key)}] = ${JSON.stringify(value)}`,
		);
	}
	lines.push("$LOAD_PATH.delete(__veyyon_init_cwd)", "$LOAD_PATH.unshift(__veyyon_init_cwd)");
	return lines.join("\n");
}
