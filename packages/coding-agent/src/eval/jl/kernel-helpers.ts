import * as os from "node:os";
import * as path from "node:path";
import { $flag, errorMessage, isBunTestRuntime } from "@veyyon/utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { DEFAULT_KERNEL_STARTUP_TIMEOUT_MS, kernelIpcTraceEnvVar, kernelRunnerCacheDir } from "../kernel-base";
import type { KernelDisplayOutput } from "../py/display";
import { enumerateJuliaRuntimes, filterEnv, type JuliaRuntime } from "./runtime";

export type { KernelExecuteOptions, KernelExecuteResult, KernelRuntimeEnv } from "../kernel-base";

export { renderKernelDisplay } from "../py/display";
export type { KernelDisplayOutput };

export const TRACE_IPC = $flag(kernelIpcTraceEnvVar("JULIA"));

export const RUNNER_CACHE_DIR = kernelRunnerCacheDir(os.tmpdir(), "julia");
export const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS + 50_000;

export interface JuliaKernelAvailability {
	ok: boolean;
	juliaPath?: string;
	runtime?: JuliaRuntime;
	reason?: string;
}

export const availabilityCache = new Map<string, Promise<JuliaKernelAvailability>>();

export async function checkJuliaKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<JuliaKernelAvailability> {
	if (isBunTestRuntime() || $flag("VEYYON_JULIA_SKIP_CHECK")) {
		return { ok: true };
	}
	const cacheKey = `${path.resolve(cwd)}::${interpreter ?? ""}`;
	let cached = availabilityCache.get(cacheKey);
	if (!cached) {
		cached = probeJuliaKernelAvailability(cwd, interpreter);
		availabilityCache.set(cacheKey, cached);
	}
	const result = await cached;
	if (!result.ok) {
		availabilityCache.delete(cacheKey);
	}
	return result;
}

async function probeJuliaKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<JuliaKernelAvailability> {
	const { env: shellEnv } = (await Settings.init()).getShellConfig();
	const baseEnv = filterEnv(shellEnv);
	const runtimes = enumerateJuliaRuntimes(cwd, baseEnv, interpreter);

	if (runtimes.length === 0) {
		return {
			ok: false,
			reason: "Julia executable not found on PATH. Please install Julia (https://julialang.org/).",
		};
	}

	const failures: string[] = [];
	for (const runtime of runtimes) {
		try {
			const probe = await $`${runtime.juliaPath} -e "exit(0)"`.quiet().nothrow().cwd(cwd).env(runtime.env);
			if (probe.exitCode === 0) {
				return { ok: true, juliaPath: runtime.juliaPath, runtime };
			}
			failures.push(`${runtime.juliaPath} (exit code ${probe.exitCode})`);
		} catch (err) {
			failures.push(`${runtime.juliaPath} (${errorMessage(err)})`);
		}
	}

	return {
		ok: false,
		juliaPath: runtimes[0].juliaPath,
		reason: `No working Julia interpreter found. Tried: ${failures.join("; ")}`,
	};
}
