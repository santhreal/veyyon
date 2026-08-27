/**
 * Running an external command this package needs, under a bound.
 *
 * Every spawn here was unbounded. The harbor and pier cleanups both defaulted to
 * `spawnSync("docker", …)` with no timeout, on the kill path — where an unresponsive daemon is the
 * likely reason the trial is being killed at all — and `spawnSync` blocks the thread, so one
 * `docker ps` waiting on a restarting daemon froze every worker, every trial deadline and the
 * manager's tick with it, with nothing printed. The launch probes had the same shape: a `docker
 * version` or a `command -v` through a login shell that never returned held the run before its first
 * trial.
 *
 * Two bounds, because the work differs by minutes: a probe or a cleanup answers in seconds, and a
 * build or an image pull does not. Neither is unbounded.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A probe, a cleanup, or anything else that reads state rather than producing an artifact. */
export const SHORT_COMMAND_TIMEOUT_MS = 30_000;

/** A build, a pack or an image pull: minutes of real work, still not forever. */
export const BUILD_COMMAND_TIMEOUT_MS = 900_000;

/** Enough of a command's result for the cleanups that parse `docker ps` and `docker network ls`. */
export interface CommandOutput {
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandOutput>;

/**
 * Runs one command and rejects on a non-zero exit, a missing binary, or the timeout. Keeps the event
 * loop running, so a command that hangs costs its own caller and nothing else.
 *
 * The child is killed with SIGKILL: a command that ignored the bound has already shown it is not
 * responding, and its output is discarded either way.
 */
export async function runBoundedCommand(
	file: string,
	args: readonly string[],
	timeoutMs = SHORT_COMMAND_TIMEOUT_MS,
): Promise<CommandOutput> {
	const result = await execFileAsync(file, [...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: 8 << 20,
	});
	return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * The bound for a `spawnSync` call that cannot become asynchronous — a launch probe whose caller is a
 * plain synchronous function. Spread it, so a site keeps its own `cwd` and `stdio`.
 */
export function syncCommandOptions(timeoutMs: number = SHORT_COMMAND_TIMEOUT_MS): {
	readonly encoding: "utf8";
	readonly timeout: number;
	readonly killSignal: "SIGKILL";
} {
	return { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" };
}
