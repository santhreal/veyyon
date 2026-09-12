/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is `kill("SIGINT")` which raises a real `KeyboardInterrupt` inside user
 * code. Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout.
 */
import { $flag } from "@veyyon/utils";
import { $ } from "bun";
import {
	assembleSpawnEnv,
	BaseKernel,
	createLanguageAvailabilityChecker,
	createRunnerScriptPublisher,
	DEFAULT_KERNEL_STARTUP_TIMEOUT_MS,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelStartOptions,
	kernelIpcTraceEnvVar,
	launchKernelSubprocess,
} from "../kernel-base";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";

export type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelRuntimeEnv,
	KernelShutdownOptions,
	KernelShutdownResult,
} from "../kernel-base";

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

const TRACE_IPC = $flag(kernelIpcTraceEnvVar("PYTHON"));

const ensureRunnerScript = createRunnerScriptPublisher("python", RUNNER_SCRIPT, "py");

const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS;
// How long to wait after SIGINT for the runner to emit `done`. If the cell is
// stuck in code that ignores Python signals (e.g. a C extension holding the
// GIL), we escalate to a full subprocess shutdown so the host queue unblocks
// instead of hanging the session forever. The grace window is intentionally
// generous: a clean interrupt is far preferable to losing the persistent
// kernel's state, so we only kill as a last-resort recovery path.

export interface PythonKernelAvailability {
	ok: boolean;
	/** The interpreter that answered the probe. Present only when `ok` is true. */
	pythonPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: PythonRuntime;
}

export const checkPythonKernelAvailability = createLanguageAvailabilityChecker<PythonRuntime, "pythonPath">(
	{
		skipFlag: "VEYYON_PYTHON_SKIP_CHECK",
		filterEnv,
		enumerateRuntimes: (cwd, baseEnv, interpreter) =>
			interpreter
				? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
				: enumeratePythonRuntimes(cwd, baseEnv),
		missingReason: "Python executable not found on PATH",
		probeRuntime: (runtime, cwd) =>
			$`${runtime.pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow().cwd(cwd).env(runtime.env),
		getExecutablePath: runtime => runtime.pythonPath,
		includeFailedExecutablePath: false,
		formatFailureReason: failures => `No working Python interpreter found. Tried: ${failures.join("; ")}`,
	},
	"pythonPath",
);

export class PythonKernel extends BaseKernel {
	private constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			interruptEscalationMs: KERNEL_INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
		});
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		return await launchKernelSubprocess({
			languageName: "Python",
			options,
			checkAvailability: checkPythonKernelAvailability,
			resolveRuntimeFallback: (cwd, interpreter, shellEnv) =>
				interpreter
					? resolveExplicitPythonRuntime(interpreter, cwd, filterEnv(shellEnv))
					: resolvePythonRuntime(cwd, filterEnv(shellEnv)),
			ensureRunnerScript,
			createKernel: id => new PythonKernel(id),
			getExecutableCommand: (runtime, scriptPath) => [runtime.pythonPath, "-u", scriptPath],
			getSpawnEnv: (runtime, optionsEnv) =>
				assembleSpawnEnv(
					runtime.env,
					optionsEnv,
					{
						PYTHONUNBUFFERED: "1",
						PYTHONIOENCODING: "utf-8",
					},
					{ ownPropertiesOnly: true },
				),
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
			initScript: buildInitScript(options.cwd, options.env),
			preludeScript: PYTHON_PRELUDE,
			releaseReason: "python-kernel-startup-failed",
		});
	}
}
function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__veyyon_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__veyyon_cwd)",
		`__veyyon_env = ${JSON.stringify(envPayload)}`,
		"for __veyyon_key, __veyyon_val in __veyyon_env.items():\n    os.environ[__veyyon_key] = __veyyon_val",
		"if __veyyon_cwd not in sys.path:\n    sys.path.insert(0, __veyyon_cwd)",
	].join("\n");
}
