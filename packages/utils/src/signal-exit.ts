import * as os from "node:os";

/**
 * Translating between a signal name, a signal number, and the exit code a shell
 * reports for a process that died from it.
 *
 * A shell reports a signalled death through `$?` as `128 + signal`, so SIGKILL
 * becomes 137 and SIGTERM becomes 143. That encoding is lossy: a program that
 * calls `exit(137)` produces the identical status. Anywhere veyyon knows the
 * real signal it keeps the number alongside the code rather than folding one
 * into the other, and these helpers are the single place that conversion is
 * spelled out.
 *
 * The numbers come from `os.constants.signals`, which is the platform's own
 * table, so nothing here hardcodes a value that varies between platforms
 * (SIGCHLD is 17 on Linux and 20 on macOS, to pick the usual example).
 */

/** Offset a shell adds to a signal number to form the exit status it reports. */
export const SIGNAL_EXIT_BASE = 128;

const SIGNAL_NUMBERS = os.constants.signals as unknown as Record<string, number | undefined>;

/**
 * The number for a signal name, or `undefined` if this platform has no such
 * signal.
 *
 * Accepts the canonical uppercase form with the `SIG` prefix ("SIGKILL") and
 * the bare form ("KILL"), because both spellings reach veyyon: PTYs and
 * `Bun.Subprocess.signalCode` report the prefixed name, while `kill -l` output
 * and some wire protocols drop it.
 */
export function signalNumber(name: string): number | undefined {
	const upper = name.trim().toUpperCase();
	if (upper.length === 0) return undefined;
	const prefixed = upper.startsWith("SIG") ? upper : `SIG${upper}`;
	return SIGNAL_NUMBERS[prefixed];
}

/**
 * The exit status a shell reports for a process killed by `name`, or
 * `undefined` if this platform has no such signal.
 *
 * This is the value that belongs in an `exitCode` field, and it is deliberately
 * NOT the whole story: report {@link signalNumber} separately so a caller can
 * tell this apart from a program that chose the same number itself.
 */
export function signalExitCode(name: string): number | undefined {
	const number = signalNumber(name);
	return number === undefined ? undefined : SIGNAL_EXIT_BASE + number;
}

/**
 * The name of a signal number, or `undefined` if this platform has no such
 * signal.
 *
 * Used for reporting, where "SIGKILL" tells an operator far more than 9 does.
 * Built by inverting the platform table rather than by a second hardcoded list,
 * so the two directions can never disagree.
 */
export function signalName(number: number): string | undefined {
	for (const [name, value] of Object.entries(SIGNAL_NUMBERS)) {
		if (value === number) return name;
	}
	return undefined;
}
