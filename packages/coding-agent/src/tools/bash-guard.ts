import * as os from "node:os";

export type BashRiskSeverity = "destroys" | "dangerous";

export interface FlaggedBashPattern {
	readonly pattern: RegExp;
	readonly severity: BashRiskSeverity;
	readonly reason: string;
}

export const FLAGGED_BASH_PATTERNS: readonly FlaggedBashPattern[] = [
	{ pattern: /\bsudo\s+rm\b/i, severity: "destroys", reason: "Deletes files as root" },
	{ pattern: /\bchmod\s+-R\s+[0-7]+\s+\//i, severity: "destroys", reason: "Rewrites permissions from a system root" },
	{
		pattern: /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
		severity: "destroys",
		reason: "Rewrites permissions from a system root",
	},
	{ pattern: /\bchown\s+-R\s+\S+\s+\//i, severity: "destroys", reason: "Rewrites ownership from a system root" },

	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:/i, severity: "destroys", reason: "Fork bomb: takes this host down" },

	{ pattern: />\s*\/dev\/sd[a-z]/i, severity: "destroys", reason: "Writes over a raw disk device" },
	{ pattern: /\bmkfs(\.|\b)/i, severity: "destroys", reason: "Formats a filesystem" },
	{ pattern: /\bdd\s+if=.+of=\/dev\//i, severity: "destroys", reason: "Writes a raw image over a device" },
	{ pattern: /\bshred\s+\/dev\//i, severity: "destroys", reason: "Shreds a raw device" },
	{ pattern: /\bcryptsetup\b/i, severity: "destroys", reason: "Reconfigures disk encryption" },

	{
		pattern: />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
		severity: "destroys",
		reason: "Overwrites a system account file",
	},
	{
		pattern: /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
		severity: "destroys",
		reason: "Overwrites a system account file",
	},

	{
		pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},
	{
		pattern: /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},
	{
		pattern: /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
		severity: "dangerous",
		reason: "Runs a script fetched from the network",
	},

	{ pattern: /\bkill\s+-9\s+1\b/, severity: "dangerous", reason: "Kills process 1" },
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

	{
		pattern: /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
		severity: "dangerous",
		reason: "Wires a shell to a network socket",
	},
];

export function findFlaggedBashPattern(hostText: string): FlaggedBashPattern | undefined {
	if (hostText === "") return undefined;
	return FLAGGED_BASH_PATTERNS.find(entry => entry.pattern.test(hostText));
}

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

export const SECRET_HOME_DIRECTORIES = [".ssh", ".aws", ".gnupg", ".config/gcloud"] as const;

export const PROTECTED_HOME_DIRECTORIES = [
	".config",
	".kube",
	".docker",
	".veyyon",
	".claude",
	".local",
	".cache",
] as const;

const RECURSIVE_DELETE_COMMANDS = new Set(["rm", "rmdir", "shred", "srm"]);

const RECURSIVE_REWRITE_COMMANDS = new Set(["chmod", "chown", "chgrp"]);

function isMktempCreation(value: string): boolean {
	const body = /^\$\(([\s\S]*)\)$/.exec(value)?.[1] ?? /^`([\s\S]*)`$/.exec(value)?.[1];
	if (body === undefined) return false;
	if (/[;&|\n<>`]|\$\(/.test(body)) return false;
	const parts = body.trim().split(/\s+/);
	const name = parts[0];
	if (name === undefined || basename(name) !== "mktemp") return false;
	for (const arg of parts.slice(1)) {
		if (arg === "--dry-run" || arg === "-u") return false;
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("u")) return false;
	}
	return true;
}

function namesSelfCreatedTemp(raw: { text: string; literal: boolean }, created: ReadonlySet<string>): boolean {
	if (raw.literal) return false;
	const name =
		/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw.text)?.[1] ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.text)?.[1];
	return name !== undefined && created.has(name);
}

const RUNS_UNSEEN_SHELL = new Set(["eval", "source", ".", "bash", "sh", "zsh", "dash", "ksh", "ash"]);

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

export const DECLARATION_BUILTINS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "readonly", "local"]);

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

export interface ExpandedWord {
	readonly text: string;
	readonly unknown: boolean;
	readonly emptied: boolean;
	readonly unmodelled?: boolean;
}

export interface CriticalBashRisk {
	readonly command: string;
	readonly argument: string;
	readonly target?: string;
	readonly reason: string;
	readonly severity: BashRiskSeverity;
}

export interface DeleteVerdict {
	readonly reason: string;
	readonly severity: BashRiskSeverity;
}

const SEGMENT_BREAKS = new Set([";", "&", "|", "\n", "(", ")"]);

export function splitCommandSegments(line: string): string[] {
	return splitCommandSpans(line).map(span => span.text);
}

export interface CommandSpan {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

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

const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\(|`/;

function isQuietlySubstitutable(value: string): boolean {
	return !/[\s*?[\]{}$`~\\]/.test(value);
}

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

const OPERATOR_EXPANSION = /\$\{[^}]*[^A-Za-z0-9_}][^}]*\}|\$\{[^A-Za-z_]/;

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

	if (namesHome && home === "") {
		return { text, unknown: true, emptied: true };
	}

	if (!word.literal && (text === "~" || text.startsWith("~/"))) {
		text = home + text.slice(1);
	}

	if (!word.literal) {
		if (OPERATOR_EXPANSION.test(text)) return { text, unknown: true, emptied: false, unmodelled: true };

		text = text.replace(/\$\{HOME\}|\$HOME\b/g, home);
		let emptiedByEnv = false;
		let unmodelled = false;
		const substitute = (name: string, whole: string): string => {
			if (SHELL_MAINTAINED_VARIABLES.has(name)) {
				unmodelled = true;
				return whole;
			}
			const value = env[name];
			if (value === undefined) return whole;
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
			return { text, unknown: false, emptied: text === "" || text.startsWith("/") };
		}
		if (/^~[^/]/.test(text)) unmodelled = true;
		if (unmodelled && (EXPANSION.test(text) || /^~[^/]/.test(text))) {
			return { text, unknown: true, emptied: false, unmodelled: true };
		}
	}

	const unknown = word.literal ? false : EXPANSION.test(text) || /^~[^/]/.test(text);
	return { text, unknown, emptied: false };
}

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

function isAtOrUnder(candidate: string, ancestor: string): boolean {
	if (ancestor === "/") return true;
	return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

const GLOB_METACHARACTERS = /[*?[\]{}]/;

function pathBeforeFirstGlob(normalized: string): string {
	const parts = normalized.slice(1).split("/");
	const literal: string[] = [];
	for (const part of parts) {
		if (GLOB_METACHARACTERS.test(part)) break;
		literal.push(part);
	}
	return literal.length === parts.length ? normalized : `/${literal.join("/")}`;
}

const UNNAMEABLE_EXPANSION =
	"an expansion whose value is not knowable from the command text, in a form with no reading this scan can even name";

export function judgeDeleteTarget(
	target: ExpandedWord,
	home: string,
	extra: readonly string[] = [],
	cwd = "",
): DeleteVerdict | undefined {
	if (target.unknown) {
		if (target.emptied) {
			return {
				reason:
					"a path relative to a home directory this process cannot locate, so there is no way to tell what it names",
				severity: "destroys",
			};
		}
		return judgeUnsettledDeleteTarget(target.text, home, extra, cwd, target.unmodelled === true);
	}
	if (target.text === "") return undefined;
	if (!target.text.startsWith("/")) {
		if (cwd === "" || !cwd.startsWith("/")) return undefined;
		return judgeDeleteTarget({ text: `${cwd}/${target.text}`, unknown: false, emptied: false }, home, extra);
	}

	const normalized = pathBeforeFirstGlob(normalizeAbsolutePath(target.text));
	const normalizedHome = home === "" ? "" : normalizeAbsolutePath(home);

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
	for (const configured of extra) {
		const directory = expandExtraPath(configured, normalizedHome);
		if (directory === undefined) continue;
		if (isAtOrUnder(directory, normalized) || isAtOrUnder(normalized, directory)) {
			return { reason: `a path protected by tools.protectedPaths (${directory})`, severity: "destroys" };
		}
	}
	return undefined;
}

function judgeUnsettledDeleteTarget(
	text: string,
	home: string,
	extra: readonly string[],
	cwd: string,
	unmodelled: boolean,
): DeleteVerdict | undefined {
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

function instantiateExpansions(text: string, value: string): string | undefined {
	let result = "";
	let index = 0;
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

function isRecursiveDelete(argv: ExpandedWord[]): boolean {
	const command = basename(argv[0]?.text ?? "");
	if (command === "find") {
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

function isShortFlagWith(word: ExpandedWord, letters: string[]): boolean {
	if (!word.text.startsWith("-") || word.text.startsWith("--")) return false;
	return letters.some(letter => word.text.slice(1).includes(letter));
}

function basename(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

function isFlag(word: ExpandedWord): boolean {
	return word.text.startsWith("-") && word.text !== "-" && word.text !== "--";
}

export const CONTAINER_RUNTIMES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);

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

export const CONTAINER_BOOLEAN_LETTERS: ReadonlySet<string> = new Set(["i", "t", "d", "q", "P"]);

export const CONTAINER_VALUE_LETTERS: ReadonlySet<string> = new Set(["e", "p", "u", "w", "m", "h", "l"]);

function joinsForeignNetwork(value: string): boolean {
	return value === "host" || value.startsWith("container:");
}

export function isHostIsolatedContainerRun(words: readonly ExpandedWord[]): boolean {
	let index = 0;
	while (index < words.length) {
		const text = words[index]!.text;
		if (!isPrefixCommand(text) && !(index > 0 && text.startsWith("-"))) break;
		index += 1;
	}
	const runtime = words[index];
	if (runtime === undefined || runtime.unknown || !CONTAINER_RUNTIMES.has(basename(runtime.text))) return false;
	index += 1;
	if (words[index]?.text === "container") index += 1;
	if (words[index]?.text !== "run") return false;
	index += 1;
	while (index < words.length) {
		const word = words[index]!;
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
		if (!letters.every(letter => CONTAINER_BOOLEAN_LETTERS.has(letter))) return false;
	}
	return words[index] !== undefined;
}

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

export function findCriticalBashRisk(
	command: string,
	home: string = resolveGuardHome(),
	extraProtectedPaths: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
	cwd = "",
	depth = 0,
): CriticalBashRisk | undefined {
	const selfCreatedTemp = new Set<string>();
	const staged: { name: string; created: boolean }[] = [];
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
		const enteringEnv = segmentEnv === env ? env : { ...segmentEnv };
		let commandIndex = 0;
		for (const word of rawWords) {
			const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word.text);
			if (!assignment) {
				const wrapper = isPrefixCommand(word.text) || DECLARATION_BUILTINS.has(basename(word.text));
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
			if (!SHELL_MAINTAINED_VARIABLES.has(name)) {
				staged.push({ name, created: isMktempCreation(value) });
				stagedValues.set(name, carriedValue(word.literal, value, home, enteringEnv, env, name));
			}
		}
		const watched = new Set<string>(selfCreatedTemp);
		for (const k of carried.keys()) watched.add(k);
		for (const k of stagedValues.keys()) watched.add(k);
		for (const name of reboundNames(rawWords.slice(commandIndex), watched)) {
			staged.push({ name, created: false });
			stagedValues.set(name, undefined);
		}
		const words = rawWords.map(word => expandWord(word, home, segmentEnv));
		if (words.length === 0) continue;

		if (isHostIsolatedContainerRun(words)) continue;

		const overwrite = findTruncatingWriteRisk(words, home);
		if (overwrite) return overwrite;

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

function findTruncatingWriteRisk(words: ExpandedWord[], home: string): CriticalBashRisk | undefined {
	const normalizedHome = home === "" ? "" : normalizeAbsolutePath(home);
	if (normalizedHome === "") return undefined;

	for (const [index, word] of words.entries()) {
		const match = /^\d*>(?!>)(.*)$/.exec(word.text);
		if (!match) continue;
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

function isPrefixCommand(word: string): boolean {
	const name = basename(word);
	if (name === "sudo" || name === "doas" || name === "nice" || name === "ionice" || name === "env") return true;
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

export const MAX_INTERPRETED_SHELL_DEPTH = 3;

export type ScriptArgumentShape = "afterScriptFlag" | "nextWord";

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

export const SCRIPT_FLAG = /^-[a-z]*c$/;

export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
	...RECURSIVE_DELETE_COMMANDS,
	...RECURSIVE_REWRITE_COMMANDS,
	"find",
]);

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
		script = words[position + 1];
	} else if (shape === "afterScriptFlag") {
		const flag = words.findIndex((word, index) => index > position && SCRIPT_FLAG.test(word.text));
		if (flag !== -1) script = words[flag + 1];
	} else {
		const unhandled: never = shape;
		return unhandled;
	}
	if (script === undefined) return undefined;

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
			if (expanded.unknown || !expanded.text.startsWith("/")) continue;
			const normalized = normalizeAbsolutePath(expanded.text);
			if (directories.some(directory => isAtOrUnder(normalized, directory))) found.add(normalized);
		}
	}
	return Array.from(found);
}
