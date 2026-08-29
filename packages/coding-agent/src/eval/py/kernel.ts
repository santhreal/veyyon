import { logger, Snowflake } from "@veyyon/utils";
import { Settings } from "../../config/settings";
import {
	BaseKernel,
	ensureRunnerScript,
	getRemainingTimeMs,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelStartOptions,
	releaseKernel,
} from "../kernel-base";
import { checkPythonKernelAvailability, RUNNER_CACHE_DIR, STARTUP_TIMEOUT_MS, TRACE_IPC } from "./kernel-helpers";

export * from "./kernel-helpers";

import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import { filterEnv, resolveExplicitPythonRuntime, resolvePythonRuntime } from "./runtime";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "./spawn-options";

export { checkPythonKernelAvailability };

export class PythonKernel extends BaseKernel {
	private constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: KERNEL_INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
				}),
		});
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitPythonRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolvePythonRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		spawnEnv.PYTHONUNBUFFERED = "1";
		spawnEnv.PYTHONIOENCODING = "utf-8";

		const scriptPath = await ensureRunnerScript(RUNNER_CACHE_DIR, RUNNER_SCRIPT, "py");
		const kernel = new PythonKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
			cwd: options.cwd,
			detached: shouldDetachKernel(process.platform),
			env: spawnEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});

		options.adoptPid?.(proc.pid);
		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Python kernel init");
			await kernel.executeWithBudget(PYTHON_PRELUDE, startup.signal, startupBudget, "Python kernel prelude");
			return kernel;
		} catch (err) {
			await releaseKernel(kernel, "python-kernel-startup-failed", { timeoutMs: KERNEL_SHUTDOWN_GRACE_MS });
			throw err;
		}
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
