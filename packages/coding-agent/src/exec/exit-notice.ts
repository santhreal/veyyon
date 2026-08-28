import { signalName } from "@veyyon/utils/signal-exit";

/** The one place the "how this command ended" notice is worded. This line is appended to a failed command's output by the bash tool, the */

/** The notice for a command that ended with `exitCode`. Pass `signal` when the command died from one. The exit code stays as the */
export function formatExitCodeNotice(exitCode: number, signal?: number): string {
	if (signal === undefined) return `Command exited with code ${exitCode}`;
	const name = signalName(signal);
	const described = name ? `${name} (${signal})` : `signal ${signal}`;
	return `Command was killed by ${described}; the shell reports this as exit code ${exitCode}`;
}

/** Matches either wording {@link formatExitCodeNotice} produces, anchored to a whole line. */
export const EXIT_CODE_NOTICE_RE =
	/^(?:Command exited with code -?\d+|Command was killed by (?:SIG\w+ \(\d+\)|signal \d+); the shell reports this as exit code -?\d+)$/u;
