/**
 * Subprocess-backed Julia runner.
 *
 * The IPC loop, lifecycle, and display rendering are shared with the Python and
 * Ruby runners via BaseKernel; this module supplies the Julia binary, runner
 * script, and the runner's TSV/Base64 wire protocol.
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
import type { KernelDisplayOutput } from "../py/display";
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

const ensureRunnerScript = createRunnerScriptPublisher("julia", RUNNER_SCRIPT, "jl");

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

export const checkJuliaKernelAvailability = createLanguageAvailabilityChecker<JuliaRuntime, "juliaPath">(
	{
		skipFlag: "VEYYON_JULIA_SKIP_CHECK",
		filterEnv,
		enumerateRuntimes: (cwd, baseEnv, interpreter) => enumerateJuliaRuntimes(cwd, baseEnv, interpreter),
		missingReason: "Julia executable not found on PATH. Please install Julia (https://julialang.org/).",
		probeRuntime: (runtime, cwd) => $`${runtime.juliaPath} -e "exit(0)"`.quiet().nothrow().cwd(cwd).env(runtime.env),
		getExecutablePath: runtime => runtime.juliaPath,
		includeFailedExecutablePath: true,
		formatFailureReason: failures => `No working Julia interpreter found. Tried: ${failures.join("; ")}`,
	},
	"juliaPath",
);

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
		return await launchKernelSubprocess({
			languageName: "Julia",
			options,
			checkAvailability: checkJuliaKernelAvailability,
			resolveRuntimeFallback: (cwd, interpreter, shellEnv) =>
				interpreter
					? resolveExplicitJuliaRuntime(interpreter, cwd, filterEnv(shellEnv))
					: resolveJuliaRuntime(cwd, filterEnv(shellEnv)),
			ensureRunnerScript,
			createKernel: id => new JuliaKernel(id),
			getExecutableCommand: (runtime, scriptPath) => [
				runtime.juliaPath,
				"--startup-file=no",
				"--history-file=no",
				"--color=no",
				"--project=@.",
				scriptPath,
			],
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
			initScript: buildInitScript(options.cwd, options.env),
			preludeScript: JULIA_PRELUDE,
			releaseReason: "julia-kernel-startup-failed",
		});
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
