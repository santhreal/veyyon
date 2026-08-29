import { Snowflake } from "@veyyon/utils";
import { Settings } from "../../config/settings";
import {
	BaseKernel,
	ensureRunnerScript,
	getRemainingTimeMs,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	type KernelEnvPatch,
	type KernelExecuteOptions,
	type KernelStartOptions,
	releaseKernel,
} from "../kernel-base";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "../py/spawn-options";
import { checkJuliaKernelAvailability, RUNNER_CACHE_DIR, STARTUP_TIMEOUT_MS, TRACE_IPC } from "./kernel-helpers";
import { JULIA_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.jl" with { type: "text" };
import { filterEnv, resolveExplicitJuliaRuntime, resolveJuliaRuntime } from "./runtime";

export { checkJuliaKernelAvailability };

export class JuliaKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Julia",
			traceIpc: TRACE_IPC,
			exitPayload: "exit",
			interruptEscalationMs: KERNEL_INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) => {
				const cwdB64 = Buffer.from(opts?.cwd ?? "").toString("base64");
				const silentVal = opts?.silent ? "1" : "0";
				const storeHistVal = opts?.storeHistory !== false && !opts?.silent ? "1" : "0";

				const envPairs: string[] = [];
				if (opts?.env) {
					for (const key in opts.env) {
						const val = opts.env[key];
						if (val === undefined) continue;
						const k_b64 = Buffer.from(key).toString("base64");
						envPairs.push(val === null ? `!${k_b64}:` : `${k_b64}:${Buffer.from(val).toString("base64")}`);
					}
				}
				const envPairsStr = envPairs.join(" ");
				const codeB64 = Buffer.from(code).toString("base64");

				return `run\t${msgId}\t${cwdB64}\t${silentVal}\t${storeHistVal}\t${envPairsStr}\t${codeB64}`;
			},
		});
	}

	static async start(options: KernelStartOptions): Promise<JuliaKernel> {
		const availability = await checkJuliaKernelAvailability(options.cwd, options.interpreter);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Julia kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitJuliaRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveJuliaRuntime(options.cwd, filterEnv(shellEnv));
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

		const scriptPath = await ensureRunnerScript(RUNNER_CACHE_DIR, RUNNER_SCRIPT, "jl");
		const kernel = new JuliaKernel(Snowflake.next());

		const proc = Bun.spawn(
			[runtime.juliaPath, "--startup-file=no", "--history-file=no", "--color=no", "--project=@.", scriptPath],
			{
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
			},
		);
		options.adoptPid?.(proc.pid);
		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Julia kernel init");
			await kernel.executeWithBudget(JULIA_PRELUDE, startup.signal, startupBudget, "Julia kernel prelude");
			return kernel;
		} catch (err) {
			await releaseKernel(kernel, "julia-kernel-startup-failed", { timeoutMs: KERNEL_SHUTDOWN_GRACE_MS });
			throw err;
		}
	}
}

export function buildInitScript(cwd: string, env?: KernelEnvPatch): string {
	const b64 = (text: string) => Buffer.from(text).toString("base64");
	const lines = [
		`__veyyon_init_cwd = String(Base64.base64decode("${b64(cwd)}"))`,
		"try cd(__veyyon_init_cwd) catch; end",
	];
	for (const key in env) {
		const value = env[key];
		if (value === undefined) continue;
		const keyExpr = `String(Base64.base64decode("${b64(key)}"))`;
		lines.push(
			value === null ? `delete!(ENV, ${keyExpr})` : `ENV[${keyExpr}] = String(Base64.base64decode("${b64(value)}"))`,
		);
	}
	lines.push("if !(__veyyon_init_cwd in LOAD_PATH); pushfirst!(LOAD_PATH, __veyyon_init_cwd); end");
	return lines.join("\n");
}
