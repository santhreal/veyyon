import { $which } from "./which";
/**
 * True when a PID refers to a live process.
 *
 * Uses `kill(pid, 0)` as an existence probe. EPERM means the process exists
 * but belongs to another user, so it still counts as alive; only ESRCH
 * (no such process) reports dead.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Human-facing failure message for a spawned CLI command: stderr, else stdout, else an exit-code line. */
export function commandFailureMessage(
	command: string,
	args: readonly string[],
	result: { exitCode: number | null; stdout: string; stderr: string },
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `${command} ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

/** Throw with an actionable message when a required CLI tool is missing from PATH. */
export function ensureCommandAvailable(command: string): void {
	if (!$which(command)) {
		throw new Error(`${command} is not installed.`);
	}
}

/** Single-quote a value for POSIX shells (embedded quotes become '\''). */
export function quoteShellArg(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
