/**
 * The one owner of "is this bash command critical".
 *
 * WHY THIS IS NOT A REGEX. `CRITICAL_BASH_PATTERNS` matches the command as
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
 * Bash patterns flagged as safety critical for approval policy.
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
 * legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	/\bdd\s+if=.+of=\/dev\//i, // dd to a device.
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

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
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
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
			segments.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	segments.push(current);
	return segments.map(segment => segment.trim()).filter(segment => segment !== "");
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
 * Expand the parts of a word whose value is knowable, and say so when a part is
 * not.
 *
 * Only `HOME` and a leading `~` are resolved, because those are the only
 * expansions whose value the guard can be sure of without running the shell,
 * and they are the ones the published incidents turned on. Everything else is
 * reported as unknown rather than guessed at.
 */
export function expandWord(word: { text: string; literal: boolean }, home: string): ExpandedWord {
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
		text = text.replace(/\$\{HOME\}|\$HOME\b/g, home);
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
 * Returns the reason it is refused, or `undefined` when it is fine. A relative
 * path is always fine: the damage in every incident came from a path that
 * escaped the workspace, and refusing relative paths would refuse the ordinary
 * work the agent exists to do.
 */
export function judgeDeleteTarget(
	target: ExpandedWord,
	home: string,
	extra: readonly string[] = [],
): string | undefined {
	if (target.emptied) {
		return "a path relative to a home directory this process cannot locate, so there is no way to tell what it names";
	}
	if (target.unknown) {
		return "an expansion whose value is not knowable from the command text, which is the shape that starts at the root when the variable is empty";
	}
	if (!target.text.startsWith("/")) return undefined;

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
 * Find the first critical risk in a command line, or `undefined` when there is
 * none.
 *
 * `home` is taken as an argument rather than read from the environment so a
 * test can state the whole rule without depending on the machine it runs on,
 * and so a session with a different `HOME` than the process is judged against
 * the one the command will actually see.
 */
export function findCriticalBashRisk(
	command: string,
	home: string = resolveGuardHome(),
	extraProtectedPaths: readonly string[] = [],
): CriticalBashRisk | undefined {
	for (const segment of splitCommandSegments(command)) {
		const words = splitWords(segment).map(word => expandWord(word, home));
		if (words.length === 0) continue;

		const overwrite = findTruncatingWriteRisk(words, home);
		if (overwrite) return overwrite;

		// Skip `sudo`, `env FOO=bar`, `nice` and friends so the real command is judged.
		let start = 0;
		while (start < words.length && isPrefixCommand(words[start]!.text)) start += 1;
		const argv = words.slice(start);
		if (argv.length === 0 || !isRecursiveDelete(argv)) continue;

		const commandName = basename(argv[0]!.text);
		for (const candidate of argv.slice(1)) {
			if (isFlag(candidate)) continue;
			if (commandName === "find" && candidate.text.startsWith("-")) continue;
			const reason = judgeDeleteTarget(candidate, home, extraProtectedPaths);
			if (reason === undefined) continue;
			return {
				command: commandName,
				argument: candidate.text,
				...(candidate.unknown ? {} : { target: normalizeAbsolutePath(candidate.text) }),
				reason: `${commandName} would recursively remove ${reason}`,
			};
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
 * [`CRITICAL_BASH_PATTERNS`].
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

/** Wrappers that take the real command as their tail. */
function isPrefixCommand(word: string): boolean {
	const name = basename(word);
	if (name === "sudo" || name === "doas" || name === "nice" || name === "ionice" || name === "env") return true;
	// `FOO=bar rm -rf /` puts an assignment where the command word would be.
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}
