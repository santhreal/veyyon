/**
 * The exit codes the veyyon CLI returns, and what each one means.
 *
 * WHY THIS FILE EXISTS. An exit code is an API. It is the only thing a shell
 * script, a CI step, or a wrapping agent can branch on, so it has to mean the
 * same thing at every exit and it has to be written down somewhere a caller can
 * read. Before this module the codes were twenty bare `process.exit(0|1|2)`
 * calls spread across `main.ts` and `cli.ts`, with the meaning of `2` recorded
 * only in a comment next to one of them. Nothing stopped the next exit from
 * picking a different number for the same class of failure, and nothing told a
 * user what they had received.
 *
 * The contract, which matches the long-standing Unix convention:
 *
 *   0  the command did what you asked
 *   1  the command ran and failed
 *   2  the command line was wrong, so nothing ran
 *
 * The distinction between 1 and 2 is the useful one. A `2` says retrying is
 * pointless until the invocation changes, which is exactly what a wrapper needs
 * to know before it loops.
 *
 * Anything a subprocess produces passes through unchanged: a `bash` tool result
 * carries the command's own status, and folding it into one of these would lose
 * information a caller may want.
 *
 * When you add an exit, use one of these constants. When you need a new class,
 * add it here with a description first, and update `docs/exit-codes.md` in the
 * same change.
 */

/** The command completed successfully. */
export const EXIT_OK = 0;

/**
 * The command was understood and attempted, and it failed.
 *
 * Covers everything from a missing file to a provider error to an export that
 * could not be written. A caller that retries on this may succeed, because the
 * invocation itself was valid.
 */
export const EXIT_FAILURE = 1;

/**
 * The command line was wrong, so nothing was attempted.
 *
 * An unrecognized flag, a missing required prompt, an interactive launch with no
 * terminal to be interactive in. Retrying the identical invocation cannot help.
 * This is the conventional Unix "command line usage error", and keeping it
 * distinct from {@link EXIT_FAILURE} is what lets a wrapping script stop rather
 * than loop.
 */
export const EXIT_USAGE = 2;

/**
 * Base a signalled death is reported from, following the POSIX shell
 * convention: a process killed by signal N exits `128 + N`.
 *
 * Re-exported from the one owner in `@veyyon/utils` rather than restated, so the
 * CLI's arithmetic and the bash tool's cannot disagree about what a `137` means.
 */
// Subpath, not the barrel: see the note in `args.ts` -- the barrel loads the agent `.env` at import time
// and this module is reachable from `cli.ts` before the profile is known.
export { SIGNAL_EXIT_BASE } from "@veyyon/utils/signal-exit";

/**
 * Veyyon itself was interrupted: `128 + SIGINT`.
 *
 * A second Ctrl+C during shutdown hard-aborts rather than waiting on a teardown
 * step that is stuck, and this is the status that says so. It is deliberately
 * NOT {@link EXIT_FAILURE}: a user cancelling is not the command failing, and a
 * CI step that treats the two alike reports a cancelled job as a broken one.
 */
export const EXIT_INTERRUPTED = 130;

/** Every exit code the CLI itself produces, for docs and tests to enumerate. */
export const CLI_EXIT_CODES = {
	failure: EXIT_FAILURE,
	interrupted: EXIT_INTERRUPTED,
	ok: EXIT_OK,
	usage: EXIT_USAGE,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];
