import * as os from "node:os";
import * as path from "node:path";
import { $flag, errorMessage, isBunTestRuntime, logger, Snowflake } from "@veyyon/utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import {
	BaseKernel,
	DEFAULT_KERNEL_STARTUP_TIMEOUT_MS,
	ensureRunnerScript,
	getRemainingTimeMs,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelEnvPatch,
	type KernelExecuteOptions,
	type KernelStartOptions,
	kernelIpcTraceEnvVar,
	kernelRunnerCacheDir,
	releaseKernel,
} from "../kernel-base";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "../py/spawn-options";
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

const RUNNER_CACHE_DIR = kernelRunnerCacheDir(os.tmpdir(), "ruby");
const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS;

export interface RubyKernelAvailability {
	ok: boolean;
	rubyPath?: string;
	reason?: string;
	runtime?: RubyRuntime;
}

const availabilityCache = new Map<string, Promise<RubyKernelAvailability>>();

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

export class RubyKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Ruby",
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

	static async start(options: KernelStartOptions): Promise<RubyKernel> {
		const availability = await logger.time(
			"RubyKernel.start:availabilityCheck",
			checkRubyKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Ruby kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitRubyRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveRubyRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const key in runtime.env) {
			const value = runtime.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const key in options.env) {
			const value = options.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}

		const scriptPath = await ensureRunnerScript(RUNNER_CACHE_DIR, RUNNER_SCRIPT, "rb");
		const kernel = new RubyKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.rubyPath, scriptPath], {
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
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Ruby kernel init");
			await kernel.executeWithBudget(RUBY_PRELUDE, startup.signal, startupBudget, "Ruby kernel prelude");
			return kernel;
		} catch (err) {
			await releaseKernel(kernel, "ruby-kernel-startup-failed", { timeoutMs: KERNEL_SHUTDOWN_GRACE_MS });
			throw err;
		}
	}
}

export function buildInitScript(cwd: string, env?: KernelEnvPatch): string {
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
