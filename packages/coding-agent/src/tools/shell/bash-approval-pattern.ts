/**
 * The scope a session grant for one bash call covers.
 *
 * A grant is matched by string equality with the pattern a later call derives
 * here, so this function is the whole of what a grant can reach. It derives a
 * pattern only for a command the shell runs as one program with literal
 * arguments:
 *
 * - Every word is plain: no quoting, expansion, globbing, redirection, command
 *   separator, subshell, comment or newline. `git status; rm -rf ~`,
 *   `git status $(curl …)` and `git status > ~/.bashrc` derive nothing, so they
 *   can never match a grant given for `git status`.
 * - No word assigns a variable ahead of the program (`LD_PRELOAD=… ls`).
 *
 * The pattern is `<program> <subcommand> *` when the second word is shaped like
 * a subcommand, so `git status -s` and `git status --short` share one grant.
 * Otherwise it is the command itself, and only that exact command is covered.
 * A program that runs its arguments as another command (`sudo`, `xargs`,
 * `bash`, `ssh` …) always gets the exact form: its "subcommand" is a second
 * program the card would not show.
 *
 * The caller decides whether the call's environment and working directory
 * allow a pattern at all; this reads the command text only.
 */

/** A word the shell passes through unchanged: no quote, `$`, glob, `~`, operator or whitespace. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** A second word read as a subcommand (`status`, `run`, `build-all`), not a path, flag or value. */
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
/** A program word that assigns a variable for the command after it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Longest pattern offered, so the approval row stays one line. */
export const MAX_BASH_APPROVAL_PATTERN_LENGTH = 48;

/** Programs whose arguments are themselves a command to run. */
const COMMAND_RUNNERS: ReadonlySet<string> = new Set([
	".",
	"bash",
	"builtin",
	"command",
	"dash",
	"doas",
	"env",
	"eval",
	"exec",
	"fish",
	"ionice",
	"ksh",
	"nice",
	"nohup",
	"source",
	"ssh",
	"stdbuf",
	"sudo",
	"sh",
	"time",
	"timeout",
	"watch",
	"xargs",
	"zsh",
]);

export function bashApprovalPattern(command: string): string | undefined {
	const words = command.trim().split(/[ \t]+/);
	const [program, second] = words;
	if (!program || !words.every(word => PLAIN_WORD.test(word)) || ASSIGNMENT.test(program)) return undefined;
	const runsAnotherCommand = COMMAND_RUNNERS.has(program.slice(program.lastIndexOf("/") + 1));
	const pattern =
		second !== undefined && SUBCOMMAND.test(second) && !runsAnotherCommand
			? `${program} ${second} *`
			: words.join(" ");
	return pattern.length <= MAX_BASH_APPROVAL_PATTERN_LENGTH ? pattern : undefined;
}
