/**
 * The one owner of "is this bash command critical".
 *
 * WHY THIS IS NOT A REGEX. `FLAGGED_BASH_PATTERNS` matches the command as
 * TEXT, and every published home-directory wipe happened at EXPANSION time,
 * after such a check passes. The pattern for recursive deletion is
 * `/\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i`, which anchors the slash immediately
 * after the flags. That makes it a first-ARGUMENT check presented as a command
 * check, so it flags `rm -rf /` and misses all of these:
 *
 *     rm -rf ~/                          the shell expands the tilde, the regex does not
 *     rm -rf ~
 *     rm -rf $HOME
 *     rm -rf "$HOME"/
 *     rm -rf ${HOME}/.config
 *     rm -rf tests/patches/plan/ ~/      December 2025, a real home directory
 *     rm -rf tests/ /                    literal root, just not the first target
 *     rm -rf "$dir"/*                    July 2026, `dir` expanded to nothing
 *     find ~ -delete                     not `rm` at all
 *
 * So this module does the small amount of shell the question needs: split the
 * line into segments, split each segment into words the way a shell would,
 * expand the parts of a word whose value we can know, and then ask whether any
 * resulting target is a path no agent should be recursively deleting.
 *
 * IT FAILS CLOSED. A word we cannot expand, in a command that deletes
 * recursively, is treated as critical. `rm -rf "$dir"/*` has no safe reading:
 * if `dir` is empty the command starts at the root, and nothing in the text
 * says whether it is. The cost of being wrong here is one approval prompt; the
 * cost of the other mistake is the incident this module is named after.
 *
 * WHAT IT IS NOT. This is not containment. A shell function, an `eval`, or a
 * script invoked by name defeats any parser, and the layer that does not
 * depend on being right is the kernel refusing the write. See
 * `FINDING-A-BLOCKED-COMMAND-IS-A-GUESS-UNTIL-THE-KERNEL-REFUSES-THE-WRITE`.
 */

import * as os from "node:os";

/**
 * Whether a flagged bash shape survives the yolo rung.
 *
 * `destroys` is irreversible loss of data or of this host: a formatted disk, an
 * overwritten device, a system account file, a delete running as root. This is
 * the floor the yolo rung and the `/yolo` bypass keep, and it is the only thing
 * the rung's own copy has ever promised still asks: "only blatantly destructive
 * commands (rm -rf / and its expansions)".
 *
 * `dangerous` runs code nobody read, restarts the host, or wires a shell to a
 * socket. Every rung below yolo stops on it exactly as it stops on `destroys`,
 * because both force a prompt at a tier that would otherwise run. Yolo does
 * not, and that is the point: an operator who typed `curl … | sh` themselves,
 * in the rung whose entire purpose is to stop asking, was being asked with the
 * reason "Critical pattern detected". A floor that catches an install is not a
 * floor, it is the `auto` rung wearing yolo's label.
 */
export type BashRiskSeverity = "destroys" | "dangerous";

/** One flagged bash shape: what to match, how bad it is, and what to tell the operator. */
export interface FlaggedBashPattern {
	readonly pattern: RegExp;
	readonly severity: BashRiskSeverity;
	/** Why this call stopped, shown verbatim as the approval dialog's reason. */
	readonly reason: string;
}

/**
 * Bash shapes flagged for approval policy.
 *
 * These are the shapes that are about TEXT rather than about a path: a fork
 * bomb, `mkfs`, `curl | sh`, writing to a raw device. There is nothing to
 * expand in any of them, so a pattern is the right tool and they stay here
 * beside the expansion-aware rules rather than in a second file.
 *
 * The recursive-deletion pattern that used to lead this list is gone, replaced
 * by [`findCriticalBashRisk`]. It could not be fixed by tightening: it read the
 * command as text, and the damage happens after expansion.
 *
 * Kept intentionally tight. The cost of a false negative is data loss or a
 * compromised host, while false positives remain actionable through user policy
 * control. New patterns should target shapes that are virtually never
 * legitimate in automation, and MUST pick a severity by the test above: a
 * `destroys` entry is one an operator would want stopped even after saying
 * "stop asking me".
 *
 * Every entry carries its own reason. The single "Critical pattern detected"
 * they used to share named the mechanism rather than the risk, so the dialog
 * told the operator that something in a list matched, and nothing about what.
 */
export const FLAGGED_BASH_PATTERNS: readonly FlaggedBashPattern[] = [
	{ pattern: /\bsudo\s+rm\b/i, severity: "destroys", reason: "Deletes files as root" },
	// `chmod -R 777 /`, then `chmod -R u+x /` and `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	{ pattern: /\bchmod\s+-R\s+[0-7]+\s+\//i, severity: "destroys", reason: "Rewrites permissions from a system root" },
	{
		pattern: /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
		severity: "destroys",
		reason: "Rewrites permissions from a system root",
	},
	{ pattern: /\bchown\s+-R\s+\S+\s+\//i, severity: "destroys", reason: "Rewrites ownership from a system root" },

	// Fork bomb (a few common spacings). Not data loss, but the host is gone
	// until it is power-cycled, and nobody types one on purpose.
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:/i, severity: "destroys", reason: "Fork bomb: takes this host down" },

	// Disk / filesystem destruction.
	{ pattern: />\s*\/dev\/sd[a-z]/i, severity: "destroys", reason: "Writes over a raw disk device" },
	{ pattern: /\bmkfs(\.|\b)/i, severity: "destroys", reason: "Formats a filesystem" },
	{ pattern: /\bdd\s+if=.+of=\/dev\//i, severity: "destroys", reason: "Writes a raw image over a device" },
	{ pattern: /\bshred\s+\/dev\//i, severity: "destroys", reason: "Shreds a raw device" },
	{ pattern: /\bcryptsetup\b/i, severity: "destroys", reason: "Reconfigures disk encryption" },

	// System-config destruction.
	{
		pattern: />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
		severity: "destroys",
		reason: "Overwrites a system account file",
	},
	// `tee /etc/passwd`, `tee -a /etc/sudoers`.
	{
		pattern: /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
		severity: "destroys",
		reason: "Overwrites a system account file",
	},

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	{
		pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	{
		pattern: /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	{
		pattern: /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},

	// Process/host control.
	{ pattern: /\bkill\s+-9\s+1\b/, severity: "dangerous", reason: "Kills process 1" },
	// Must sit at command position so `npm run reboot-tests` or
	// `echo 'shutdown the queue'` don't false-positive.
	{
		pattern: /(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
		severity: "dangerous",
		reason: "Shuts down or reboots this host",
	},
	{
		pattern: /(?:^|[\s;&|(])init\s+0\b/i,
		severity: "dangerous",
		reason: "Shuts down or reboots this host",
	},

	// Network-shell exfil: `nc -e` / `nc -c`.
	{
		pattern: /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
		severity: "dangerous",
		reason: "Wires a shell to a network socket",
	},
];

/**
 * The first flagged shape in `hostText`, or `undefined`.
 *
 * Order in the table decides which reason an operator sees when a line trips
 * two entries, and the destructive entries lead deliberately: a line that both
 * formats a disk and fetches a script is a disk being formatted.
 */
export function findFlaggedBashPattern(hostText: string): FlaggedBashPattern | undefined {
	if (hostText === "") return undefined;
	return FLAGGED_BASH_PATTERNS.find(entry => entry.pattern.test(hostText));
}

/**
 * Absolute paths a recursive delete may never target.
 *
 * The home directory itself is added at check time from the caller's
 * environment, because it is the one protected root whose value is not a
 * constant. Ancestors of the home directory are protected implicitly: deleting
 * `/home` takes the home directory with it.
 */
export const PROTECTED_ROOTS = [
	"/",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/opt",
	"/proc",
	"/root",
	"/sbin",
	"/srv",
	"/sys",
	"/usr",
	"/var",
	"/Applications",
	"/Library",
	"/System",
	"/Users",
	"/Volumes",
] as const;

/**
 * Home directories whose ENTIRE SUBTREE is refused, down to a single file.
 *
 * A private key or a credentials file is not recoverable by reinstalling
 * anything and is not regenerable from a lockfile, so `rm -rf ~/.aws/credentials`
 * is refused exactly as `rm -rf ~/.aws` is. The list is short on purpose: every
 * entry costs an approval prompt on any cleanup that reaches inside it.
 */
export const SECRET_HOME_DIRECTORIES = [".ssh", ".aws", ".gnupg", ".config/gcloud"] as const;

/**
 * Home directories protected AS DIRECTORIES: deleting one of these, or anything
 * that contains it, is refused, while deleting something INSIDE it is ordinary
 * work.
 *
 * `rm -rf ~/.config` takes every application's settings with it and is
 * virtually never what was meant. `rm -rf ~/.config/some-app` is a normal
 * cleanup, and refusing it would earn the guard a reputation for crying wolf,
 * which is how a guard ends up switched off.
 */
export const PROTECTED_HOME_DIRECTORIES = [
	".config",
	".kube",
	".docker",
	".veyyon",
	".claude",
	".local",
	".cache",
] as const;

/** Commands that remove a tree when given the right flags. */
const RECURSIVE_DELETE_COMMANDS = new Set(["rm", "rmdir", "shred", "srm"]);

/** Commands that rewrite a tree in place and are as destructive as a delete. */
const RECURSIVE_REWRITE_COMMANDS = new Set(["chmod", "chown", "chgrp"]);

/**
 * A command line that creates a temporary directory and then deletes exactly
 * that directory destroys nothing it did not create, so it is not critical.
 *
 * This is the `TMP=$(mktemp -d) && … && rm -rf "$TMP"` shape, which is the
 * single most common cleanup an agent writes. The guard used to refuse it, and
 * it was right to on the evidence it had: `$(mktemp -d)` is a command
 * substitution, which is one opaque word, so by the time it reached
 * `rm -rf "$TMP"` the variable was unresolvable and an unresolvable word in a
 * recursive delete fails closed. The refusal was sound and the answer was
 * still wrong, because the command text says where that value came from.
 *
 * WHAT CROSSES A SEGMENT BOUNDARY IS PROVENANCE, NOT A VALUE. Carrying the
 * value would reopen `cd / && rm -rf $PWD`, where an earlier segment rewrites
 * the very variable about to be judged. A name in this set carries no value,
 * so it cannot resolve any other expansion; it unlocks one shape and widens
 * nothing else.
 *
 * Three conditions, all required, and each one is a hole if dropped:
 *
 *   1. the value is a bare `mktemp` substitution, so the path is one this
 *      command line created rather than one it was handed;
 *   2. the name is not reassigned between the creation and the delete;
 *   3. the delete target is the WHOLE word `$VAR`, with no suffix and no glob.
 *
 * The third is the one that matters. `rm -rf "$TMP"/*` stays critical forever:
 * if `mktemp` failed then `TMP` is empty and that command is `rm -rf /*`, which
 * is the July 2026 incident in this module's header. The bare form has no such
 * reading, because an empty `TMP` makes it `rm -rf ""`, which deletes nothing.
 */
function isMktempCreation(value: string): boolean {
	const body = /^\$\(([\s\S]*)\)$/.exec(value)?.[1] ?? /^`([\s\S]*)`$/.exec(value)?.[1];
	if (body === undefined) return false;
	// The substitution must be ONE `mktemp` call, so its output is the path
	// mktemp made. A chained or redirected body can print anything at all.
	if (/[;&|\n<>`]|\$\(/.test(body)) return false;
	const parts = body.trim().split(/\s+/);
	const name = parts[0];
	if (name === undefined || basename(name) !== "mktemp") return false;
	for (const arg of parts.slice(1)) {
		// `-u` asks for a name WITHOUT creating it, so the path is one this
		// command did not make and something else may hold by the time rm runs.
		if (arg === "--dry-run" || arg === "-u") return false;
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("u")) return false;
	}
	// Where mktemp is told to put the directory does not matter: `-p /etc` still
	// creates one fresh entry and the delete still removes only that entry.
	return true;
}

/** True when this word is the whole, unquoted name of a self-created temp path. */
function namesSelfCreatedTemp(raw: { text: string; literal: boolean }, created: ReadonlySet<string>): boolean {
	// `'$TMP'` is a request to delete a directory actually named `$TMP`, which
	// is not the one we created, so it is judged normally.
	if (raw.literal) return false;
	const name =
		/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw.text)?.[1] ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.text)?.[1];
	return name !== undefined && created.has(name);
}

/** Commands that can run shell text this scan never sees. */
const RUNS_UNSEEN_SHELL = new Set(["eval", "source", ".", "bash", "sh", "zsh", "dash", "ksh", "ash"]);

/**
 * Withdraw the mktemp exemption from every name this segment could rebind.
 *
 * The exemption is keyed on a NAME, and a name can be written again, so the
 * rule that keeps it honest is "not reassigned since". There is nothing
 * unrebindable to key on instead: the guard sees command text, the delete
 * target is spelled `$T`, and `$T` is a name by definition. So the key stays a
 * name and this is what makes it sound.
 *
 * It is an ALLOWLIST on how the name is spelled, not a list of the builtins
 * that write one. Reading a name spells it as an expansion, `$T` or `${T}`.
 * Writing one spells it BARE, and every shell form does: `T=`, `export T=`,
 * `declare T=`, `read T`, `for T in`, `printf -v T`, `getopts o T`, `let T=1`,
 * `((T=1))`. So any bare occurrence withdraws, and a construct nobody here has
 * heard of is covered as long as it names its target, which it must.
 *
 * Naming the builtins was the first attempt and it was a blocklist: `export`,
 * `declare`, `readonly`, `local`, `read` and `eval` were six holes, each
 * leaving `rm -rf /` exempt, and the seventh is whatever the next shell ships.
 *
 * The residue is a command that writes a name without spelling it here, which
 * means a script this scan cannot read. Those withdraw everything. Withdrawal
 * only ever removes an exemption, so reading a word too broadly costs one
 * question and reading it too narrowly costs a directory.
 *
 * Returns the names rather than acting on them, because there are now TWO
 * things keyed on a name that a rebinding invalidates: the mktemp exemption and
 * the value an earlier segment assigned. One scan, both withdrawals.
 */
function reboundNames(words: readonly { text: string }[], watched: ReadonlySet<string>): string[] {
	if (watched.size === 0) return [];
	if (RUNS_UNSEEN_SHELL.has(basename(words[0]?.text ?? ""))) return [...watched];
	const rebound: string[] = [];
	for (const word of words) {
		const bare = /^([A-Za-z_][A-Za-z0-9_]*)(?:$|=|\[)/.exec(word.text)?.[1];
		if (bare !== undefined && watched.has(bare)) rebound.push(bare);
	}
	return rebound;
}

/**
 * Words that put an assignment behind them: `export DST=/srv`, `local d=…`.
 *
 * Not a blocklist of everything that can write a name — {@link reboundNames} is
 * what covers the rest, by withdrawing whatever it cannot read. This list only
 * decides whether the scan keeps LOOKING for assignments after the word, and
 * being wrong about a member costs a resolved value, never a missed delete.
 */
export const DECLARATION_BUILTINS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "readonly", "local"]);

/**
 * The value a name carries into the REST of the command line, or `undefined`
 * when the line does not settle it.
 *
 * Two things make a value unusable, and both are answered the same way, because
 * an unresolved name in a recursive delete is already critical:
 *
 *   - the value itself holds an expansion this module cannot resolve, so the
 *     text says no more than `$OTHER` did;
 *   - the AMBIENT environment holds a different value for the same name. The
 *     scan reads a line's segments unconditionally, but the shell does not run
 *     them all: `[ -z "$DST" ] && DST=/srv; rm -rf "$DST"` reaches the delete
 *     with the ambient value when `DST` was already set, so believing the
 *     assignment would judge a path the command may never touch and wave past
 *     the one it will.
 *
 * The first of those is belt and braces rather than the only defence: a value
 * this module cannot resolve always still holds a `$`, a backtick or a `~`, and
 * `isQuietlySubstitutable` refuses to paste any of those in later. No command
 * distinguishes the two, so the branch is stated here for its meaning — unknown
 * stays unknown — and not because a test can watch it work.
 */
function carriedValue(
	literal: boolean,
	value: string,
	home: string,
	enteringEnv: NodeJS.ProcessEnv,
	ambient: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const expanded = expandWord({ text: value, literal }, home, enteringEnv);
	if (expanded.unknown) return undefined;
	const outer = ambient[name];
	if (outer !== undefined && outer !== expanded.text) return undefined;
	return expanded.text;
}

/** What a word turned out to be once the parts we can expand were expanded. */
export interface ExpandedWord {
	/** The word with quotes removed and known expansions substituted. */
	readonly text: string;
	/** True when the word still holds an expansion whose value we cannot know. */
	readonly unknown: boolean;
	/** True when an expansion we could resolve produced an empty string. */
	readonly emptied: boolean;
}

/** Why a command was judged critical, in words an operator can act on. */
export interface CriticalBashRisk {
	/** The command word that does the damage, e.g. `rm`. */
	readonly command: string;
	/** The argument that made it critical, as written. */
	readonly argument: string;
	/** The path that argument resolves to, when it resolves to one. */
	readonly target?: string;
	/** One sentence naming the rule that fired. */
	readonly reason: string;
}

/** Characters that end one command and begin another, outside quotes. */
const SEGMENT_BREAKS = new Set([";", "&", "|", "\n", "(", ")"]);

/**
 * Split a command line into the individual commands it runs.
 *
 * Quoting is respected, so `echo "a; b"` is one segment and `a; b` is two.
 * This is deliberately coarser than a shell: redirections and here-documents
 * are left inside their segment, because nothing downstream reads them.
 *
 * A COMMAND SUBSTITUTION IS ONE OPAQUE WORD, not a segment break. `rm -rf
 * $(cat target.txt)` splits on the parentheses if you let it, and what is left
 * of the first segment is `rm -rf $`, whose target expands to nothing alarming.
 * That is a hole big enough to drive the whole guard through, so `$(` runs to
 * its matching `)` inside the current segment and reaches the expander as the
 * unresolvable word it is. A bare `(` still breaks, because a subshell really
 * does start a new command and its contents deserve judging.
 */
export function splitCommandSegments(line: string): string[] {
	return splitCommandSpans(line).map(span => span.text);
}

/** One command in a command line, with the bounds it occupies in that line. */
export interface CommandSpan {
	/** The command, trimmed, exactly as [`splitCommandSegments`] reports it. */
	readonly text: string;
	/** Index of the first character of the span in the line. */
	readonly start: number;
	/** Index just past the last character of the span. */
	readonly end: number;
}

/**
 * The same split, keeping where in the line each command sat.
 *
 * [`hostReachableCommand`] blanks one command in place rather than rejoining
 * the survivors, so it needs the bounds. Every other reader wants the strings.
 */
export function splitCommandSpans(line: string): CommandSpan[] {
	const spans: CommandSpan[] = [];
	let current = "";
	let start = 0;
	let quote: '"' | "'" | undefined;
	const push = (end: number): void => {
		const text = current.trim();
		if (text !== "") spans.push({ text, start, end });
		current = "";
		start = end + 1;
	};
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (character === "\\" && quote !== "'" && index + 1 < line.length) {
			current += character + line[index + 1]!;
			index += 1;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			current += character;
			continue;
		}
		if (character === "`") {
			const end = line.indexOf("`", index + 1);
			const stop = end === -1 ? line.length : end + 1;
			current += line.slice(index, stop);
			index = stop - 1;
			continue;
		}
		if (character === "$" && line[index + 1] === "(") {
			const stop = endOfCommandSubstitution(line, index + 1);
			current += line.slice(index, stop);
			index = stop - 1;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		if (SEGMENT_BREAKS.has(character)) {
			push(index);
			continue;
		}
		current += character;
	}
	push(line.length);
	return spans;
}

/**
 * The index just past the `)` that closes the `(` at `open`, counting nesting so
 * `$(dirname $(pwd))` is one word. An unbalanced substitution runs to the end of
 * the line, which is what the shell would report as an error and what the guard
 * should treat as one unresolvable word rather than as a split.
 */
function endOfCommandSubstitution(line: string, open: number): number {
	let depth = 0;
	for (let index = open; index < line.length; index += 1) {
		if (line[index] === "(") depth += 1;
		else if (line[index] === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return line.length;
}

/**
 * Split one segment into words the way a shell would, keeping enough of the
 * quoting to know which expansions survive.
 *
 * A single-quoted run is returned with its `$` intact but marked as literal, so
 * `rm -rf '$HOME'` is a request to delete a directory actually named `$HOME`
 * and is not confused with the expansion.
 */
export function splitWords(segment: string): { text: string; literal: boolean }[] {
	const words: { text: string; literal: boolean }[] = [];
	let current = "";
	let literal = false;
	let started = false;
	let quote: '"' | "'" | undefined;
	const push = (): void => {
		if (started) words.push({ text: current, literal });
		current = "";
		literal = false;
		started = false;
	};
	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index]!;
		if (character === "\\" && quote !== "'" && index + 1 < segment.length) {
			current += segment[index + 1]!;
			literal = true;
			started = true;
			index += 1;
			continue;
		}
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			current += character;
			started = true;
			continue;
		}
		// A command substitution is one word even when it contains spaces, so
		// `$(cat a b)` does not arrive as two targets, neither of which looks
		// like a substitution on its own.
		if (character === "`") {
			const end = segment.indexOf("`", index + 1);
			const stop = end === -1 ? segment.length : end + 1;
			current += segment.slice(index, stop);
			started = true;
			index = stop - 1;
			continue;
		}
		if (character === "$" && segment[index + 1] === "(") {
			const stop = endOfCommandSubstitution(segment, index + 1);
			current += segment.slice(index, stop);
			started = true;
			index = stop - 1;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			if (character === "'") literal = true;
			started = true;
			continue;
		}
		if (character === " " || character === "\t") {
			push();
			continue;
		}
		current += character;
		started = true;
	}
	push();
	return words;
}

/** Matches `$NAME`, `${NAME}` and `$(…)` / backtick command substitution. */
const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\(|`/;

/**
 * A variable value the guard is willing to substitute textually.
 *
 * Expansion here is plain string substitution into ONE word. The shell does
 * more than that: it word-splits and glob-expands an unquoted result. So a
 * value the guard pastes in is only faithful when neither of those can fire,
 * and a value that could fire either is refused and the word stays unknown.
 *
 * The three shapes this rejects were each a proven fail-open:
 *
 *     SPLITVAR="/ /tmp/x"   shell: rm -rf / /tmp/x   guard saw one odd path
 *     GLOBVAR="/*"          shell: every top-level entry
 *     WEIRD='$OTHER'        a second round of expansion the guard does not model
 *
 * Rejecting is free: an unknown expansion in a recursive delete is already
 * treated as critical, so the cost of refusing is one prompt and the cost of
 * accepting is the incident this module is named after.
 */
function isQuietlySubstitutable(value: string): boolean {
	return !/[\s*?[\]{}$`~\\]/.test(value);
}

/**
 * Variables the SHELL maintains, whose value at the moment the command runs is
 * not the value this process holds.
 *
 * `cd / && rm -rf $PWD` is the case that matters and it is not exotic: `cd`
 * rewrites `PWD` inside the very command being judged, so the guard read
 * `/tmp`, judged it harmless, and the shell deleted the root. `pushd` does the
 * same, and so does any earlier segment of the same line. There is no reading
 * of the process environment that can be right here, because the value does not
 * exist yet when the judgement is made.
 *
 * Refusing them costs a prompt on a delete that names `$PWD`, which is a thing
 * worth being asked about anyway: it is the one variable whose whole purpose is
 * to change under you.
 */
export const SHELL_MAINTAINED_VARIABLES: ReadonlySet<string> = new Set([
	"PWD",
	"OLDPWD",
	"IFS",
	"RANDOM",
	"SECONDS",
	"LINENO",
	"SHLVL",
	"BASH_SUBSHELL",
	"REPLY",
]);

/**
 * Any `${…}` form carrying an OPERATOR, which this module does not model.
 *
 * `${VAR:-/}`, `${VAR%%/*}`, `${VAR#x}`, `${VAR/a/b}`, `${!VAR}`, `${#VAR}`.
 * The plain-name regex below matches none of them, so before this they fell
 * through as `unknown: false` with their literal text, which does not start
 * with `/`, and `judgeDeleteTarget` waved them past: `rm -rf ${VAR:-/}` with
 * VAR unset runs `rm -rf /`. Treated as unknown, which is what every other
 * expansion the guard cannot resolve is.
 */
const OPERATOR_EXPANSION = /\$\{[^}]*[^A-Za-z0-9_}][^}]*\}|\$\{[^A-Za-z_]/;

/**
 * Expand the parts of a word whose value is knowable, and say so when a part is
 * not.
 *
 * A leading `~`, `$HOME`, and any variable set in `env` whose value is quiet
 * enough to paste (see {@link isQuietlySubstitutable}) are resolved. Everything
 * else stays unknown, and unknown means critical in a recursive delete.
 *
 * WHY READING THE ENVIRONMENT IS NOT GUESSING. The command runs in a shell
 * spawned from this process, so `$TMPDIR` in the command text and `TMPDIR` in
 * the environment that shell inherits are the same lookup with the same answer.
 * Only `HOME` was resolved before, so every other variable was unknown and
 * therefore critical, and that made ordinary commands prompt in a mode whose
 * whole promise is that it does not: `rm -rf $TMPDIR/scratch` and
 * `rm -rf ${CARGO_TARGET_DIR}/debug` both blocked. A guard that cries wolf on
 * `$TMPDIR` gets switched off before it ever sees a real one.
 *
 * `env` MUST be the environment the command will actually run with, not
 * `process.env`. The bash tool takes an `env` argument that is spread over the
 * inherited environment for the child, so judging against `process.env` let the
 * caller hand the guard one value and the shell another:
 * `bash({command:"rm -rf $LANG", env:{LANG:"/"}})` was allowed and ran
 * `rm -rf /`. Inline `VAR=value` assignments in the command text are the same
 * hole by a different route (`PWD=/ rm -rf $PWD`) and are applied by the caller
 * before this runs.
 *
 * A variable that is UNSET stays unknown, which is the case the fail-closed
 * rule was written for: `rm -rf "$dir"/*` where the script assigns `dir` itself
 * has no safe reading, because an empty `dir` starts the delete at the root. A
 * variable set to the EMPTY string expands to empty, the same substitution the
 * shell performs, and the collapsed word reaches the protected-root judgement.
 *
 * Command substitution (`$(…)`, backticks) stays unknown. Its value cannot be
 * had without running it, and running it is what the guard exists to precede.
 */
export function expandWord(
	word: { text: string; literal: boolean },
	home: string,
	env: NodeJS.ProcessEnv = process.env,
): ExpandedWord {
	if (word.literal && !word.text.includes("$") && !word.text.startsWith("~")) {
		return { text: word.text, unknown: false, emptied: false };
	}
	let text = word.text;

	const namesHome = !word.literal && (text === "~" || text.startsWith("~/") || /\$\{HOME\}|\$HOME\b/.test(text));

	// AN UNRESOLVABLE HOME MAKES THE WORD UNKNOWN, NOT EMPTY. Substituting an
	// empty string here would turn `rm -rf ~` into `rm -rf ` and the guard would
	// wave through the single most dangerous command it exists to catch, quietly
	// and while appearing to work. If we cannot say where home is, we cannot say
	// this command is safe.
	if (namesHome && home === "") {
		return { text, unknown: true, emptied: true };
	}

	if (!word.literal && (text === "~" || text.startsWith("~/"))) {
		text = home + text.slice(1);
	}

	if (!word.literal) {
		// An operator form is unmodelled, and unmodelled is unknown. Checked
		// before any substitution so a `${VAR:-/}` cannot be partly rewritten.
		if (OPERATOR_EXPANSION.test(text)) return { text, unknown: true, emptied: false };

		text = text.replace(/\$\{HOME\}|\$HOME\b/g, home);
		let emptiedByEnv = false;
		const substitute = (name: string, whole: string): string => {
			// A shell-maintained variable is never substituted: its value at the
			// moment the command runs is not the one this process holds, and
			// leaving the literal `$NAME` makes the word unknown, which is correct.
			if (SHELL_MAINTAINED_VARIABLES.has(name)) return whole;
			const value = env[name];
			if (value === undefined) return whole;
			// A value that would word-split or glob is left as the literal `$NAME`,
			// which the unknown test below then catches.
			if (!isQuietlySubstitutable(value)) return whole;
			if (value === "") emptiedByEnv = true;
			return value;
		};
		text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => substitute(name, whole));
		text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => substitute(name, whole));
		if (emptiedByEnv && !EXPANSION.test(text)) {
			// The shell would produce this exact word. An empty expansion inside a
			// path is the `rm -rf "$EMPTY"/*` shape, so hand the collapsed text to
			// the protected-root judgement rather than calling it resolved-and-safe.
			return { text, unknown: false, emptied: text === "" || text.startsWith("/") };
		}
	}

	// A `~user` form, a command substitution, or any variable we did not
	// resolve above leaves the word unknown.
	const unknown = word.literal ? false : EXPANSION.test(text) || /^~[^/]/.test(text);
	return { text, unknown, emptied: false };
}

/**
 * Where `~` and `$HOME` will actually expand to when this command runs.
 *
 * `process.env.HOME` comes FIRST, and the order matters. The command runs in a
 * shell that inherits this process's environment, so the shell's `$HOME` is the
 * environment variable, not the passwd entry. `os.homedir()` reads the passwd
 * entry and, in Bun, is resolved once at process start: assigning
 * `process.env.HOME` does not move it. Judging `rm -rf ~` against a different
 * directory than the one the shell will delete is the whole failure this guard
 * exists to prevent, so the guard asks the same question the shell will.
 *
 * A relative or empty answer is treated as no answer, which makes every
 * tilde and `$HOME` word unresolvable and therefore refused. That is the loud
 * direction: the alternative is a guard that silently stops protecting the home
 * directory on a host where the variable is unset.
 */
export function resolveGuardHome(env: NodeJS.ProcessEnv = process.env): string {
	const candidates = [env.HOME, env.USERPROFILE, safeHomedir()];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.startsWith("/")) return candidate;
	}
	return "";
}

function safeHomedir(): string {
	try {
		return os.homedir();
	} catch {
		return "";
	}
}

/**
 * Reduce a path to the form the protected-root comparison expects: no repeated
 * separators, no `.` components, `..` resolved lexically, and no trailing
 * separator except on the root itself.
 *
 * Resolving `..` lexically rather than on disk is the correct choice for a
 * guard: `rm -rf ./a/../../..` must be judged before anything runs, and the
 * shell will do exactly this lexical walk when it hands the path to `rm`.
 */
export function normalizeAbsolutePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** True when `candidate` is `ancestor` or lies beneath it. */
function isAtOrUnder(candidate: string, ancestor: string): boolean {
	if (ancestor === "/") return true;
	return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/**
 * Judge one expanded target of a recursive delete.
 *
 * Returns the reason it is refused, or `undefined` when it is fine.
 *
 * A RELATIVE path is resolved against `cwd` and then judged like any other.
 * This used to return `undefined` for anything not starting with `/`, on the
 * reasoning that the published incidents all involved absolute paths and that
 * refusing relative paths would refuse the ordinary work the agent exists to
 * do. The second half is right and the first half does not follow:
 * `rm -rf ../../../../../..` reaches the root from any depth of six or less,
 * and it was allowed. Resolving instead of refusing keeps every ordinary
 * relative delete working — `rm -rf ../build` in a monorepo lands on a sibling
 * directory, which is not protected and still runs unasked — while a relative
 * path that climbs out to `/` or to the home directory is refused for exactly
 * the reason its absolute spelling would be.
 *
 * Without a `cwd` the old behaviour stands: a relative path cannot be resolved,
 * so it cannot be judged, and refusing every one of them blind would be the
 * noise the original reasoning was avoiding.
 */
export function judgeDeleteTarget(
	target: ExpandedWord,
	home: string,
	extra: readonly string[] = [],
	cwd = "",
): string | undefined {
	if (target.emptied) {
		return "a path relative to a home directory this process cannot locate, so there is no way to tell what it names";
	}
	if (target.unknown) {
		return "an expansion whose value is not knowable from the command text, which is the shape that starts at the root when the variable is empty";
	}
	if (!target.text.startsWith("/")) {
		if (cwd === "" || !cwd.startsWith("/")) return undefined;
		return judgeDeleteTarget({ text: `${cwd}/${target.text}`, unknown: false, emptied: false }, home, extra);
	}

	const normalized = normalizeAbsolutePath(target.text);
	const normalizedHome = home === "" ? "" : normalizeAbsolutePath(home);

	// Most specific reason first, because the reason is what an operator reads
	// in the prompt. `/` is a system root AND an ancestor of the home directory,
	// and "an ancestor of the home directory (/)" is a strange way to describe
	// deleting the entire filesystem.
	for (const root of PROTECTED_ROOTS) {
		if (normalized === root) return `a protected system directory (${root})`;
	}
	if (normalizedHome !== "" && isAtOrUnder(normalizedHome, normalized)) {
		return normalized === normalizedHome
			? "the home directory itself"
			: `an ancestor of the home directory (${normalized})`;
	}
	if (normalizedHome !== "") {
		for (const secret of SECRET_HOME_DIRECTORIES) {
			const directory = `${normalizedHome}/${secret}`;
			// Both directions: deleting the directory, deleting anything that
			// contains it, and deleting a single file inside it.
			if (isAtOrUnder(directory, normalized) || isAtOrUnder(normalized, directory)) {
				return `a directory holding credentials (${directory})`;
			}
		}
		for (const child of PROTECTED_HOME_DIRECTORIES) {
			const directory = `${normalizedHome}/${child}`;
			if (isAtOrUnder(directory, normalized)) return `a protected directory (${directory})`;
		}
	}
	// The operator's own additions, judged last so a built-in reason is never
	// replaced by a vaguer one. These can only ADD: nothing above consults
	// config, so a setting cannot shrink the floor.
	for (const configured of extra) {
		const directory = expandExtraPath(configured, normalizedHome);
		if (directory === undefined) continue;
		if (isAtOrUnder(directory, normalized) || isAtOrUnder(normalized, directory)) {
			return `a path protected by tools.protectedPaths (${directory})`;
		}
	}
	return undefined;
}

/**
 * Resolve one `tools.protectedPaths` entry to an absolute path, or `undefined`
 * when it does not name one.
 *
 * A leading `~` is expanded because that is how an operator writes a path in a
 * config file. An entry that is neither absolute nor home-relative is IGNORED
 * rather than guessed at: a relative entry would have to be resolved against
 * some working directory, and silently picking one would protect a different
 * place than the operator wrote down.
 */
function expandExtraPath(entry: string, normalizedHome: string): string | undefined {
	const trimmed = entry.trim();
	if (trimmed === "") return undefined;
	if (trimmed === "~" || trimmed.startsWith("~/")) {
		if (normalizedHome === "") return undefined;
		return normalizeAbsolutePath(normalizedHome + trimmed.slice(1));
	}
	if (!trimmed.startsWith("/")) return undefined;
	return normalizeAbsolutePath(trimmed);
}

/** True when this argv is a delete that walks into directories. */
function isRecursiveDelete(argv: ExpandedWord[]): boolean {
	const command = basename(argv[0]?.text ?? "");
	if (command === "find") {
		// `-exec` on its own is not destructive: `find ~ -exec ls {} \;` is a
		// listing, and refusing it would prompt on ordinary search work. What
		// makes an `-exec` dangerous is the command it runs, so read that.
		return argv.some((word, index) => {
			if (word.text === "-delete") return true;
			if (word.text !== "-exec" && word.text !== "-execdir") return false;
			const run = argv[index + 1];
			return run !== undefined && RECURSIVE_DELETE_COMMANDS.has(basename(run.text));
		});
	}
	if (RECURSIVE_DELETE_COMMANDS.has(command)) {
		if (command !== "rm") return true;
		return argv.slice(1).some(word => isShortFlagWith(word, ["r", "R"]) || word.text === "--recursive");
	}
	if (RECURSIVE_REWRITE_COMMANDS.has(command)) {
		return argv.slice(1).some(word => isShortFlagWith(word, ["R"]) || word.text === "--recursive");
	}
	return false;
}

/** True when the word is a short-flag cluster containing one of `letters`. */
function isShortFlagWith(word: ExpandedWord, letters: string[]): boolean {
	if (!word.text.startsWith("-") || word.text.startsWith("--")) return false;
	return letters.some(letter => word.text.slice(1).includes(letter));
}

/** The last path component, so `/bin/rm` is judged as `rm`. */
function basename(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

/** True when the word is a flag rather than a target. */
function isFlag(word: ExpandedWord): boolean {
	return word.text.startsWith("-") && word.text !== "-" && word.text !== "--";
}

/**
 * Container runtimes whose `run` subcommand starts a fresh container.
 *
 * `exec` is deliberately absent, and so is `compose run`: both enter or start a
 * container whose mounts and privileges were decided somewhere this scan cannot
 * read (a running container, a compose file), so there is nothing here to
 * vouch for.
 */
export const CONTAINER_RUNTIMES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);

/**
 * The `docker run` flags that leave this host out of reach, and how many words
 * each one takes.
 *
 * A WHITELIST, NOT A BLOCKLIST. The flags that matter are the ones that hand a
 * container part of the host (`-v`, `--volume`, `--volumes-from`, `--mount`,
 * `--privileged`, `--device`, `--cap-add`, `--security-opt`, `--pid host`,
 * `--ipc host`, `--userns host`, `--cgroupns host`), and a blocklist of those
 * would exempt whichever escape nobody wrote down. Here a flag that is missing
 * costs one approval prompt, which is the direction this module is allowed to
 * be wrong in.
 */
export const CONTAINER_RUN_FLAGS: ReadonlyMap<string, "boolean" | "value"> = new Map<string, "boolean" | "value">([
	["--rm", "boolean"],
	["--detach", "boolean"],
	["--interactive", "boolean"],
	["--tty", "boolean"],
	["--init", "boolean"],
	["--read-only", "boolean"],
	["--no-healthcheck", "boolean"],
	["--publish-all", "boolean"],
	["--quiet", "boolean"],
	["--attach", "value"],
	["--add-host", "value"],
	["--cpus", "value"],
	["--cpu-shares", "value"],
	["--cpuset-cpus", "value"],
	["--dns", "value"],
	["--dns-option", "value"],
	["--dns-search", "value"],
	["--entrypoint", "value"],
	["--env", "value"],
	["--env-file", "value"],
	["--expose", "value"],
	["--health-cmd", "value"],
	["--health-interval", "value"],
	["--health-retries", "value"],
	["--health-start-period", "value"],
	["--health-timeout", "value"],
	["--hostname", "value"],
	["--label", "value"],
	["--label-file", "value"],
	["--memory", "value"],
	["--memory-swap", "value"],
	["--name", "value"],
	["--pids-limit", "value"],
	["--platform", "value"],
	["--publish", "value"],
	["--pull", "value"],
	["--restart", "value"],
	["--shm-size", "value"],
	["--stop-signal", "value"],
	["--stop-timeout", "value"],
	["--tmpfs", "value"],
	["--ulimit", "value"],
	["--user", "value"],
	["--workdir", "value"],
]);

/**
 * Short-flag letters that take no value and grant the container nothing.
 *
 * Exported with the two tables above for the same reason
 * [`INTERPRETED_SCRIPT_COMMANDS`] is: a member added to any of them widens an
 * exemption on the critical floor, and the suite reads them at run time so a
 * new member cannot land with nobody having judged it.
 */
export const CONTAINER_BOOLEAN_LETTERS: ReadonlySet<string> = new Set(["i", "t", "d", "q", "P"]);

/** Short-flag letters that take the next word: `-e`, `-p`, `-u`, `-w`, `-m`, `-h`, `-l`. */
export const CONTAINER_VALUE_LETTERS: ReadonlySet<string> = new Set(["e", "p", "u", "w", "m", "h", "l"]);

/**
 * True when a `--network` value puts the container back on a stack it did not
 * get on its own. `host` is this machine's stack; `container:NAME` is another
 * container's, decided somewhere this scan cannot read.
 */
function joinsForeignNetwork(value: string): boolean {
	return value === "host" || value.startsWith("container:");
}

/**
 * True when these words are a container run that cannot reach this host.
 *
 * WHY THIS EXEMPTION EXISTS. The critical floor is the one thing `/yolo` cannot
 * lift, and it exists to protect THIS machine. Judged as text, every ordinary
 * install test in a throwaway container hits it: the operator's
 * `docker run --rm fedora:latest sh -c 'curl -fsSL … | sh && …'` matched the
 * remote-fetch-then-execute pattern and prompted, and the scan below it reads
 * the container's own script against the host's protected roots, so
 * `docker run --rm alpine rm -rf /` was critical for a root that is the image's
 * and lives for the length of the command. Neither can touch this host, so
 * neither is a host risk, and a floor that fires on them is the floor an
 * operator turns off.
 *
 * IT STILL FAILS CLOSED. The exemption holds only while every word from the
 * runtime through the image resolves and every flag is in
 * [`CONTAINER_RUN_FLAGS`]. A volume, a mount, a device, a capability, a
 * relaxed security profile, a host namespace, an unreadable expansion standing
 * where a flag goes, `docker exec`, and `docker compose run` all fall through
 * to the ordinary judgement. Words AFTER the image are the container's own
 * command and are not read: that is the whole point.
 */
export function isHostIsolatedContainerRun(words: readonly ExpandedWord[]): boolean {
	let index = 0;
	// Step over the same wrapper words and inline assignments the segment scan
	// steps over, plus a flag belonging to one of them, so `sudo docker run …`
	// and `sudo -E docker run …` both read as a container run.
	while (index < words.length) {
		const text = words[index]!.text;
		if (!isPrefixCommand(text) && !(index > 0 && text.startsWith("-"))) break;
		index += 1;
	}
	const runtime = words[index];
	if (runtime === undefined || runtime.unknown || !CONTAINER_RUNTIMES.has(basename(runtime.text))) return false;
	index += 1;
	// `docker container run` is the long spelling of `docker run`. Anything else
	// standing here (`exec`, `compose`, `build`, or the value of a global flag
	// this scan does not read) is not a fresh container.
	if (words[index]?.text === "container") index += 1;
	if (words[index]?.text !== "run") return false;
	index += 1;
	while (index < words.length) {
		const word = words[index]!;
		// An expansion standing in flag position could be any flag at all,
		// including `-v /:/host`.
		if (word.unknown) return false;
		const text = word.text;
		if (!text.startsWith("-") || text === "-" || text === "--") break;
		index += 1;
		if (text.startsWith("--")) {
			const equals = text.indexOf("=");
			const name = equals === -1 ? text : text.slice(0, equals);
			const inlineValue = equals === -1 ? undefined : text.slice(equals + 1);
			if (name === "--network" || name === "--net") {
				const value = inlineValue ?? words[index]?.text;
				if (value === undefined || joinsForeignNetwork(value)) return false;
				if (inlineValue === undefined) index += 1;
				continue;
			}
			const arity = CONTAINER_RUN_FLAGS.get(name);
			if (arity === undefined) return false;
			if (arity === "value" && inlineValue === undefined) index += 1;
			continue;
		}
		const letters = [...text.slice(1)];
		if (letters.length === 1 && CONTAINER_VALUE_LETTERS.has(letters[0]!)) {
			index += 1;
			continue;
		}
		// `-itv /home:/h` is `-v` with company, so a cluster is safe only when
		// every letter in it is.
		if (!letters.every(letter => CONTAINER_BOOLEAN_LETTERS.has(letter))) return false;
	}
	// A run with no image is not a run this scan can vouch for.
	return words[index] !== undefined;
}

/**
 * The command line with every host-isolated container run blanked out.
 *
 * WHY IT RETURNS TEXT RATHER THAN THE SURVIVING SEGMENTS. Several
 * [`FLAGGED_BASH_PATTERNS`] span a segment break (`curl … | sh`, the fork
 * bomb, `bash <(curl …)`), so rejoining the survivors with any separator would
 * quietly retire them. An isolated run is replaced by spaces of the same
 * length instead: every other character stays where it was, and blanking can
 * only remove text, never spell a match the line did not contain.
 */
export function hostReachableCommand(
	command: string,
	home: string = resolveGuardHome(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	let result = command;
	for (const span of splitCommandSpans(command)) {
		const words = splitWords(span.text).map(word => expandWord(word, home, env));
		if (words.length === 0 || !isHostIsolatedContainerRun(words)) continue;
		result = result.slice(0, span.start) + " ".repeat(span.end - span.start) + result.slice(span.end);
	}
	return result;
}

/**
 * Find the first critical risk in a command line, or `undefined` when there is
 * none.
 *
 * `home` is taken as an argument rather than read from the environment so a
 * test can state the whole rule without depending on the machine it runs on,
 * and so a session with a different `HOME` than the process is judged against
 * the one the command will actually see.
 *
 * `env` is the environment the command will RUN with. The bash tool spreads its
 * `env` argument over the inherited environment for the child, so judging
 * against `process.env` let a caller hand the guard one value and the shell
 * another: `bash({command:"rm -rf $LANG", env:{LANG:"/"}})` was allowed and ran
 * `rm -rf /`.
 */
export function findCriticalBashRisk(
	command: string,
	home: string = resolveGuardHome(),
	extraProtectedPaths: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
	/**
	 * Directory a relative delete target resolves against: the call's own `cwd`
	 * argument when it has one, else the session's. Empty leaves relative targets
	 * unjudged, which is the old behaviour.
	 */
	cwd = "",
	/**
	 * How many `sh -c` / `eval` strings deep this scan already is. A script
	 * argument is shell text and has to be judged as shell text, so the scan
	 * re-enters itself; the bound stops a self-referential command line from
	 * spinning and is far above any real nesting.
	 */
	depth = 0,
): CriticalBashRisk | undefined {
	// Names this command line assigned from a `mktemp` substitution, carried
	// across segments as provenance with no value attached. See isMktempCreation.
	const selfCreatedTemp = new Set<string>();
	const staged: { name: string; created: boolean }[] = [];
	// VALUES an earlier segment of this same line assigned. `undefined` marks a
	// name we watched being written and cannot resolve; it MASKS any ambient value
	// the name would otherwise have read, because the shell will not read that one
	// either. See carriedValue for what makes a value resolvable.
	const carried = new Map<string, string | undefined>();
	const stagedValues = new Map<string, string | undefined>();
	for (const segment of splitCommandSegments(command)) {
		for (const entry of staged) {
			if (entry.created) selfCreatedTemp.add(entry.name);
			else selfCreatedTemp.delete(entry.name);
		}
		staged.length = 0;
		for (const [name, value] of stagedValues) carried.set(name, value);
		stagedValues.clear();
		// Inline `VAR=value` assignments bind for this segment, and the shell
		// honours them. They were skipped as prefix words and never applied, so
		// `PWD=/ rm -rf $PWD` expanded `$PWD` from the ambient environment, judged
		// a harmless directory, and ran `rm -rf /`.
		//
		// AN EARLIER SEGMENT'S ASSIGNMENT IS PART OF THE COMMAND TEXT. Applying
		// them over a copy that died with the segment made `DST=/srv/app;
		// rm -rf "$DST/build"` critical, because `$DST` read as an expansion "whose
		// value is not knowable from the command text" when the line says what it
		// is on the word before. `critical` is the floor `/yolo` cannot lift, so
		// that reading turned the most ordinary shape an agent writes into a prompt
		// in the one mode whose whole promise is that it does not prompt — and a
		// guard that fires on `DST=…; rm -rf "$DST/build"` is a guard an operator
		// switches off before it ever sees a real `rm -rf /`.
		//
		// Wrapper words are stepped over rather than stopping the scan, because
		// `env PWD=/ rm -rf $PWD` and `sudo -E FOO=/ rm -rf $FOO` set the variable
		// just as effectively as the bare form. Stopping at the first non-
		// assignment word left exactly those spellings reading the ambient value.
		// A declaration builtin is stepped over for the same reason: `export DST=/`
		// is an assignment with a word in front of it.
		const rawWords = splitWords(segment);
		let segmentEnv = env;
		const ownEnv = (): NodeJS.ProcessEnv => {
			if (segmentEnv === env) segmentEnv = { ...env };
			return segmentEnv;
		};
		for (const [name, value] of carried) {
			const target = ownEnv();
			if (value === undefined) delete target[name];
			else target[name] = value;
		}
		// The environment as this segment ENTERS it, for expanding the segment's own
		// assignment values. The shell binds prefix assignments left to right after
		// expanding the command's words, so a value must never be resolved against a
		// name the same segment is in the middle of writing.
		const enteringEnv = segmentEnv === env ? env : { ...segmentEnv };
		let commandIndex = 0;
		for (const word of rawWords) {
			const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word.text);
			if (!assignment) {
				const wrapper = isPrefixCommand(word.text) || DECLARATION_BUILTINS.has(basename(word.text));
				// A flag belonging to a wrapper already stepped over, the same way
				// `isHostIsolatedContainerRun` reads `sudo -E docker run …`. Without
				// it the scan stopped at `-E` and `sudo -E FOO=/ rm -rf $FOO` read the
				// AMBIENT `FOO`, which is the spelling the comment above claims to
				// cover and did not.
				if (wrapper || (commandIndex > 0 && word.text.startsWith("-"))) {
					commandIndex += 1;
					continue;
				}
				break;
			}
			commandIndex += 1;
			const name = assignment[1] as string;
			const value = assignment[2] ?? "";
			ownEnv()[name] = value;
			// STAGED, NOT APPLIED. The shell expands a word before a prefix
			// assignment on the same command takes effect, so
			// `TMP=$(mktemp -d) rm -rf "$TMP"` deletes whatever the AMBIENT `TMP`
			// named. Only a LATER segment may read this. A shell-maintained name
			// is never given provenance: `cd` rewrites `PWD` with no assignment
			// for this scan to see, so an exemption there could not be withdrawn.
			if (!SHELL_MAINTAINED_VARIABLES.has(name)) {
				staged.push({ name, created: isMktempCreation(value) });
				stagedValues.set(name, carriedValue(word.literal, value, home, enteringEnv, env, name));
			}
		}
		// A name written by anything this scan cannot read loses BOTH its mktemp
		// exemption and its carried value: `DST=/srv/app; read DST; rm -rf "$DST"`
		// deletes whatever was typed, not what the line said one segment ago.
		const watched = new Set<string>([...selfCreatedTemp, ...carried.keys(), ...stagedValues.keys()]);
		for (const name of reboundNames(rawWords.slice(commandIndex), watched)) {
			staged.push({ name, created: false });
			stagedValues.set(name, undefined);
		}
		const words = rawWords.map(word => expandWord(word, home, segmentEnv));
		if (words.length === 0) continue;

		// A CONTAINER THAT CANNOT REACH THIS HOST IS NOT A HOST RISK. The words
		// after the image are the container's own command, judged against the
		// container's filesystem by the kernel and against nothing here. The
		// assignment bookkeeping above still ran, so a `mktemp` provenance this
		// segment staged is carried into the next one either way. See
		// isHostIsolatedContainerRun for what disqualifies a run.
		if (isHostIsolatedContainerRun(words)) continue;

		const overwrite = findTruncatingWriteRisk(words, home);
		if (overwrite) return overwrite;

		// EVERY WORD IS A POSSIBLE COMMAND. This used to read `argv[0]` after
		// stepping over `sudo` and friends, so anything else standing where the
		// command word goes hid the whole rule rather than weakening it:
		// `for i in 1 ; do rm -rf ~ ; done` and `if true ; then rm -rf ~ ; fi`
		// were not critical, and in yolo they ran with no prompt. Naming the
		// keywords would have been a blocklist, and the next shape walks past a
		// blocklist by construction, so the classifier asks the question at every
		// position instead. A word that is not a delete command answers no, which
		// is what the old scan did once and now does n times.
		for (let position = 0; position < words.length; position += 1) {
			const interpreted = findRiskInInterpretedShell(words, position, home, extraProtectedPaths, env, cwd, depth);
			if (interpreted) return interpreted;
			const argv = words.slice(position);
			if (!isRecursiveDelete(argv)) continue;

			const commandName = basename(argv[0]!.text);
			for (let index = 1; index < argv.length; index += 1) {
				const candidate = argv[index]!;
				if (isFlag(candidate)) continue;
				if (commandName === "find" && candidate.text.startsWith("-")) continue;
				const reason = judgeDeleteTarget(candidate, home, extraProtectedPaths, cwd);
				if (reason === undefined) continue;
				// A path this command line created with `mktemp` is not one it can
				// destroy more of than it made. Judged on the RAW word, because the
				// ambient value of the name is stale the moment the assignment ran.
				if (namesSelfCreatedTemp(rawWords[position + index]!, selfCreatedTemp)) continue;
				return {
					command: commandName,
					argument: candidate.text,
					...(candidate.unknown ? {} : { target: normalizeAbsolutePath(candidate.text) }),
					reason: `${commandName} would recursively remove ${reason}`,
				};
			}
		}
	}
	return undefined;
}

/**
 * A truncating redirect into a directory that holds credentials.
 *
 * `> ~/.ssh/id_ed25519` destroys a private key exactly as thoroughly as `rm`
 * does, and it does not contain the word `rm`, so nothing above sees it. The
 * rule is deliberately narrow: only `>` (not `>>`, which appends), and only
 * into [`SECRET_HOME_DIRECTORIES`], because writing files is the ordinary work
 * an agent does all day and a broad rule here would prompt constantly. Writes
 * to the system credential files are already covered by
 * [`FLAGGED_BASH_PATTERNS`].
 */
function findTruncatingWriteRisk(words: ExpandedWord[], home: string): CriticalBashRisk | undefined {
	const normalizedHome = home === "" ? "" : normalizeAbsolutePath(home);
	if (normalizedHome === "") return undefined;

	for (const [index, word] of words.entries()) {
		// `> path`, `1> path`, `>path` and `2>path`, but never `>>`.
		const match = /^\d*>(?!>)(.*)$/.exec(word.text);
		if (!match) continue;
		// `>~/.ssh/x` needs expanding again: the tilde is not at the start of the
		// WORD, so the first pass left it alone.
		const inline = match[1] ?? "";
		const target = inline === "" ? words[index + 1] : expandWord({ text: inline, literal: false }, home);
		if (!target || target.unknown || !target.text.startsWith("/")) continue;

		const normalized = normalizeAbsolutePath(target.text);
		for (const secret of SECRET_HOME_DIRECTORIES) {
			const directory = `${normalizedHome}/${secret}`;
			if (isAtOrUnder(normalized, directory)) {
				return {
					command: "redirect",
					argument: target.text,
					target: normalized,
					reason: `a redirect would overwrite ${normalized}, inside a directory holding credentials (${directory})`,
				};
			}
		}
	}
	return undefined;
}

/**
 * Wrappers that take the real command as their tail.
 *
 * Only used to decide which leading words carry a `VAR=value` binding. Finding
 * the delete no longer depends on it: the scan asks at every word position, so
 * a wrapper this list has never heard of cannot hide anything.
 */
function isPrefixCommand(word: string): boolean {
	const name = basename(word);
	if (name === "sudo" || name === "doas" || name === "nice" || name === "ionice" || name === "env") return true;
	// `FOO=bar rm -rf /` puts an assignment where the command word would be.
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** How many `sh -c` / `eval` strings deep the scan will follow before refusing. */
export const MAX_INTERPRETED_SHELL_DEPTH = 3;

/**
 * Where a command that runs shell text keeps that text.
 *
 * `nextWord` is the `eval "…"` / `trap "…" EXIT` shape, where the script is the
 * argument straight after the command. `afterScriptFlag` is the interpreter
 * shape, where the script follows a `-c` in whatever bundle the caller spelled.
 */
export type ScriptArgumentShape = "afterScriptFlag" | "nextWord";

/**
 * Every command this guard knows hands shell text to a shell, and where each
 * one keeps that text.
 *
 * ONE REGISTRY, BECAUSE THE CLASS IS WHAT MATTERS HERE. This lookup used to be
 * two conditionals inside the scan, so the set of commands that reach a shell
 * was something you could only learn by reading the branch. Adding a shell to
 * it was therefore a silent change: nothing enumerated the members, so nothing
 * could notice a new one arriving with no decision recorded about it, and this
 * rule is only as good as its least-considered member. Exported so a test can
 * enumerate the class at run time and fail on a member it has no case for,
 * rather than pinning the three spellings somebody happened to think of.
 */
export const INTERPRETED_SCRIPT_COMMANDS: ReadonlyMap<string, ScriptArgumentShape> = new Map<
	string,
	ScriptArgumentShape
>([
	["eval", "nextWord"],
	["trap", "nextWord"],
	["bash", "afterScriptFlag"],
	["sh", "afterScriptFlag"],
	["zsh", "afterScriptFlag"],
	["dash", "afterScriptFlag"],
	["ksh", "afterScriptFlag"],
	["ash", "afterScriptFlag"],
]);

/** `-c`, and the bundled spellings an agent writes: `-lc`, `-ec`, `-euc`. */
export const SCRIPT_FLAG = /^-[a-z]*c$/;

/**
 * Commands whose presence in an unreadable script is worth refusing over.
 *
 * Exported for the same reason the registry above is: a verb added to either
 * source set joins this class silently otherwise, and a delete verb nobody
 * wrote a case for is the recurring way this rule loses a member.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
	...RECURSIVE_DELETE_COMMANDS,
	...RECURSIVE_REWRITE_COMMANDS,
	"find",
]);

/**
 * True when a script's raw text names a delete the word scan never saw.
 *
 * `eval "$(rm -rf /)"` is one word to the splitter and `$(rm` is not `rm`, so
 * the scan that reads the script as shell walks straight past the delete. A
 * crude split on the punctuation a shell separates words with finds it.
 *
 * A verb the word scan DID see is not reported. It has already been judged, by
 * the same rule that judges it at the top level, and reporting it again here
 * would make `sh -c "rm -f $LOCK"` critical while the identical bare
 * `rm -f $LOCK` is not. Being stricter about a command because of the quotes
 * around it is the asymmetry this function exists to avoid.
 */
function namesUnparsedDestructiveVerb(script: string): boolean {
	const parsed = new Set<string>();
	for (const segment of splitCommandSegments(script)) {
		for (const word of splitWords(segment)) parsed.add(basename(word.text));
	}
	for (const token of script.split(/[\s;|&()<>{}`"'$]+/)) {
		if (token === "") continue;
		const name = basename(token);
		if (DESTRUCTIVE_VERBS.has(name) && !parsed.has(name)) return true;
	}
	return false;
}

/**
 * The risk inside a shell string this command hands to an interpreter.
 *
 * `bash -c "rm -rf ~"` and `eval "rm -rf ~"` are one word to the word scan and
 * a whole command line to the shell, so the text has to be judged as what it
 * is. Both were allowed before this.
 *
 * WHY AN UNREADABLE SCRIPT IS NO LONGER CRITICAL ON ITS OWN. The first version
 * of this refused any script word carrying an expansion it could not resolve,
 * on the reasoning that an unreadable script is every command at once. The
 * reasoning was right about the text and wrong about the guard, in two ways
 * that only showed up once it shipped.
 *
 * It bought no security. This module classifies one thing, a recursive delete
 * of a protected path, and it cannot classify what it cannot see. Every other
 * way of running text the guard cannot read stays allowed: `sh ./setup.sh`,
 * `make`, `npm run clean`, and a bare `$SCRIPT` standing where the command word
 * goes. Refusing one spelling of unreadable execution while permitting the
 * obvious four does not stop anybody who wants to hide a delete; it only picks
 * out the spelling honest scripts happen to use.
 *
 * It was not a prompt. `critical` is a floor `/yolo` cannot lift and a standing
 * grant cannot apply to, so a run with no interactive surface (headless, CI,
 * `-p` with no terminal, and every subagent underneath such a root) has no
 * answer to give and the call fails outright. Fifteen ordinary shapes reached
 * that, including `sh -c "$SCRIPT"`, `bash -lc "$CMD"`, `eval "$SETUP"`, and
 * every `eval "$(direnv hook bash)"` / `eval "$(ssh-agent -s)"` line a shell
 * profile is made of. A guard that turns `eval "$(rbenv init -)"` into a hard
 * failure is not being careful, it is being wrong loudly.
 *
 * So the script is READ whether or not it resolved. The parts that resolve are
 * judged as ordinary shell text, and a part that did not resolve stays a
 * literal `$NAME` the inner scan calls unknown again, which keeps
 * `sh -c "rm -rf $DIR"` critical for the target it cannot name. Two refusals
 * remain on top of that reading:
 *
 *   - a script past the nesting bound, where the guard stops reading entirely;
 *   - an unreadable script naming a delete the word scan never reached, which
 *     is the `eval "$(rm -rf /)"` shape: the substitution is one word to the
 *     splitter, so the reading above walks past the delete inside it. See
 *     {@link namesUnparsedDestructiveVerb}.
 */
function findRiskInInterpretedShell(
	words: readonly ExpandedWord[],
	position: number,
	home: string,
	extraProtectedPaths: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	depth: number,
): CriticalBashRisk | undefined {
	const name = basename(words[position]!.text);
	const shape = INTERPRETED_SCRIPT_COMMANDS.get(name);
	if (shape === undefined) return undefined;
	let script: ExpandedWord | undefined;
	if (shape === "nextWord") {
		// `trap "rm -rf $T" EXIT` is a delete scheduled rather than a delete
		// written, and the shell runs it as shell all the same.
		script = words[position + 1];
	} else if (shape === "afterScriptFlag") {
		const flag = words.findIndex((word, index) => index > position && SCRIPT_FLAG.test(word.text));
		if (flag !== -1) script = words[flag + 1];
	} else {
		// A shape added to the union with no branch here is a compile error
		// rather than a command that quietly stops being read.
		const unhandled: never = shape;
		return unhandled;
	}
	if (script === undefined) return undefined;

	// A BOUND IS NOT A JUDGEMENT. Past it the guard stops reading, so it has
	// nothing to say about the text and says that rather than saying it is fine.
	if (depth >= MAX_INTERPRETED_SHELL_DEPTH) {
		return {
			command: name,
			argument: script.text,
			reason: `${name} would run a shell script nested deeper than this guard reads (${MAX_INTERPRETED_SHELL_DEPTH} levels)`,
		};
	}

	const inner = findCriticalBashRisk(script.text, home, extraProtectedPaths, env, cwd, depth + 1);
	if (inner) return inner;
	if (!script.unknown || !namesUnparsedDestructiveVerb(script.text)) return undefined;
	return {
		command: name,
		argument: script.text,
		reason: `${name} would run a delete this guard cannot read, so there is no telling what it removes`,
	};
}

/**
 * Absolute paths a bash command names that sit inside a credentials directory.
 *
 * WHY BASH NEEDS THIS AT ALL. The cwd and secret boundaries only look at tools
 * that declare `filesystemTargets`, and `bash` declared none, so the boundary
 * governed `read` and not `cat`. At every rung below `yolo` that produced a
 * boundary with a hole in the middle of it:
 *
 *     read  {path: "~/.ssh/id_rsa"}      asks
 *     bash  {command: "cat ~/.ssh/id_rsa"}  ran, silently
 *
 * An agent does not have to intend anything to walk through that; `cat` is
 * simply the more natural way to say it.
 *
 * DELIBERATELY NARROW. It reports only paths under {@link SECRET_HOME_DIRECTORIES},
 * not every absolute path in the command. Running the whole boundary over bash
 * would prompt on `/usr/bin/env`, `/etc/hosts` and every toolchain path a build
 * mentions, which is the false-positive noise that makes people turn approvals
 * off — the same failure mode as the guard blocking `rm -rf $TMPDIR`. Credential
 * directories are the case where the boundary earns an interruption.
 *
 * Writes into those directories are already covered (`findTruncatingWriteRisk`);
 * this is the READ half, which nothing covered.
 */
export function bashCredentialTargets(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
	if (typeof command !== "string" || command === "") return [];
	const home = resolveGuardHome(env);
	if (home === "") return [];
	const normalizedHome = normalizeAbsolutePath(home);
	const directories = SECRET_HOME_DIRECTORIES.map(secret => `${normalizedHome}/${secret}`);
	const found = new Set<string>();
	for (const segment of splitCommandSegments(command)) {
		for (const word of splitWords(segment)) {
			const expanded = expandWord(word, home, env);
			// An unknown expansion is not reported here. This surface adds a
			// PROMPT, and the destructive shapes an unknown expansion can hide are
			// already caught by `findCriticalBashRisk`, which fails closed on them.
			if (expanded.unknown || !expanded.text.startsWith("/")) continue;
			const normalized = normalizeAbsolutePath(expanded.text);
			if (directories.some(directory => isAtOrUnder(normalized, directory))) found.add(normalized);
		}
	}
	return [...found];
}
