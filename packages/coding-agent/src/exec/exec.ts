/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { ptree } from "@veyyon/utils";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Session CPU budget hook: the spawned process joins the session's budget group. */
	adoptPid?: (pid: number) => void;
	/**
	 * Called before the process is created. Spawn sites that join a session CPU
	 * budget pass the session gate here so a saturated or uncreated group
	 * refuses the command instead of launching it and adopting afterwards.
	 */
	beforeSpawn?: () => Promise<void>;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	await options?.beforeSpawn?.();
	const result = await ptree.exec([command, ...args], {
		cwd,
		signal: options?.signal,
		timeout: options?.timeout,
		onSpawnPid: options?.adoptPid,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.exitCode ?? 0,
		killed: Boolean(result.exitError?.aborted),
	};
}

/**
 * Merge session CPU budget hooks onto an `exec` options object. `gate` runs
 * as `beforeSpawn` so a saturated group refuses the command before the
 * process exists; `adoptPid` then joins the child if the spawn proceeds.
 */
export function withSessionCpuExec(
	options: ExecOptions | undefined,
	adoptPid: ((pid: number) => void) | undefined,
	gate: ((what: string) => Promise<void>) | undefined,
	what: string,
): ExecOptions | undefined {
	if (!adoptPid && !gate) return options;
	return {
		...options,
		...(adoptPid ? { adoptPid } : {}),
		...(gate ? { beforeSpawn: () => gate(what) } : {}),
	};
}
