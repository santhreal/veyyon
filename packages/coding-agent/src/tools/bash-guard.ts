/** The one owner of "is this bash command critical". */

import * as os from "node:os";

/** Whether a flagged bash shape survives the yolo rung. */
export type BashRiskSeverity = "destroys" | "dangerous";

/** One flagged bash shape: what to match, how bad it is, and what to tell the operator. */
export interface FlaggedBashPattern {
	readonly pattern: RegExp;
	readonly severity: BashRiskSeverity;
	/** Why this call stopped, shown verbatim as the approval dialog's reason. */
	readonly reason: string;
}

/** Bash shapes flagged for approval policy. */
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

/** The first flagged shape in `hostText`, or `undefined`. */
export function findFlaggedBashPattern(hostText: string): FlaggedBashPattern | undefined {
	if (hostText === "") return undefined;
	return FLAGGED_BASH_PATTERNS.find(entry => entry.pattern.test(hostText));
}

/** Absolute paths a recursive delete may never target. */
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

/** Home directories whose ENTIRE SUBTREE is refused, down to a single file. */
export const SECRET_HOME_DIRECTORIES = [".ssh", ".aws", ".gnupg", ".config/gcloud"] as const;

/** Home directories protected AS DIRECTORIES: deleting one of these, or anything. */
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

/** A command line that creates a temporary directory and then deletes exactly. */
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

/** Withdraw the mktemp exemption from every name this segment could rebind. */
function reboundNames(words: readonly { text: string }[], watched: ReadonlySet<string>): string[] {
	if (watched.size === 0) return [];
	if (RUNS_UNSEEN_SHELL.has(basename(words[0]?.text ?? ""))) return Array.from(watched);
	const rebound: string[] = [];
	for (const word of words) {
		const bare = /^([A-Za-z_][A-Za-z0-9_]*)(?:$|=|\[)/.exec(word.text)?.[1];
		if (bare !== undefined && watched.has(bare)) rebound.push(bare);
	}
	return rebound;
}

/** Words that put an assignment behind them: `export DST=/srv`, `local d=…`. */
export const DECLARATION_BUILTINS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "readonly", "local"]);

/** The value a name carries into the REST of the command line, or `undefined`. */
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
	/** True when an expansion collapsed the word to nothing, or would have. */
	readonly emptied: boolean;
	/** True when the word is unknown because a value EXISTS and this scan refuses. */
	readonly unmodelled?: boolean;
}

/** Why a command was judged a risk, in words an operator can act on. */
export interface CriticalBashRisk {
	/** The command word that does the damage, e.g. `rm`. */
	readonly command: string;
	/** The argument that made it a risk, as written. */
	readonly argument: string;
	/** The path that argument resolves to, when it resolves to one. */
	readonly target?: string;
	/** One sentence naming the rule that fired. */
	readonly reason: string;
	/** Whether this survives the yolo rung. See {@link BashRiskSeverity}. */
	readonly severity: BashRiskSeverity;
}

/** The verdict on one delete target: why it is refused, and how badly. */
export interface DeleteVerdict {
	/** The reason, as it will read inside the sentence the caller builds. */
	readonly reason: string;
	readonly severity: BashRiskSeverity;
}

/** Characters that end one command and begin another, outside quotes. */
const SEGMENT_BREAKS = new Set([";", "&", "|", "\n", "(", ")"]);

/** Split a command line into the individual commands it runs. */
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

/** The same split, keeping where in the line each command sat. */
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

/** The index just past the `)` that closes the `(` at `open`, counting nesting so. */
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

/** Split one segment into words the way a shell would, keeping enough of the. */
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

/** A variable value the guard is willing to substitute textually. */
function isQuietlySubstitutable(value: string): boolean {
	return !/[\s*?[\]{}$`~\\]/.test(value);
}

/** Variables the SHELL maintains, whose value at the moment the command runs is. */
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

/** Any `${…}` form carrying an OPERATOR, which this module does not model. */
const OPERATOR_EXPANSION = /\$\{[^}]*[^A-Za-z0-9_}][^}]*\}|\$\{[^A-Za-z_]/;

/** Expand the parts of a word whose value is knowable, and say so when a part is. */
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

	// AN UNRESOLVABLE HOME MAKES THE WORD UNKNOWN, NOT EMPTY. Substituting an empty string here would turn `rm -rf ~` into `rm -rf ` and the guard would
	if (namesHome && home === "") {
		return { text, unknown: true, emptied: true };
	}

	if (!word.literal && (text === "~" || text.startsWith("~/"))) {
		text = home + text.slice(1);
	}

	if (!word.literal) {
		// An operator form is unmodelled, and unmodelled is unknown. Checked before any substitution so a `${VAR:-/}` cannot be partly rewritten.
		if (OPERATOR_EXPANSION.test(text)) return { text, unknown: true, emptied: false, unmodelled: true };

		text = text.replace(/\$\{HOME\}|\$HOME\b/g, home);
		let emptiedByEnv = false;
		// Set when a name was left standing even though its value is knowable, or
		// is maintained by the shell and therefore certainly exists. See
		// `ExpandedWord.unmodelled`.
		let unmodelled = false;
		const substitute = (name: string, whole: string): string => {
			// A shell-maintained variable is never substituted: its value at the moment the command runs is not the one this process holds, and
			if (SHELL_MAINTAINED_VARIABLES.has(name)) {
				unmodelled = true;
				return whole;
			}
			const value = env[name];
			// Nothing set it, so the shell will expand it to nothing. That is the
			// one case where a dangerous reading is an assumption, and the only one
			// that leaves `unmodelled` false.
			if (value === undefined) return whole;
			// A value that would word-split or glob is left as the literal `$NAME`,
			// which the unknown test below then catches. The value was READ, so
			// whatever it does next, this scan is not guessing that it exists.
			if (!isQuietlySubstitutable(value)) {
				unmodelled = true;
				return whole;
			}
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
		// A `~user` names another account's home directory: a real directory this
		// process cannot locate, which is evidence rather than an absence of it.
		if (/^~[^/]/.test(text)) unmodelled = true;
		if (unmodelled && (EXPANSION.test(text) || /^~[^/]/.test(text))) {
			return { text, unknown: true, emptied: false, unmodelled: true };
		}
	}

	// A `~user` form, a command substitution, or any variable we did not
	// resolve above leaves the word unknown.
	const unknown = word.literal ? false : EXPANSION.test(text) || /^~[^/]/.test(text);
	return { text, unknown, emptied: false };
}

/** Where `~` and `$HOME` will actually expand to when this command runs. */
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

/** Reduce a path to the form the protected-root comparison expects: no repeated. */
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

/** Glob and brace characters, which make a component name a SET of entries. */
const GLOB_METACHARACTERS = /[*?[\]{}]/;

/** The deepest ancestor of `normalized` whose every component is literal. */
function pathBeforeFirstGlob(normalized: string): string {
	const parts = normalized.slice(1).split("/");
	const literal: string[] = [];
	for (const part of parts) {
		if (GLOB_METACHARACTERS.test(part)) break;
		literal.push(part);
	}
	return literal.length === parts.length ? normalized : `/${literal.join("/")}`;
}

/** Said when a word holds an expansion there is no way to instantiate at all. */
const UNNAMEABLE_EXPANSION =
	"an expansion whose value is not knowable from the command text, in a form with no reading this scan can even name";

/** Judge one expanded target of a recursive delete. */
export function judgeDeleteTarget(
	target: ExpandedWord,
	home: string,
	extra: readonly string[] = [],
	cwd = "",
): DeleteVerdict | undefined {
	if (target.unknown) {
		// An unresolvable HOME is the one shape with no reading to instantiate:
		// the word names a directory that certainly exists and this process
		// cannot say which one, so there is nothing to judge and it fails closed.
		if (target.emptied) {
			return {
				reason:
					"a path relative to a home directory this process cannot locate, so there is no way to tell what it names",
				severity: "destroys",
			};
		}
		return judgeUnsettledDeleteTarget(target.text, home, extra, cwd, target.unmodelled === true);
	}
	// `rm -rf ""` deletes nothing, which is what an expansion resolved to the
	// empty string leaves behind. Judged before the relative branch, which would
	// otherwise resolve it against `cwd` and refuse the working directory itself.
	if (target.text === "") return undefined;
	if (!target.text.startsWith("/")) {
		if (cwd === "" || !cwd.startsWith("/")) return undefined;
		return judgeDeleteTarget({ text: `${cwd}/${target.text}`, unknown: false, emptied: false }, home, extra);
	}

	const normalized = pathBeforeFirstGlob(normalizeAbsolutePath(target.text));
	const normalizedHome = home === "" ? "" : normalizeAbsolutePath(home);

	// Most specific reason first, because the reason is what an operator reads in the prompt. `/` is a system root AND an ancestor of the home directory,
	for (const root of PROTECTED_ROOTS) {
		if (normalized === root) return { reason: `a protected system directory (${root})`, severity: "destroys" };
	}
	if (normalizedHome !== "" && isAtOrUnder(normalizedHome, normalized)) {
		return {
			reason:
				normalized === normalizedHome
					? "the home directory itself"
					: `an ancestor of the home directory (${normalized})`,
			severity: "destroys",
		};
	}
	if (normalizedHome !== "") {
		for (const secret of SECRET_HOME_DIRECTORIES) {
			const directory = `${normalizedHome}/${secret}`;
			// Both directions: deleting the directory, deleting anything that
			// contains it, and deleting a single file inside it.
			if (isAtOrUnder(directory, normalized) || isAtOrUnder(normalized, directory)) {
				return { reason: `a directory holding credentials (${directory})`, severity: "destroys" };
			}
		}
		for (const child of PROTECTED_HOME_DIRECTORIES) {
			const directory = `${normalizedHome}/${child}`;
			if (isAtOrUnder(directory, normalized)) {
				return { reason: `a protected directory (${directory})`, severity: "destroys" };
			}
		}
	}
	// The operator's own additions, judged last so a built-in reason is never
	// replaced by a vaguer one. These can only ADD: nothing above consults
	// config, so a setting cannot shrink the floor.
	for (const configured of extra) {
		const directory = expandExtraPath(configured, normalizedHome);
		if (directory === undefined) continue;
		if (isAtOrUnder(directory, normalized) || isAtOrUnder(normalized, directory)) {
			return { reason: `a path protected by tools.protectedPaths (${directory})`, severity: "destroys" };
		}
	}
	return undefined;
}

/** Judge a target holding an expansion this scan could not settle, by judging. */
function judgeUnsettledDeleteTarget(
	text: string,
	home: string,
	extra: readonly string[],
	cwd: string,
	/** True when a value EXISTS and this scan refused to model it, as opposed to. */
	unmodelled: boolean,
): DeleteVerdict | undefined {
	// Whether the word contributes any path component of its own. Emptying every expansion leaves exactly the literal text, so `"$D/.ssh"` leaves `/.ssh`
	const literalOnly = instantiateExpansions(text, "");
	const spellsOwnComponent = literalOnly !== undefined && normalizeAbsolutePath(literalOnly).replace(/^\//, "") !== "";
	const assumed: BashRiskSeverity = unmodelled || spellsOwnComponent ? "destroys" : "dangerous";

	const readings: readonly { value: string; label: string; severity: BashRiskSeverity }[] = [
		{ value: "", label: "empty", severity: "destroys" },
		{ value: "/", label: "the root", severity: assumed },
		...(home === "" ? [] : [{ value: home, label: "the home directory", severity: assumed }]),
	];

	let worst: DeleteVerdict | undefined;
	for (const reading of readings) {
		const instantiated = instantiateExpansions(text, reading.value);
		if (instantiated === undefined) return { reason: UNNAMEABLE_EXPANSION, severity: "destroys" };
		const verdict = judgeDeleteTarget({ text: instantiated, unknown: false, emptied: false }, home, extra, cwd);
		if (verdict === undefined) continue;
		const candidate: DeleteVerdict = {
			reason: `${verdict.reason} when the expansion this command line does not settle is ${reading.label}`,
			severity: reading.severity,
		};
		if (candidate.severity === "destroys") return candidate;
		worst ??= candidate;
	}
	return worst;
}

/** Replace every expansion left in `text` with `value`, or `undefined` when one. */
function instantiateExpansions(text: string, value: string): string | undefined {
	let result = "";
	let index = 0;
	// A leading `~user` names another account's home directory, which this scan
	// cannot locate. `~` and `~/…` never reach here: they were substituted when
	// home resolved and made the word `emptied` when it did not.
	if (text.startsWith("~")) {
		const cut = text.indexOf("/");
		result += value;
		index = cut === -1 ? text.length : cut;
	}
	while (index < text.length) {
		const character = text[index] as string;
		if (character === "`") {
			const end = text.indexOf("`", index + 1);
			result += value;
			index = end === -1 ? text.length : end + 1;
			continue;
		}
		if (character === "$" && text[index + 1] === "(") {
			result += value;
			index = endOfCommandSubstitution(text, index + 1);
			continue;
		}
		if (character === "$" && text[index + 1] === "{") {
			const end = text.indexOf("}", index + 2);
			result += value;
			index = end === -1 ? text.length : end + 1;
			continue;
		}
		if (character === "$") {
			const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
			if (name === null) return undefined;
			result += value;
			index += 1 + (name[0] as string).length;
			continue;
		}
		result += character;
		index += 1;
	}
	return result;
}

/** Resolve one `tools.protectedPaths` entry to an absolute path, or `undefined`. */
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

/** Container runtimes whose `run` subcommand starts a fresh container. */
export const CONTAINER_RUNTIMES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);

/** The `docker run` flags that leave this host out of reach, and how many words. */
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

/** Short-flag letters that take no value and grant the container nothing. */
export const CONTAINER_BOOLEAN_LETTERS: ReadonlySet<string> = new Set(["i", "t", "d", "q", "P"]);

/** Short-flag letters that take the next word: `-e`, `-p`, `-u`, `-w`, `-m`, `-h`, `-l`. */
export const CONTAINER_VALUE_LETTERS: ReadonlySet<string> = new Set(["e", "p", "u", "w", "m", "h", "l"]);

/** True when a `--network` value puts the container back on a stack it did not. */
function joinsForeignNetwork(value: string): boolean {
	return value === "host" || value.startsWith("container:");
}

/** True when these words are a container run that cannot reach this host. */
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

/** The command line with every host-isolated container run blanked out. */
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

/** Find the first critical risk in a command line, or `undefined` when there is. */
export function findCriticalBashRisk(
	command: string,
	home: string = resolveGuardHome(),
	extraProtectedPaths: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
	/** Directory a relative delete target resolves against: the call's own `cwd`. */
	cwd = "",
	/** How many `sh -c` / `eval` strings deep this scan already is. A script. */
	depth = 0,
): CriticalBashRisk | undefined {
	// Names this command line assigned from a `mktemp` substitution, carried
	// across segments as provenance with no value attached. See isMktempCreation.
	const selfCreatedTemp = new Set<string>();
	const staged: { name: string; created: boolean }[] = [];
	// VALUES an earlier segment of this same line assigned. `undefined` marks a name we watched being written and cannot resolve; it MASKS any ambient value
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
		// Inline `VAR=value` assignments bind for this segment, and the shell honours them. They were skipped as prefix words and never applied, so
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
		// The environment as this segment ENTERS it, for expanding the segment's own assignment values. The shell binds prefix assignments left to right after
		const enteringEnv = segmentEnv === env ? env : { ...segmentEnv };
		let commandIndex = 0;
		for (const word of rawWords) {
			const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word.text);
			if (!assignment) {
				const wrapper = isPrefixCommand(word.text) || DECLARATION_BUILTINS.has(basename(word.text));
				// A flag belonging to a wrapper already stepped over, the same way `isHostIsolatedContainerRun` reads `sudo -E docker run …`. Without
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
			// STAGED, NOT APPLIED. The shell expands a word before a prefix assignment on the same command takes effect, so
			if (!SHELL_MAINTAINED_VARIABLES.has(name)) {
				staged.push({ name, created: isMktempCreation(value) });
				stagedValues.set(name, carriedValue(word.literal, value, home, enteringEnv, env, name));
			}
		}
		// A name written by anything this scan cannot read loses BOTH its mktemp
		// exemption and its carried value: `DST=/srv/app; read DST; rm -rf "$DST"`
		// deletes whatever was typed, not what the line said one segment ago.
		const watched = new Set<string>(selfCreatedTemp);
		for (const k of carried.keys()) watched.add(k);
		for (const k of stagedValues.keys()) watched.add(k);
		for (const name of reboundNames(rawWords.slice(commandIndex), watched)) {
			staged.push({ name, created: false });
			stagedValues.set(name, undefined);
		}
		const words = rawWords.map(word => expandWord(word, home, segmentEnv));
		if (words.length === 0) continue;

		// A CONTAINER THAT CANNOT REACH THIS HOST IS NOT A HOST RISK. The words after the image are the container's own command, judged against the
		if (isHostIsolatedContainerRun(words)) continue;

		const overwrite = findTruncatingWriteRisk(words, home);
		if (overwrite) return overwrite;

		// EVERY WORD IS A POSSIBLE COMMAND. This used to read `argv[0]` after stepping over `sudo` and friends, so anything else standing where the
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
				const verdict = judgeDeleteTarget(candidate, home, extraProtectedPaths, cwd);
				if (verdict === undefined) continue;
				// A path this command line created with `mktemp` is not one it can
				// destroy more of than it made. Judged on the RAW word, because the
				// ambient value of the name is stale the moment the assignment ran.
				if (namesSelfCreatedTemp(rawWords[position + index]!, selfCreatedTemp)) continue;
				return {
					command: commandName,
					argument: candidate.text,
					...(candidate.unknown ? {} : { target: normalizeAbsolutePath(candidate.text) }),
					reason: `${commandName} would recursively remove ${verdict.reason}`,
					severity: verdict.severity,
				};
			}
		}
	}
	return undefined;
}

/** A truncating redirect into a directory that holds credentials. */
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
					severity: "destroys",
				};
			}
		}
	}
	return undefined;
}

/** Wrappers that take the real command as their tail. */
function isPrefixCommand(word: string): boolean {
	const name = basename(word);
	if (name === "sudo" || name === "doas" || name === "nice" || name === "ionice" || name === "env") return true;
	// `FOO=bar rm -rf /` puts an assignment where the command word would be.
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** How many `sh -c` / `eval` strings deep the scan will follow before refusing. */
export const MAX_INTERPRETED_SHELL_DEPTH = 3;

/** Where a command that runs shell text keeps that text. */
export type ScriptArgumentShape = "afterScriptFlag" | "nextWord";

/** Every command this guard knows hands shell text to a shell, and where each. */
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

/** Commands whose presence in an unreadable script is worth refusing over. */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
	...RECURSIVE_DELETE_COMMANDS,
	...RECURSIVE_REWRITE_COMMANDS,
	"find",
]);

/** True when a script's raw text names a delete the word scan never saw. */
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

/** The risk inside a shell string this command hands to an interpreter. */
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
			severity: "destroys",
		};
	}

	const inner = findCriticalBashRisk(script.text, home, extraProtectedPaths, env, cwd, depth + 1);
	if (inner) return inner;
	if (!script.unknown || !namesUnparsedDestructiveVerb(script.text)) return undefined;
	return {
		command: name,
		argument: script.text,
		reason: `${name} would run a delete this guard cannot read, so there is no telling what it removes`,
		severity: "destroys",
	};
}

/** Absolute paths a bash command names that sit inside a credentials directory. */
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
	return Array.from(found);
}
