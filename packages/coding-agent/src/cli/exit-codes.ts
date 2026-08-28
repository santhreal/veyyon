/** The exit codes the veyyon CLI returns, and what each one means. script, a CI step, or a wrapping agent can branch on, so it has to mean the */

/** The command completed successfully. */
export const EXIT_OK = 0;

/** The command was understood and attempted, and it failed. Covers everything from a missing file to a provider error to an export that */
export const EXIT_FAILURE = 1;

/** The command line was wrong, so nothing was attempted. An unrecognized flag, a missing required prompt, an interactive launch with no */
export const EXIT_USAGE = 2;

/** Base a signalled death is reported from, following the POSIX shell convention: a process killed by signal N exits `128 + N`. */
export { SIGNAL_EXIT_BASE } from "@veyyon/utils/signal-exit";

/** Veyyon itself was interrupted: `128 + SIGINT`. A second Ctrl+C during shutdown hard-aborts rather than waiting on a teardown */
export const EXIT_INTERRUPTED = 130;

/** Every exit code the CLI itself produces, for docs and tests to enumerate. */
export const CLI_EXIT_CODES = {
	failure: EXIT_FAILURE,
	interrupted: EXIT_INTERRUPTED,
	ok: EXIT_OK,
	usage: EXIT_USAGE,
} as const;
