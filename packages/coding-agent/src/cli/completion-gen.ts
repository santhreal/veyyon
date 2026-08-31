/**
 * Shell-completion generation (bash, zsh, fish, powershell).
 *
 * Single source of truth: the declarative `flags`/`args` descriptors carried by
 * each `Command` subclass plus the registered subcommand table. {@link buildSpec}
 * walks that metadata — the same data `renderCommandBody` renders for `--help` —
 * and {@link generateCompletion} emits a self-contained completion script. Adding
 * a flag to a command's static `flags` therefore propagates into completions with
 * no edits here.
 *
 * Static candidates (enum `options`, the builtin tool list) are baked into the
 * script. A small set of flags resolve dynamic candidates (the live model
 * catalog and on-disk sessions) by calling back into `<bin> __complete <kind>`
 * — see `commands/complete.ts`. The flag→source mapping below is the only manual
 * knob and is keyed by flag name so it stays stable as flags are added.
 */
import { APP_ALIAS, collapseWhitespace } from "@veyyon/utils";
import type { ArgDescriptor, CliConfig, CommandCtor, FlagDescriptor } from "@veyyon/utils/cli";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";

export type Shell = "bash" | "zsh" | "fish" | "powershell";

/** How a flag/positional value should be completed. */
export type ValueSource =
	| { kind: "flag" } // boolean — takes no value
	| { kind: "value" } // takes a value with no completable candidates (e.g. integer, free text)
	| { kind: "enum"; values: readonly string[] } // static single value
	| { kind: "list"; values: readonly string[] } // static comma-separated list
	| { kind: "models"; multiple: boolean } // dynamic: live model catalog
	| { kind: "sessions" } // dynamic: on-disk sessions
	| { kind: "settings" } // dynamic: setting keys from SETTINGS_SCHEMA
	// dynamic: the values the setting named by the PRECEDING word accepts. Every
	// shell here can name that word cheaply, which is why this needs no per-shell
	// bookkeeping.
	| { kind: "setting-values" }
	| { kind: "file" }
	| { kind: "dir" }
	// A positional that is free text EXCEPT when it starts with `@`, which names
	// a file to attach. Only the `@…` form has candidates.
	| { kind: "at-file" };

export interface CompletionFlag {
	/** Long name without the leading `--`. */
	name: string;
	/** Short character without the leading `-`. */
	char?: string;
	description: string;
	value: ValueSource;
	/** Flag may appear multiple times (oclif `multiple`). */
	repeatable: boolean;
}

export interface CompletionArg {
	name: string;
	description: string;
	value: ValueSource;
}

export interface CompletionCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	flags: CompletionFlag[];
	args: CompletionArg[];
}

export interface CompletionSpec {
	bin: string;
	/**
	 * Other command names the same completions must serve: the short launch alias
	 * the installers link next to the binary (`vey`). Users are told to launch
	 * with the alias, so completions that bound only to `bin` left the documented
	 * entry point with no tab completion at all.
	 */
	binAliases: readonly string[];
	/** Flags/args of the default (no-subcommand) command. */
	root: { flags: CompletionFlag[]; args: CompletionArg[] };
	commands: CompletionCommand[];
}

/** Every command name the generated completions must bind to, `bin` first. */
export function binNames(spec: CompletionSpec): string[] {
	return [spec.bin, ...spec.binAliases.filter(a => a && a !== spec.bin)];
}

// --- Flag/arg value classification (the single manual mapping) ----------------

/** Single-value flags resolved against the live model catalog. */
const MODEL_FLAGS: Record<string, true> = {
	model: true,
	smol: true,
	slow: true,
	plan: true,
	// Both name the model a phase hands off to; their descriptions say so.
	"prewalk-into": true,
	"plan-yolo-into": true,
};
/** Single-value flags resolved against on-disk sessions. */
const SESSION_FLAGS: Record<string, true> = { resume: true, fork: true, session: true };
/** Flags whose value is a directory path. */
const DIR_FLAGS: Record<string, true> = {
	"session-dir": true,
	"plugin-dir": true,
	"agent-dir": true,
	cwd: true,
	dir: true,
};
/** Flags whose value is a file path. */
const FILE_FLAGS: Record<string, true> = {
	"append-system-prompt": true,
	config: true,
	export: true,
	extension: true,
	file: true,
	hook: true,
	key: true,
	out: true,
	path: true,
	rule: true,
};

/**
 * The fallback is "no candidates", not "a file".
 *
 * Falling back to file completion made every unclassified value offer the
 * current directory: `--api-key <TAB>`, `--provider <TAB>`, `ssh --host <TAB>`
 * and `search <query> <TAB>` all listed the user's files, and accepting one
 * wrote a filename where a secret, a provider id, a hostname or a search term
 * belonged. Offering nothing is the honest answer for a value only the user
 * knows; a path-valued flag earns its completion by being named above.
 *
 * Flags are keyed by bare name because a flag spelled the same way means the
 * same thing wherever it appears (`--out` is a path under both `gallery` and
 * `say`). Positional names are not that stable, so those are qualified by
 * command below.
 */
function flagValue(name: string, desc: FlagDescriptor): ValueSource {
	if (desc.kind === "boolean") return { kind: "flag" };
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (MODEL_FLAGS[name]) return { kind: "models", multiple: false };
	if (name === "models") return { kind: "models", multiple: true };
	if (SESSION_FLAGS[name]) return { kind: "sessions" };
	if (name === "tools") return { kind: "list", values: BUILTIN_TOOL_NAMES };
	if (DIR_FLAGS[name]) return { kind: "dir" };
	if (FILE_FLAGS[name]) return { kind: "file" };
	return { kind: "value" };
}

/** Positionals whose value is a path, keyed `<command>.<arg>`. */
export const FILE_ARGS: Record<string, true> = {
	"auth-broker.source": true,
	"grep.path": true,
	"install.targets": true,
	"plugin.targets": true,
	"read.path": true,
	"ttsr.snippet": true,
};
/**
 * Positionals that are free text until they start with `@`, which attaches a
 * file. `veyyon @src/main.ts explain this` is a documented way to launch, and
 * the `@…` half is a path the shell can complete.
 */
export const AT_FILE_ARGS: Record<string, true> = { "launch.messages": true };
/**
 * Positionals resolved against the live model catalog, keyed `<command>.<arg>`.
 *
 * The key is the REGISTERED command name, which is not always the word the command file is called after:
 * the throughput benchmark registers as `bench/throughput`, and while this table said `bench` it matched
 * nothing, so `veyyon bench/throughput <TAB>` offered no models at all. A stale key here fails silently,
 * which is why `completion-arg-tables-name-real-commands.test.ts` checks every key against the real
 * command list.
 */
export const MODEL_ARGS: Record<string, true> = {
	"bench/throughput.models": true,
	"dry-balance.model": true,
	"tiny-models.model": true,
};

/** Positionals resolved against the settings schema, keyed `<command>.<arg>`. */
export const SETTING_ARGS: Record<string, ValueSource> = {
	"config.key": { kind: "settings" },
	"config.value": { kind: "setting-values" },
};

function argValue(command: string, name: string, desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	const key = `${command}.${name}`;
	if (SETTING_ARGS[key]) return SETTING_ARGS[key];
	// A repeatable model positional completes as a list, the same way the `models` FLAG does: the throughput
	// benchmark takes several selectors, and pinning `multiple: false` would stop offering candidates after
	// the first one.
	if (MODEL_ARGS[key]) return { kind: "models", multiple: Boolean(desc.multiple) };
	if (FILE_ARGS[key]) return { kind: "file" };
	if (AT_FILE_ARGS[key]) return { kind: "at-file" };
	return { kind: "value" };
}

function buildFlags(Cmd: CommandCtor): CompletionFlag[] {
	const out: CompletionFlag[] = [];
	const flags = Cmd.flags ?? {};
	for (const name in flags) {
		const desc = flags[name];
		out.push({
			name,
			char: desc.char,
			description: desc.description ?? "",
			value: flagValue(name, desc),
			repeatable: Boolean(desc.multiple),
		});
		// An alias gets its OWN completion entry, unlike in `--help` where it
		// shares the canonical line. A completion list is the set of tokens you can
		// type, not a description of behaviours, so leaving `--yolo` out would make
		// an accepted, documented flag the one thing tab completion denies. The
		// short char stays on the canonical entry: it belongs to one spelling.
		for (const alias of desc.aliases ?? []) {
			out.push({
				name: alias,
				description: desc.description ?? "",
				value: flagValue(alias, desc),
				repeatable: Boolean(desc.multiple),
			});
		}
	}
	return out;
}

function buildArgs(command: string, Cmd: CommandCtor): CompletionArg[] {
	const out: CompletionArg[] = [];
	const args = Cmd.args ?? {};
	for (const name in args) {
		const desc = args[name];
		out.push({ name, description: desc.description ?? "", value: argValue(command, name, desc) });
	}
	return out;
}

/**
 * Build a {@link CompletionSpec} from loaded command classes.
 *
 * @param rootName  Entry name of the default command (its flags become top-level
 *                  flags; it is excluded from the subcommand list).
 * @param aliasMap  Canonical-name → aliases (merged from the registration table
 *                  and the command class's static `aliases`).
 * @param options   `includeLaunchAlias: false` omits the `vey` launch alias, for
 *                  an install where that name belongs to something else.
 */
export function buildSpec(
	config: CliConfig,
	rootName: string,
	aliasMap: Map<string, readonly string[]>,
	options: { includeLaunchAlias?: boolean } = {},
): CompletionSpec {
	const commands: CompletionCommand[] = [];
	let root: CompletionSpec["root"] = { flags: [], args: [] };
	for (const [name, Cmd] of config.commands) {
		const flags = buildFlags(Cmd);
		const args = buildArgs(name, Cmd);
		if (name === rootName) {
			root = { flags, args };
			continue;
		}
		if (Cmd.hidden) continue;
		commands.push({
			name,
			aliases: aliasMap.get(name) ?? [],
			description: Cmd.description ?? "",
			flags,
			args,
		});
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));
	// The launch alias is bound by every generated script, so a user who already
	// owns a `vey` command would have OUR subcommands completing THEIR tool. The
	// installers decline to create an alias they do not own; this is how they
	// decline to complete it too.
	const binAliases = options.includeLaunchAlias === false ? [] : [APP_ALIAS];
	return { bin: config.bin, binAliases, root, commands };
}

// --- Shared helpers -----------------------------------------------------------

/** Every value source except a bare boolean flag consumes the following token. */
function takesValue(v: ValueSource): boolean {
	return v.kind !== "flag";
}

/** All token forms (`name` + aliases) under which a subcommand can be invoked. */
function commandTokens(c: CompletionCommand): string[] {
	return [c.name, ...c.aliases];
}

export function generateCompletion(shell: Shell, spec: CompletionSpec): string {
	switch (shell) {
		case "bash":
			return generateBash(spec);
		case "zsh":
			return generateZsh(spec);
		case "fish":
			return generateFish(spec);
		case "powershell":
			return generatePowerShell(spec);
	}
}

// --- bash ---------------------------------------------------------------------

/** Escape for use inside a bash double-quoted `compgen -W "…"` word list. */
function bashWords(values: readonly string[]): string {
	return values.join(" ").replace(/"/g, '\\"');
}

/** bash snippet that fills COMPREPLY for a flag value, then `return 0`. */
function bashValueBranch(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
		case "value":
			return "return 0";
		case "enum":
			return `COMPREPLY=( $(compgen -W "${bashWords(v.values)}" -- "$cur") ); return 0`;
		case "list":
			return `_veyyon_comma "${bashWords(v.values)}"; return 0`;
		// Dynamic candidates are filtered by the binary, which already knows what
		// the word means: a model id matches on any fragment, a setting key on its
		// leading path. Passing `$cur` to compgen as well re-filtered them by
		// PREFIX and threw the difference away — `--model opus<TAB>` dropped every
		// `anthropic/claude-opus-…` the helper had just returned.
		case "models":
			return v.multiple
				? `_veyyon_comma "$(command ${bin} __complete models 2>/dev/null | cut -f1)"; return 0`
				: `COMPREPLY=( $(compgen -W "$(command ${bin} __complete models -- "$cur" 2>/dev/null | cut -f1)") ); return 0`;
		case "sessions":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete sessions -- "$cur" 2>/dev/null | cut -f1)") ); return 0`;
		case "settings":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete settings -- "$cur" 2>/dev/null | cut -f1)") ); return 0`;
		case "setting-values":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete setting-values "$prev" -- "$cur" 2>/dev/null | cut -f1)") ); return 0`;
		case "file":
			return `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0`;
		case "dir":
			return `COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0`;
		case "at-file":
			return "_veyyon_at_file; return 0";
	}
}

/** Build the `case "$prev" in …` arms for every value-taking flag in scope. */
function bashFlagCase(bin: string, flags: CompletionFlag[]): string {
	const lines: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		const labels = [`--${f.name}`, ...(f.char ? [`-${f.char}`] : [])];
		lines.push(`\t\t${labels.join("|")})\n\t\t\t${bashValueBranch(bin, f.value)}\n\t\t\t;;`);
	}
	return lines.join("\n");
}

/** `case` labels for every root flag that consumes the following token. */
/**
 * Every spelling of a flag that consumes the token after it.
 *
 * The token following one of these is that flag's VALUE, never a subcommand.
 * bash and fish both walk the command line looking for the subcommand and both
 * got this wrong; they share this list so the two can never disagree about
 * which flags take a value.
 */
function valueFlagLabels(flags: CompletionFlag[]): string[] {
	const labels: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		labels.push(`--${f.name}`);
		if (f.char) labels.push(`-${f.char}`);
	}
	return labels;
}

function bashFlagWords(flags: CompletionFlag[]): string {
	const words: string[] = [];
	for (const f of flags) {
		words.push(`--${f.name}`);
		if (f.char) words.push(`-${f.char}`);
	}
	return words.join(" ");
}

function generateBash(spec: CompletionSpec): string {
	const { bin } = spec;
	const parts: string[] = [];
	parts.push(`# bash completion for ${bin} — generated by \`${bin} completions bash\``);
	parts.push("");

	// Comma-aware static/dynamic list completion helper.
	// Completes the LAST element of a comma-separated value, carrying the ones
	// already chosen through the candidate (a candidate replaces the whole word)
	// and never offering one of them a second time. zsh gets that exclusion from
	// `_values -s ,` for free; bash, fish and PowerShell each do it by hand.
	parts.push(`_veyyon_comma() {
	local words="$1" realcur prefix
	realcur="\${cur##*,}"
	prefix="\${cur%"$realcur"}"
	local -a chosen remaining=()
	IFS=',' read -r -a chosen <<< "\${prefix%,}"
	local w c seen
	for w in $words; do
		seen=0
		for c in "\${chosen[@]}"; do [[ "$c" == "$w" ]] && seen=1; done
		(( seen )) || remaining+=( "$w" )
	done
	local -a matches
	matches=( $(compgen -W "\${remaining[*]}" -- "$realcur") )
	local i
	for (( i=0; i < \${#matches[@]}; i++ )); do matches[i]="$prefix\${matches[i]}"; done
	COMPREPLY=( "\${matches[@]}" )
	compopt -o nospace 2>/dev/null
}`);
	parts.push("");

	// Root handler: top-level flags + subcommand names, plus the `@file` form of
	// the root positional. `@` is not a path yet, so the candidates have to carry
	// it back or bash filters every one of them out against the typed word.
	const subTokens = spec.commands.flatMap(commandTokens).sort();
	const rootAtFile = spec.root.args.some(a => a.value.kind === "at-file");
	if (rootAtFile) {
		parts.push(`_veyyon_at_file() {
	local realcur="\${cur#@}"
	local -a matches
	matches=( $(compgen -f -- "$realcur") )
	local i
	for (( i=0; i < \${#matches[@]}; i++ )); do matches[i]="@\${matches[i]}"; done
	COMPREPLY=( "\${matches[@]}" )
	compopt -o filenames 2>/dev/null
}`);
		parts.push("");
	}
	const atFileBranch = rootAtFile ? '\tif [[ "$cur" == @* ]]; then\n\t\t_veyyon_at_file\n\t\treturn 0\n\tfi\n' : "";
	parts.push(`_veyyon_root() {
	case "$prev" in
${bashFlagCase(bin, spec.root.flags)}
	esac
${atFileBranch}	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(spec.root.flags)}" -- "$cur") )
	else
		COMPREPLY=( $(compgen -W "${bashWords(subTokens)} ${bashFlagWords(spec.root.flags)}" -- "$cur") )
	fi
}`);
	parts.push("");

	// Per-subcommand handlers.
	//
	// Positionals are answered BY POSITION. Offering every positional's
	// candidates at every slot meant `veyyon config set <TAB>` proposed the
	// action words again — `list get set reset` where a setting key belongs — and
	// kept proposing them however many arguments the user had already typed. bash
	// is the one supported shell that can count the words before the cursor, so
	// it is the one shell that gets this right; zsh delegates the same job to
	// _arguments.
	for (const c of spec.commands) {
		const cmdValueFlags = valueFlagLabels(c.flags).join("|");
		const skipArm = cmdValueFlags ? `\t\t\t${cmdValueFlags})\n\t\t\t\tskipv=1\n\t\t\t\t;;` : "";
		const argArms = c.args
			.map((a, idx) => `\t\t\t${idx})\n\t\t\t\t${bashValueBranch(bin, a.value)}\n\t\t\t\t;;`)
			.join("\n");
		parts.push(`_veyyon_cmd_${bashFn(c.name)}() {
	case "$prev" in
${bashFlagCase(bin, c.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(c.flags)}" -- "$cur") )
		return 0
	fi
	local argi=0 j skipv=0
	for (( j=cmdidx+1; j < COMP_CWORD; j++ )); do
		if (( skipv )); then skipv=0; continue; fi
		case "\${COMP_WORDS[j]}" in
${skipArm}
			-*) ;;
			*) argi=$(( argi + 1 )) ;;
		esac
	done
	case $argi in
${argArms}
	esac
}`);
		parts.push("");
	}

	// Dispatcher.
	//
	// The token AFTER a value-taking flag is that flag's value, not a
	// subcommand. Without this the loop below read `veyyon --model commit <TAB>`
	// as being inside the `commit` subcommand and offered its flags — while the
	// user was naming a model — so the root completions vanished and the
	// subcommand's produced nothing. Only root flags can appear before a
	// subcommand, so those are the only labels needed here.
	const rootValueFlags = valueFlagLabels(spec.root.flags).join("|");
	const valueFlagArm = rootValueFlags ? `\t\t\t${rootValueFlags})\n\t\t\t\tskip=1\n\t\t\t\t;;` : "";
	const dispatch: string[] = [];
	for (const c of spec.commands) {
		dispatch.push(`\t\t${commandTokens(c).join("|")})\n\t\t\t_veyyon_cmd_${bashFn(c.name)}\n\t\t\t;;`);
	}
	parts.push(`_veyyon() {
	local cur prev cmd i skip cmdidx
	cur="\${COMP_WORDS[COMP_CWORD]}"
	prev="\${COMP_WORDS[COMP_CWORD-1]}"
	cmd=""
	cmdidx=0
	skip=0
	for (( i=1; i < COMP_CWORD; i++ )); do
		if (( skip )); then skip=0; continue; fi
		case "\${COMP_WORDS[i]}" in
${valueFlagArm}
			-*) ;;
			*) cmd="\${COMP_WORDS[i]}"; cmdidx=$i; break ;;
		esac
	done
	case "$cmd" in
${dispatch.join("\n")}
		*) _veyyon_root ;;
	esac
}
complete -F _veyyon ${binNames(spec).join(" ")}`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

function bashFn(name: string): string {
	return name.replace(/[^A-Za-z0-9]/g, "_");
}

// --- zsh ----------------------------------------------------------------------

/** Sanitize a description for embedding in a single-quoted zsh `_arguments` spec. */
function zshDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[\r\n]+/g, " ")
		.replace(/:/g, " ")
		.trim();
}

/**
 * The zsh completer for a value: the part after the last colon of an
 * `_arguments` spec. One owner, because flags and positionals want the same
 * answer and had two mappings that disagreed — the positional one classified
 * everything it did not recognize as `_files`, so `config set <TAB>` listed the
 * current directory where a setting key belongs.
 */
function zshCompleter(v: ValueSource): string {
	switch (v.kind) {
		case "flag":
		case "value":
			return "";
		case "enum":
			return `(${v.values.join(" ")})`;
		case "list":
			return "_veyyon_tools";
		case "models":
			return v.multiple ? "_veyyon_models_list" : "_veyyon_call models";
		case "sessions":
			return "_veyyon_call sessions";
		case "settings":
			return "_veyyon_call settings";
		case "setting-values":
			return "_veyyon_setting_values";
		case "file":
			return "_files";
		case "dir":
			return "_files -/";
		case "at-file":
			return "_veyyon_at_file";
	}
}

/**
 * The word zsh shows above a group of candidates. Purely cosmetic, but it is
 * what tells a user whether the list they are looking at is models or files.
 */
function zshTag(v: ValueSource): string {
	switch (v.kind) {
		case "models":
			return v.multiple ? "models" : "model";
		case "sessions":
			return "session";
		case "settings":
			return "setting";
		case "file":
			return "file";
		case "dir":
			return "dir";
		case "at-file":
			return "file";
		default:
			return "value";
	}
}

function zshAction(v: ValueSource): string {
	if (v.kind === "flag") return "";
	return `:${zshTag(v)}:${zshCompleter(v)}`;
}

function zshFlagSpec(f: CompletionFlag): string {
	const body = `[${zshDesc(f.description)}]${zshAction(f.value)}`;
	if (f.char && f.repeatable) return `'*'{-${f.char},--${f.name}}'${body}'`;
	if (f.char) return `'(-${f.char} --${f.name})'{-${f.char},--${f.name}}'${body}'`;
	if (f.repeatable) return `'*--${f.name}${body}'`;
	return `'--${f.name}${body}'`;
}

function zshArgSpec(f: CompletionArg): string {
	return `':${f.name}:${zshCompleter(f.value)}'`;
}

function generateZsh(spec: CompletionSpec): string {
	const { bin } = spec;
	// The `:value:_veyyon_tools` action references this helper; bake its candidates
	// from the spec's `list` flag so the generator stays a pure function of its
	// input (bash/fish read `v.values` inline for the same reason).
	const listFlag = [...spec.root.flags, ...spec.commands.flatMap(c => c.flags)].find(f => f.value.kind === "list");
	const toolNames = listFlag?.value.kind === "list" ? listFlag.value.values.join(" ") : "";
	const parts: string[] = [];
	// Listing every name on `#compdef` is what makes one autoloaded `_veyyon` file
	// serve the alias too: compinit binds the file to each name it declares.
	parts.push(`#compdef ${binNames(spec).join(" ")}`);
	parts.push(`# zsh completion for ${bin} — generated by \`${bin} completions zsh\``);
	parts.push("");

	// Dynamic helpers (single source: `<bin> __complete <kind>` → value<TAB>desc).
	parts.push(`_veyyon_call() {
	local kind=$1
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete $kind -- "$PREFIX" 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line//$'\\t'/:}" )
	done
	_describe -t "$kind" "$kind" items
}
_veyyon_models_list() {
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete models 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line%%$'\\t'*}" )
	done
	_values -s , 'models' $items
}
_veyyon_tools() { _values -s , 'tools' ${toolNames} }${
		spec.root.args.some(a => a.value.kind === "at-file")
			? `
# \`@\` attaches a file. _files is given the path without it, and compset moves
# the prefix out of the way so the candidates it produces still complete.
_veyyon_at_file() {
	if [[ $PREFIX == @* ]]; then
		compset -P '@'
		_files
	fi
}
# The first word is a subcommand unless it starts with \`@\`, which is a file to
# attach and not a command name.
_veyyon_first_word() {
	if [[ $PREFIX == @* ]]; then
		_veyyon_at_file
	else
		_veyyon_commands
	fi
}`
			: ""
	}
# The setting whose values to offer is the word before the cursor, which is the
# key the user just typed (\`config set startup.autoUpdate <TAB>\`).
_veyyon_setting_values() {
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete setting-values "\${words[CURRENT-1]}" -- "$PREFIX" 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line//$'\\t'/:}" )
	done
	_describe -t values 'value' items
}`);
	parts.push("");

	// Subcommand description table.
	const cmdRows = spec.commands.map(c => `\t\t'${c.name}:${zshDesc(c.description)}'`).join("\n");
	parts.push(`_veyyon_commands() {
	local -a commands
	commands=(
${cmdRows}
	)
	_describe -t commands 'command' commands
}`);
	parts.push("");

	// Per-subcommand argument functions.
	for (const c of spec.commands) {
		const specs = ["'(-h --help)'{-h,--help}'[Show help]'", ...c.flags.map(zshFlagSpec), ...c.args.map(zshArgSpec)];
		parts.push(`_veyyon_cmd_${bashFn(c.name)}() {
	_arguments -s \\
		${specs.join(" \\\n\t\t")}
}`);
		parts.push("");
	}

	// Top-level dispatch.
	const aliasArms = spec.commands
		.map(c => `\t\t\t${commandTokens(c).join("|")}) _veyyon_cmd_${bashFn(c.name)} ;;`)
		.join("\n");
	const rootSpecs = [
		"'(-h --help)'{-h,--help}'[Show help]'",
		"'(-v --version)'{-v,--version}'[Show version]'",
		...spec.root.flags.map(zshFlagSpec),
		spec.root.args.some(a => a.value.kind === "at-file") ? "'1: :_veyyon_first_word'" : "'1: :_veyyon_commands'",
		"'*::arg:->args'",
	];
	parts.push(`_veyyon() {
	local curcontext="$curcontext" state line
	typeset -A opt_args
	_arguments -C -s \\
		${rootSpecs.join(" \\\n\t\t")}
	case $state in
		args)
			case $line[1] in
${aliasArms}
			esac
			;;
	esac
}
# Works both ways: autoloaded from $fpath (file named _veyyon) or eval'd from a
# startup file. When autoloaded, funcstack[1] is _veyyon and we invoke it; when
# sourced/eval'd we register it with compdef instead.
if [ "$funcstack[1]" = "_veyyon" ]; then
	_veyyon "$@"
else
	compdef _veyyon ${binNames(spec).join(" ")}
fi`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

// --- fish ---------------------------------------------------------------------

function fishDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/**
 * Whether a value has candidates to offer.
 *
 * Only meaningful for POSITIONALS. On a flag, the bare `-x` fishValue returns
 * for a candidate-less value is the useful statement "this flag takes a value,
 * do not offer files for it". On a positional there is no flag to attach it to,
 * so the same `-x` becomes an unconditional rule that suppresses file
 * completion for the whole subcommand: emitting it for `grep <pattern>` would
 * cancel the file completion `grep <path>` asks for on the very next line.
 */
function fishValueHasCandidates(v: ValueSource): boolean {
	return v.kind !== "flag" && v.kind !== "value";
}

function fishValue(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return "-x";
		case "enum":
			return `-x -a '${v.values.join(" ")}'`;
		case "list":
			// A comma-separated value completes only its LAST element. Offering
			// the bare values replaced the whole token, so `--tools read,ba<Tab>`
			// produced `--tools bash` and silently dropped `read`. bash and zsh
			// already had their own comma helpers; fish was completing a list flag
			// as if it took one value.
			return `-x -a '(__veyyon_comma_candidates ${v.values.join(" ")})'`;
		case "models":
			return `-x -a '(command ${bin} __complete models -- (commandline -ct))'`;
		case "sessions":
			return `-x -a '(command ${bin} __complete sessions -- (commandline -ct))'`;
		case "settings":
			return `-x -a '(command ${bin} __complete settings -- (commandline -ct))'`;
		case "setting-values":
			return `-x -a '(command ${bin} __complete setting-values (__veyyon_prev_word) -- (commandline -ct))'`;
		case "at-file":
			return `-x -a '(__veyyon_at_file_candidates)'`;
		case "file":
			return "-r -F";
		case "dir":
			return "-x -a '(__fish_complete_directories (commandline -ct))'";
	}
}

function fishFlagLine(bin: string, cond: string, f: CompletionFlag): string {
	const segs = [`complete -c ${bin}`, `-n '${cond}'`];
	if (f.char) segs.push(`-s ${f.char}`);
	segs.push(`-l ${f.name}`);
	if (f.description) segs.push(`-d '${fishDesc(f.description)}'`);
	const val = fishValue(bin, f.value);
	if (val) segs.push(val);
	return segs.join(" ");
}

function generateFish(spec: CompletionSpec): string {
	const { bin } = spec;
	const lines: string[] = [];
	lines.push(`# fish completion for ${bin} — generated by \`${bin} completions fish\``);
	lines.push("");

	// Completes the last element of a comma-separated value, carrying the
	// elements already chosen through and never offering one of them twice.
	// `commandline -ct` is the token under the cursor, which is what a candidate
	// replaces.
	lines.push(`function __veyyon_comma_candidates`);
	lines.push(`\tset -l cur (commandline -ct)`);
	lines.push(`\tset -l prefix (string replace -r '[^,]*$' '' -- $cur)`);
	lines.push(`\tset -l chosen (string split -- ',' $prefix)`);
	lines.push(`\tfor v in $argv`);
	lines.push(`\t\tif not contains -- $v $chosen`);
	lines.push(`\t\t\techo $prefix$v`);
	lines.push(`\t\tend`);
	lines.push(`\tend`);
	lines.push(`end`);
	lines.push("");

	// The subcommand actually in play, echoed as its canonical name, or nothing
	// when the line is still at the root.
	//
	// fish ships __fish_seen_subcommand_from, but it matches any earlier token
	// against a name list, so `veyyon --model commit` reads as the `commit`
	// subcommand while the user is naming a model: root completions vanish and
	// commit's appear in their place. The token after a value-taking root flag is
	// that flag's value, so this skips it. Only root flags can precede a
	// subcommand, which is why that is the only list needed here.
	const rootValueFlags = valueFlagLabels(spec.root.flags);
	lines.push(`function __veyyon_subcommand`);
	lines.push(`\tset -l tokens (commandline -opc)`);
	// Drop the command name itself. A slice would have to cope with the
	// one-element list you get at `veyyon <TAB>`; erasing the first element does
	// not.
	lines.push(`\tset -e tokens[1]`);
	lines.push(`\tset -l skip 0`);
	lines.push(`\tfor i in $tokens`);
	lines.push(`\t\tif test $skip -eq 1`);
	lines.push(`\t\t\tset skip 0`);
	lines.push(`\t\t\tcontinue`);
	lines.push(`\t\tend`);
	if (rootValueFlags.length > 0) {
		lines.push(`\t\tif contains -- $i ${rootValueFlags.join(" ")}`);
		lines.push(`\t\t\tset skip 1`);
		lines.push(`\t\t\tcontinue`);
		lines.push(`\t\tend`);
	}
	lines.push(`\t\tif string match -qr '^-' -- $i`);
	lines.push(`\t\t\tcontinue`);
	lines.push(`\t\tend`);
	for (const c of spec.commands) {
		lines.push(`\t\tif contains -- $i ${commandTokens(c).join(" ")}`);
		lines.push(`\t\t\techo ${c.name}`);
		lines.push(`\t\t\treturn`);
		lines.push(`\t\tend`);
	}
	lines.push(`\t\treturn`);
	lines.push(`\tend`);
	lines.push(`end`);
	lines.push("");

	// The word before the cursor. `commandline -opc` is every completed word, so
	// its last element is what the user finished typing — the setting key in
	// `config set startup.autoUpdate <TAB>`.
	lines.push(`function __veyyon_prev_word`);
	lines.push(`\tset -l done (commandline -opc)`);
	lines.push(`\ttest (count $done) -gt 0; and echo $done[-1]`);
	lines.push(`end`);
	lines.push("");

	lines.push(`function __fish_veyyon_no_subcommand`);
	lines.push(`\ttest -z (__veyyon_subcommand)`);
	lines.push(`end`);
	lines.push("");

	if (spec.root.args.some(a => a.value.kind === "at-file")) {
		// `@` attaches a file. It is not part of the path, so it is stripped before
		// the lookup and put back on every candidate: a candidate replaces the
		// whole token, and fish matches candidates against it.
		lines.push(`function __veyyon_at_file_candidates`);
		lines.push(`\tset -l cur (commandline -ct)`);
		lines.push(`\tstring match -q '@*' -- $cur; or return`);
		// __fish_complete_path emits `path<TAB>description`; only the path is a
		// candidate. `\\t` is unquoted so fish reads it as a tab.
		lines.push(`\tfor p in (__fish_complete_path (string sub -s 2 -- $cur))`);
		lines.push(`\t\techo "@"(string split -m1 \\t -- $p)[1]`);
		lines.push(`\tend`);
		lines.push(`end`);
		lines.push("");
	}

	lines.push(`function __veyyon_using`);
	lines.push(`\tcontains -- (__veyyon_subcommand) $argv`);
	lines.push(`end`);
	lines.push("");

	const rootCond = "__fish_veyyon_no_subcommand";

	// Subcommand names.
	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`complete -c ${bin} -f -n '${rootCond}' -a '${token}' -d '${fishDesc(c.description)}'`);
		}
	}
	lines.push("");

	// Top-level flags.
	for (const f of spec.root.flags) {
		lines.push(fishFlagLine(bin, rootCond, f));
	}
	// Root positionals. Only `@file` has candidates today, but routing them
	// through the same mapping the flags use means a future one is not forgotten
	// here the way subcommand positionals were.
	const seenRootArgs = new Set<string>();
	for (const a of spec.root.args) {
		if (!fishValueHasCandidates(a.value)) continue;
		const arg = fishValue(bin, a.value);
		if (!arg || seenRootArgs.has(arg)) continue;
		seenRootArgs.add(arg);
		lines.push(`complete -c ${bin} -n '${rootCond}' ${arg} -d '${fishDesc(a.description)}'`);
	}
	lines.push("");

	// Per-subcommand flags and positional args.
	for (const c of spec.commands) {
		const cond = `__veyyon_using ${c.name}`;
		for (const f of c.flags) {
			lines.push(fishFlagLine(bin, cond, f));
		}
		// Positionals: fish conditions can't gate on position, so every positional
		// that has candidates contributes them under the same condition, and a
		// path-typed one contributes file completion once. Only enums used to be
		// emitted at all, which left `config set <TAB>` and `bench <models> <TAB>`
		// with nothing in fish while bash and zsh answered both.
		const seenValueArgs = new Set<string>();
		for (const a of c.args) {
			if (!fishValueHasCandidates(a.value)) continue;
			const arg = fishValue(bin, a.value);
			if (!arg || seenValueArgs.has(arg)) continue;
			seenValueArgs.add(arg);
			lines.push(`complete -c ${bin} -n '${cond}' ${arg} -d '${fishDesc(a.description)}'`);
		}
	}
	lines.push("");

	// The alias reuses every rule above via fish's `-w` (wraps), so the ~800 lines
	// are emitted once. fish autoloads a completion file by command name, so the
	// installer additionally writes this same script as `<alias>.fish` — without
	// that file fish would never load these rules when completing the alias.
	for (const alias of binNames(spec).slice(1)) {
		lines.push(`complete -c ${alias} -w ${bin}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// --- powershell ---------------------------------------------------------------

/**
 * Escape a string for a single-quoted PowerShell literal.
 *
 * PowerShell single-quoted strings interpret nothing except a doubled quote, so
 * this is the only escape needed and the only one that is safe: a description
 * containing `$( )` would be executed inside a double-quoted string.
 */
function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/** A one-line description, flattened for a PowerShell tooltip. */
function psDesc(s: string): string {
	return psQuote(collapseWhitespace(s));
}

/** A PowerShell array literal of quoted strings. */
function psArray(values: readonly string[]): string {
	return values.length === 0 ? "@()" : `@(${values.map(psQuote).join(", ")})`;
}

/**
 * One flag or positional rendered as the hashtable the completer reads.
 *
 * `Kind` is the {@link ValueSource} discriminant verbatim, so the emitted script
 * and this file agree by construction rather than by a parallel mapping that
 * could drift when a new kind is added.
 */
function psValueEntry(v: ValueSource): string {
	const values = v.kind === "enum" || v.kind === "list" ? v.values : [];
	const multiple = v.kind === "models" ? v.multiple : false;
	return `@{ Kind = ${psQuote(v.kind)}; Values = ${psArray(values)}; Multiple = $${multiple} }`;
}

/** `'--name' = @{ … }` entries for every flag, long form and short char alike. */
function psFlagTable(flags: CompletionFlag[], indent: string): string {
	const lines: string[] = [];
	for (const f of flags) {
		const entry = `@{ Desc = ${psDesc(f.description)}; Value = ${psValueEntry(f.value)} }`;
		lines.push(`${indent}${psQuote(`--${f.name}`)} = ${entry}`);
		if (f.char) lines.push(`${indent}${psQuote(`-${f.char}`)} = ${entry}`);
	}
	return lines.join("\n");
}

/**
 * PowerShell completion, registered through `Register-ArgumentCompleter -Native`.
 *
 * Unlike the POSIX shells there is no per-command file a shell autoloads, so
 * this script is meant to be dot-sourced from the user's `$PROFILE`. It
 * registers one completer bound to every name the binary answers to, which is
 * why `-CommandName` takes the full {@link binNames} list rather than just `bin`.
 *
 * Every name it defines is written to the GLOBAL scope. Registering a completer
 * outlives the script that registered it, so a user who RUNS this file instead
 * of dot-sourcing it would otherwise get a completer whose tables and helper
 * functions had already gone out of scope — tab completion that silently
 * produces nothing, with the registration still in place to hide the cause.
 *
 * The generated script is data plus one fixed completer, rather than generated
 * control flow: the tables below are the only part that changes as commands and
 * flags are added, so the logic can be read once and trusted.
 */
function generatePowerShell(spec: CompletionSpec): string {
	const { bin } = spec;
	const lines: string[] = [];
	lines.push(`# PowerShell completion for ${bin} — generated by \`${bin} completions powershell\``);
	lines.push(`# Dot-source this from your $PROFILE, or write it to a file and dot-source that.`);
	lines.push("");

	lines.push("$global:__veyyonCommands = @{");
	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`\t${psQuote(token)} = ${psDesc(c.description)}`);
		}
	}
	lines.push("}");
	lines.push("");

	lines.push("$global:__veyyonRootFlags = @{");
	lines.push(psFlagTable(spec.root.flags, "\t"));
	lines.push("}");
	lines.push("");

	lines.push("$global:__veyyonCommandFlags = @{");
	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`\t${psQuote(token)} = @{`);
			lines.push(psFlagTable(c.flags, "\t\t"));
			lines.push("\t}");
		}
	}
	lines.push("}");
	lines.push("");

	// Positional candidates, one entry per subcommand that has completable ones.
	// PowerShell cannot gate on argument position any more than fish can, so a
	// subcommand's enum positionals are merged and offered together.
	lines.push("$global:__veyyonCommandArgs = @{");
	for (const c of spec.commands) {
		const enums = c.args.flatMap(a => (a.value.kind === "enum" ? [...a.value.values] : []));
		const kind = enums.length > 0 ? "enum" : c.args.some(a => a.value.kind === "file") ? "file" : undefined;
		if (!kind) continue;
		for (const token of commandTokens(c)) {
			lines.push(
				`\t${psQuote(token)} = @{ Kind = ${psQuote(kind)}; Values = ${psArray(enums)}; Multiple = $false }`,
			);
		}
	}
	lines.push("}");
	lines.push("");

	lines.push(`$global:__veyyonBin = ${psQuote(bin)}`);
	lines.push("");
	lines.push(PS_COMPLETER_BODY);
	lines.push("");
	lines.push(
		`Register-ArgumentCompleter -Native -CommandName ${binNames(spec)
			.map(psQuote)
			.join(", ")} -ScriptBlock $__veyyonCompleter`,
	);
	lines.push("");
	return `${lines.join("\n")}\n`;
}

/**
 * The fixed half of the PowerShell completion script.
 *
 * Held as one literal rather than assembled line by line because none of it
 * varies with the CLI surface: every command- and flag-specific detail lives in
 * the tables {@link generatePowerShell} emits above it. Keeping the logic in one
 * readable block is what makes the generated script auditable.
 */
const PS_COMPLETER_BODY =
	// The three pieces below are ONE PowerShell script, split only because PowerShell's escape
	// character is the backtick, which cannot appear inside a template literal. Every piece stays
	// `String.raw` so the seam is invisible: the reader does not have to track which fragment
	// happens to contain a backslash today and which will tomorrow.
	// biome-ignore lint/complexity/noUselessStringRaw: one raw literal split around a backtick, see above.
	String.raw`function global:__Veyyon-DynamicCandidates {
	param([string]$Kind, [string]$WordToComplete, [string]$Arg)
	# The live model catalog, on-disk sessions and the settings schema are only
	# known to the running binary, so ask it. A failure here yields no candidates
	# rather than an error in the middle of the user's prompt line. $Arg carries
	# the one kind that needs a subject: setting-values names its setting.
	$out = if ($Arg) {
		& $__veyyonBin __complete $Kind $Arg -- $WordToComplete 2>$null
	} else {
		& $__veyyonBin __complete $Kind -- $WordToComplete 2>$null
	}
	if ($LASTEXITCODE -ne 0 -or -not $out) { return @() }
	return @($out | ForEach-Object { ($_ -split "` +
	"`t" +
	// biome-ignore lint/complexity/noUselessStringRaw: same split literal as above.
	String.raw`")[0] } | Where-Object { $_ })
}

# Everything the completer offers REPLACES the whole word the user has typed, and
# the caller filters candidates with a -like match against that word. Both facts
# mean a candidate must carry whatever prefix the user already typed. Returning
# bare leaf names made file, directory, and comma-list completion return nothing
# at all the moment the word contained a separator: --tools read,ba<Tab> and
# -e src/ma<Tab> both matched no candidate, which looks like completion is
# simply broken for those flags.
function global:__Veyyon-PrefixedPaths {
	param([string]$WordToComplete, [switch]$DirectoriesOnly)
	$parent = Split-Path -Parent $WordToComplete
	$items = Get-ChildItem -Path "$WordToComplete*" -Directory:$DirectoriesOnly -ErrorAction SilentlyContinue
	return @($items | ForEach-Object { if ($parent) { Join-Path $parent $_.Name } else { $_.Name } })
}

# A comma-separated value completes only its LAST element, with the elements
# already chosen carried through. Mirrors _veyyon_comma in the bash script.
function global:__Veyyon-CommaCandidates {
	param([string[]]$Values, [string]$WordToComplete)
	$cut = $WordToComplete.LastIndexOf(',')
	if ($cut -lt 0) { return $Values }
	$prefix = $WordToComplete.Substring(0, $cut + 1)
	$chosen = $prefix.TrimEnd(',') -split ','
	return @($Values | Where-Object { $chosen -notcontains $_ } | ForEach-Object { "$prefix$_" })
}

function global:__Veyyon-ValueCandidates {
	param($Value, [string]$WordToComplete, [string]$Previous)
	switch ($Value.Kind) {
		'enum' { return $Value.Values }
		'list' { return __Veyyon-CommaCandidates $Value.Values $WordToComplete }
		'models' { return __Veyyon-DynamicCandidates 'models' $WordToComplete }
		'sessions' { return __Veyyon-DynamicCandidates 'sessions' $WordToComplete }
		'settings' { return __Veyyon-DynamicCandidates 'settings' $WordToComplete }
		'setting-values' {
			if (-not $Previous) { return @() }
			return __Veyyon-DynamicCandidates 'setting-values' $WordToComplete $Previous
		}
		'file' { return __Veyyon-PrefixedPaths $WordToComplete }
		'at-file' {
			# Free text unless it starts with @, which names a file to attach. The
			# @ must come back on every candidate: it is part of the word being
			# replaced, and the caller filters candidates against that word.
			if (-not $WordToComplete.StartsWith('@')) { return @() }
			return @(__Veyyon-PrefixedPaths $WordToComplete.Substring(1) | ForEach-Object { "@$_" })
		}
		'dir' { return __Veyyon-PrefixedPaths $WordToComplete -DirectoriesOnly }
	}
	# 'flag' takes no value and 'value' has no completable candidates.
	return @()
}

$global:__veyyonCompleter = {
	param($wordToComplete, $commandAst, $cursorPosition)

	$tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
	# Element 0 is the command name itself.
	if ($tokens.Count -gt 1) { $tokens = $tokens[1..($tokens.Count - 1)] } else { $tokens = @() }

	# The token before the word being completed. When the cursor sits on a
	# partially typed word, that word is the last element and the one before it is
	# what decides whether a value is expected.
	$prev = ''
	if ($wordToComplete) {
		if ($tokens.Count -ge 2) { $prev = $tokens[$tokens.Count - 2] }
		$tokens = @($tokens | Select-Object -First ([Math]::Max(0, $tokens.Count - 1)))
	} elseif ($tokens.Count -ge 1) {
		$prev = $tokens[$tokens.Count - 1]
	}

	# The subcommand is the first bare token that names one. Anything after a
	# value-taking flag is that flag's value, not a subcommand.
	$sub = ''
	$expectValue = $false
	foreach ($t in $tokens) {
		if ($expectValue) { $expectValue = $false; continue }
		if ($t.StartsWith('-')) {
			$f = $__veyyonRootFlags[$t]
			if (-not $f -and $sub) { $f = $__veyyonCommandFlags[$sub][$t] }
			if ($f -and $f.Value.Kind -ne 'flag') { $expectValue = $true }
			continue
		}
		if (-not $sub -and $__veyyonCommands.ContainsKey($t)) { $sub = $t }
	}

	$flags = @{}
	foreach ($k in $__veyyonRootFlags.Keys) { $flags[$k] = $__veyyonRootFlags[$k] }
	if ($sub -and $__veyyonCommandFlags.ContainsKey($sub)) {
		foreach ($k in $__veyyonCommandFlags[$sub].Keys) { $flags[$k] = $__veyyonCommandFlags[$sub][$k] }
	}

	$candidates = @()
	$tooltips = @{}

	if ($prev -and $flags.ContainsKey($prev) -and $flags[$prev].Value.Kind -ne 'flag') {
		$candidates = __Veyyon-ValueCandidates $flags[$prev].Value $wordToComplete $prev
	} elseif ($wordToComplete.StartsWith('-')) {
		$candidates = @($flags.Keys)
		foreach ($k in $flags.Keys) { $tooltips[$k] = $flags[$k].Desc }
	} elseif (-not $sub) {
		$candidates = @($__veyyonCommands.Keys)
		foreach ($k in $__veyyonCommands.Keys) { $tooltips[$k] = $__veyyonCommands[$k] }
	} elseif ($__veyyonCommandArgs.ContainsKey($sub)) {
		$candidates = __Veyyon-ValueCandidates $__veyyonCommandArgs[$sub] $wordToComplete $prev
	}

	$candidates |
		Where-Object { $_ -like "$wordToComplete*" } |
		Sort-Object |
		ForEach-Object {
			$tip = $tooltips[$_]
			if (-not $tip) { $tip = $_ }
			[System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $tip)
		}
}`;
