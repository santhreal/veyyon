/**
 * Subprocess-backed Julia runner.
 *
 * The IPC loop, lifecycle, and display rendering are shared with the Python and
 * Ruby runners via BaseKernel; this module supplies the Julia binary, runner
 * script, and the runner's TSV/Base64 wire protocol.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, errorMessage, isBunTestRuntime, Snowflake } from "@veyyon/utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import {
	BaseKernel,
	DEFAULT_KERNEL_STARTUP_TIMEOUT_MS,
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
import type { KernelDisplayOutput } from "../py/display";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "../py/spawn-options";
import { JULIA_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.jl" with { type: "text" };
import {
	enumerateJuliaRuntimes,
	filterEnv,
	type JuliaRuntime,
	resolveExplicitJuliaRuntime,
	resolveJuliaRuntime,
} from "./runtime";

export type { KernelExecuteOptions, KernelExecuteResult, KernelRuntimeEnv } from "../kernel-base";
export { renderKernelDisplay } from "../py/display";
export type { KernelDisplayOutput };

const TRACE_IPC = $flag(kernelIpcTraceEnvVar("JULIA"));

// Cache the runner script on disk so the subprocess loads it normally. Cached
// per script hash so installs don't race across versions.
const RUNNER_CACHE_DIR = kernelRunnerCacheDir(os.tmpdir(), "julia");
let RUNNER_SCRIPT_PATH: string | null = null;

async function ensureRunnerScript(): Promise<string> {
	if (RUNNER_SCRIPT_PATH) return RUNNER_SCRIPT_PATH;
	await fs.promises.mkdir(RUNNER_CACHE_DIR, { recursive: true });
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(RUNNER_CACHE_DIR, `runner-${hash}.jl`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, RUNNER_SCRIPT);
	}
	RUNNER_SCRIPT_PATH = target;
	return target;
}

// Julia compiles both the runner and the prelude on first load. Clean hosted
// runners have taken more than 30 seconds before accepting their first cell, so
// cold starts need a wider budget than cached local launches.
const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS + 50_000;

export interface JuliaKernelAvailability {
	ok: boolean;
	juliaPath?: string;
	runtime?: JuliaRuntime;
	reason?: string;
}

// Cache successful probes per resolved cwd + explicit interpreter. Failures are
// not cached so installing Julia mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<JuliaKernelAvailability>>();

export async function checkJuliaKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<JuliaKernelAvailability> {
	// Same fast path Python and Ruby have. Probing spawns the interpreter, so under `bun test` every suite
	// that touches the executor paid a process spawn and then failed on machines without Julia, which is
	// most of them: the executor's kernel lifecycle is what those suites are about, not whether this host
	// can run Julia. Integration suites that need a real kernel reach the probe through the runner.
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

async function probeJuliaKernelAvailability(cwd: string, interpreter?: string): Promise<JuliaKernelAvailability> {
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

export class JuliaKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Julia",
			traceIpc: TRACE_IPC,
			exitPayload: "exit",
			interruptEscalationMs: KERNEL_INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: KERNEL_SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) => {
				// Convert arguments into a TSV / Base64 payload.
				const cwdB64 = Buffer.from(opts?.cwd ?? "").toString("base64");
				const silentVal = opts?.silent ? "1" : "0";
				const storeHistVal = opts?.storeHistory !== false && !opts?.silent ? "1" : "0";

				// Format environment variables as key1_b64:val1_b64 key2_b64:val2_b64.
				// A `null` in the patch CLEARS the variable, and the wire needs a way to say
				// that: the key is prefixed with `!` and the value left empty. `!` is not in
				// the base64 alphabet, so it cannot collide with an encoded key, and a runner
				// that predates the marker simply fails to decode that one pair rather than
				// setting the variable to something wrong.
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

		const scriptPath = await ensureRunnerScript();
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

/**
 * The `cd` + env preamble prepended to a Julia execution request.
 *
 * `null` CLEARS a variable and `undefined` leaves it alone, which is the contract
 * {@link KernelEnvPatch} documents and the Python runner already honoured. This
 * function used to take `Record<string, string | undefined>` and test only
 * `value !== undefined`, so a `null` reached `Buffer.from(null)` and threw a
 * TypeError while BUILDING the script -- the request failed before Julia saw a byte
 * of it.
 *
 * Exported so the regression suite can assert the emitted bytes directly. The
 * alternative is a live kernel, which needs the interpreter installed and would not
 * run in CI, and this contract is precisely about what text gets generated.
 */
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
	// Avoid modifying LOAD_PATH if not necessary, but if needed, prepend cwd
	lines.push("if !(__veyyon_init_cwd in LOAD_PATH); pushfirst!(LOAD_PATH, __veyyon_init_cwd); end");
	return lines.join("\n");
}
