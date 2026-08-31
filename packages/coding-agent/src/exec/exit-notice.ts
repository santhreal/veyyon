// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { signalName } from "@veyyon/utils/signal-exit";

/**
 * The one place the "how this command ended" notice is worded.
 *
 * This line is appended to a failed command's output by the bash tool, the
 * `eval` tool, the ssh tool, the `!` shell messages in the transcript, and the
 * legacy extension shim, and it is matched by a regex in the task renderer so it
 * can be stripped back out of the recent-output pane. Six writers and one
 * reader, all of which have to agree on the exact bytes, is precisely the shape
 * that drifts: a notice reworded in one producer stops being stripped by the
 * renderer and shows up twice.
 *
 * So the wording lives here and every one of them calls it.
 */

/**
 * The notice for a command that ended with `exitCode`.
 *
 * Pass `signal` when the command died from one. The exit code stays as the
 * shell reports it (`128 + signal`), because a script comparing `$?` against
 * 137 is still right to; the notice says which of the two identical-looking
 * causes it actually was. Without the signal, `Command exited with code 137` is
 * equally true of an out-of-memory kill and of a program returning 137 on
 * purpose, and those want opposite responses.
 */
export function formatExitCodeNotice(exitCode: number, signal?: number): string {
	if (signal === undefined) return `Command exited with code ${exitCode}`;
	const name = signalName(signal);
	const described = name ? `${name} (${signal})` : `signal ${signal}`;
	return `Command was killed by ${described}; the shell reports this as exit code ${exitCode}`;
}

/**
 * Matches either wording {@link formatExitCodeNotice} produces, anchored to a
 * whole line.
 *
 * The renderer strips this line from the recent-output pane, so it must track
 * both forms. A regex that knew only the plain wording would leave a signalled
 * death's notice visible where an ordinary exit's is removed, which reads as a
 * rendering bug rather than as the extra information it is.
 */
export const EXIT_CODE_NOTICE_RE =
	/^(?:Command exited with code -?\d+|Command was killed by (?:SIG\w+ \(\d+\)|signal \d+); the shell reports this as exit code -?\d+)$/u;
