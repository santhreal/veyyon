import * as os from "node:os";
import * as path from "node:path";
import { $flag, errorMessage, isBunTestRuntime } from "@veyyon/utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { DEFAULT_KERNEL_STARTUP_TIMEOUT_MS, kernelIpcTraceEnvVar, kernelRunnerCacheDir } from "../kernel-base";
import { enumerateRubyRuntimes, filterEnv, type RubyRuntime } from "./runtime";

export type { KernelExecuteOptions, KernelExecuteResult, KernelRuntimeEnv, KernelShutdownResult } from "../kernel-base";

export type { KernelDisplayOutput, PythonStatusEvent } from "../py/display";
export { renderKernelDisplay } from "../py/display";

export const TRACE_IPC = $flag(kernelIpcTraceEnvVar("RUBY"));

export const RUNNER_CACHE_DIR = kernelRunnerCacheDir(os.tmpdir(), "ruby");
export const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS;

export interface RubyKernelAvailability {
	ok: boolean;
	rubyPath?: string;
	reason?: string;
	runtime?: RubyRuntime;
}

export const availabilityCache = new Map<string, Promise<RubyKernelAvailability>>();

export async function checkRubyKernelAvailability(cwd: string, interpreter?: string): Promise<RubyKernelAvailability> {
	if (isBunTestRuntime() || $flag("VEYYON_RUBY_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probeRubyKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probeRubyKernelAvailability(cwd: string, interpreter?: string): Promise<RubyKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = enumerateRubyRuntimes(cwd, baseEnv, interpreter);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Ruby executable not found on PATH" };
		}
		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const probe = await $`${runtime.rubyPath} -e ${"exit 0"}`.quiet().nothrow().cwd(cwd).env(runtime.env);
				if (probe.exitCode === 0) {
					return { ok: true, rubyPath: runtime.rubyPath, runtime };
				}
				failures.push(`${runtime.rubyPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.rubyPath} (${errorMessage(err)})`);
			}
		}
		return {
			ok: false,
			rubyPath: runtimes[0].rubyPath,
			reason: `No working Ruby interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: errorMessage(err) };
	}
}
