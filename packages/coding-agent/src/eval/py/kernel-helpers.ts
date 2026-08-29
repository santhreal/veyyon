import * as os from "node:os";
import * as path from "node:path";
import { $flag, errorMessage, isBunTestRuntime } from "@veyyon/utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { DEFAULT_KERNEL_STARTUP_TIMEOUT_MS, kernelIpcTraceEnvVar, kernelRunnerCacheDir } from "../kernel-base";
import { enumeratePythonRuntimes, filterEnv, type PythonRuntime, resolveExplicitPythonRuntime } from "./runtime";

export type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelRuntimeEnv,
	KernelShutdownOptions,
	KernelShutdownResult,
} from "../kernel-base";

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

export const TRACE_IPC = $flag(kernelIpcTraceEnvVar("PYTHON"));

export const RUNNER_CACHE_DIR = kernelRunnerCacheDir(os.tmpdir(), "python");
export const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS;

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	runtime?: PythonRuntime;
}

export const availabilityCache = new Map<string, Promise<PythonKernelAvailability>>();

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<PythonKernelAvailability> {
	if (isBunTestRuntime() || $flag("VEYYON_PYTHON_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probePythonKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probePythonKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<PythonKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Python executable not found on PATH" };
		}
		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const probe = await $`${runtime.pythonPath} -c "import sys;sys.exit(0)"`
					.quiet()
					.nothrow()
					.cwd(cwd)
					.env(runtime.env);
				if (probe.exitCode === 0) {
					return { ok: true, pythonPath: runtime.pythonPath, runtime };
				}
				failures.push(`${runtime.pythonPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.pythonPath} (${errorMessage(err)})`);
			}
		}
		return {
			ok: false,
			reason: `No working Python interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: errorMessage(err) };
	}
}
