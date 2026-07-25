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
	| { kind: "file" }
	| { kind: "dir" };

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
const MODEL_FLAGS: Record<string, true> = { model: true, smol: true, slow: true, plan: true };
/** Single-value flags resolved against on-disk sessions. */
const SESSION_FLAGS: Record<string, true> = { resume: true, fork: true, session: true };
/** Flags whose value is a directory path. */
const DIR_FLAGS: Record<string, true> = { "session-dir": true, "plugin-dir": true };

function flagValue(name: string, desc: FlagDescriptor): ValueSource {
	if (desc.kind === "boolean") return { kind: "flag" };
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (MODEL_FLAGS[name]) return { kind: "models", multiple: false };
	if (name === "models") return { kind: "models", multiple: true };
	if (SESSION_FLAGS[name]) return { kind: "sessions" };
	if (name === "tools") return { kind: "list", values: BUILTIN_TOOL_NAMES };
	if (DIR_FLAGS[name]) return { kind: "dir" };
	if (desc.kind === "integer") return { kind: "value" };
	return { kind: "file" };
}

function argValue(desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	return { kind: "file" };
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
	}
	return out;
}

function buildArgs(Cmd: CommandCtor): CompletionArg[] {
	const out: CompletionArg[] = [];
	const args = Cmd.args ?? {};
	for (const name in args) {
		const desc = args[name];
		out.push({ name, description: desc.description ?? "", value: argValue(desc) });
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
		const args = buildArgs(Cmd);
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
		case "models":
			return v.multiple
				? `_veyyon_comma "$(command ${bin} __complete models 2>/dev/null | cut -f1)"; return 0`
				: `COMPREPLY=( $(compgen -W "$(command ${bin} __complete models -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "sessions":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete sessions -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "file":
			return `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0`;
		case "dir":
			return `COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0`;
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
function bashValueFlagLabels(flags: CompletionFlag[]): string {
	const labels: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		labels.push(`--${f.name}`);
		if (f.char) labels.push(`-${f.char}`);
	}
	return labels.join("|");
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

	// Root handler: top-level flags + subcommand names.
	const subTokens = spec.commands.flatMap(commandTokens).sort();
	parts.push(`_veyyon_root() {
	case "$prev" in
${bashFlagCase(bin, spec.root.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(spec.root.flags)}" -- "$cur") )
	else
		COMPREPLY=( $(compgen -W "${bashWords(subTokens)} ${bashFlagWords(spec.root.flags)}" -- "$cur") )
	fi
}`);
	parts.push("");

	// Per-subcommand handlers.
	for (const c of spec.commands) {
		const argEnum = c.args.find(a => a.value.kind === "enum");
		const argWords = argEnum && argEnum.value.kind === "enum" ? bashWords(argEnum.value.values) : "";
		const fileArg = c.args.some(a => a.value.kind === "file");
		const elseBranch = argWords
			? `COMPREPLY=( $(compgen -W "${argWords}" -- "$cur") )`
			: fileArg
				? `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames`
				: ":";
		parts.push(`_veyyon_cmd_${bashFn(c.name)}() {
	case "$prev" in
${bashFlagCase(bin, c.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(c.flags)}" -- "$cur") )
	else
		${elseBranch}
	fi
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
	const valueFlagLabels = bashValueFlagLabels(spec.root.flags);
	const valueFlagArm = valueFlagLabels ? `\t\t\t${valueFlagLabels})\n\t\t\t\tskip=1\n\t\t\t\t;;` : "";
	const dispatch: string[] = [];
	for (const c of spec.commands) {
		dispatch.push(`\t\t${commandTokens(c).join("|")})\n\t\t\t_veyyon_cmd_${bashFn(c.name)}\n\t\t\t;;`);
	}
	parts.push(`_veyyon() {
	local cur prev cmd i skip
	cur="\${COMP_WORDS[COMP_CWORD]}"
	prev="\${COMP_WORDS[COMP_CWORD-1]}"
	cmd=""
	skip=0
	for (( i=1; i < COMP_CWORD; i++ )); do
		if (( skip )); then skip=0; continue; fi
		case "\${COMP_WORDS[i]}" in
${valueFlagArm}
			-*) ;;
			*) cmd="\${COMP_WORDS[i]}"; break ;;
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

function zshAction(v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return ":value:";
		case "enum":
			return `:value:(${v.values.join(" ")})`;
		case "list":
			return ":value:_veyyon_tools";
		case "models":
			return v.multiple ? ":models:_veyyon_models_list" : ":model:_veyyon_call models";
		case "sessions":
			return ":session:_veyyon_call sessions";
		case "file":
			return ":file:_files";
		case "dir":
			return ":dir:_files -/";
	}
}

function zshFlagSpec(f: CompletionFlag): string {
	const body = `[${zshDesc(f.description)}]${zshAction(f.value)}`;
	if (f.char && f.repeatable) return `'*'{-${f.char},--${f.name}}'${body}'`;
	if (f.char) return `'(-${f.char} --${f.name})'{-${f.char},--${f.name}}'${body}'`;
	if (f.repeatable) return `'*--${f.name}${body}'`;
	return `'--${f.name}${body}'`;
}

function zshArgSpec(f: CompletionArg): string {
	switch (f.value.kind) {
		case "enum":
			return `':${f.name}:(${f.value.values.join(" ")})'`;
		default:
			return `':${f.name}:_files'`;
	}
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
_veyyon_tools() { _values -s , 'tools' ${toolNames} }`);
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
		"'1: :_veyyon_commands'",
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

	const allTokens = spec.commands.flatMap(commandTokens);
	lines.push(`function __fish_veyyon_no_subcommand`);
	lines.push(`\tfor i in (commandline -opc)`);
	lines.push(`\t\tif contains -- $i ${allTokens.join(" ")}`);
	lines.push(`\t\t\treturn 1`);
	lines.push(`\t\tend`);
	lines.push(`\tend`);
	lines.push(`\treturn 0`);
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
	lines.push("");

	// Per-subcommand flags and positional args.
	for (const c of spec.commands) {
		const cond = `__fish_seen_subcommand_from ${commandTokens(c).join(" ")}`;
		for (const f of c.flags) {
			lines.push(fishFlagLine(bin, cond, f));
		}
		// Positionals: fish conditions can't gate on position, so emit enum
		// candidates (if any) and otherwise a single file completion — never both,
		// and never duplicated across multiple file-typed positionals.
		const enumArgs = c.args.filter(a => a.value.kind === "enum");
		if (enumArgs.length > 0) {
			for (const a of enumArgs) {
				if (a.value.kind !== "enum") continue;
				lines.push(
					`complete -c ${bin} -f -n '${cond}' -a '${a.value.values.join(" ")}' -d '${fishDesc(a.description)}'`,
				);
			}
		} else if (c.args.some(a => a.value.kind === "file")) {
			lines.push(`complete -c ${bin} -F -n '${cond}'`);
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
	String.raw`function global:__Veyyon-DynamicCandidates {
	param([string]$Kind, [string]$WordToComplete)
	# The live model catalog and on-disk sessions are only known to the running
	# binary, so ask it. A failure here yields no candidates rather than an error
	# in the middle of the user's prompt line.
	$out = & $__veyyonBin __complete $Kind -- $WordToComplete 2>$null
	if ($LASTEXITCODE -ne 0 -or -not $out) { return @() }
	return @($out | ForEach-Object { ($_ -split "` +
	"`t" +
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
	param($Value, [string]$WordToComplete)
	switch ($Value.Kind) {
		'enum' { return $Value.Values }
		'list' { return __Veyyon-CommaCandidates $Value.Values $WordToComplete }
		'models' { return __Veyyon-DynamicCandidates 'models' $WordToComplete }
		'sessions' { return __Veyyon-DynamicCandidates 'sessions' $WordToComplete }
		'file' { return __Veyyon-PrefixedPaths $WordToComplete }
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
		$candidates = __Veyyon-ValueCandidates $flags[$prev].Value $wordToComplete
	} elseif ($wordToComplete.StartsWith('-')) {
		$candidates = @($flags.Keys)
		foreach ($k in $flags.Keys) { $tooltips[$k] = $flags[$k].Desc }
	} elseif (-not $sub) {
		$candidates = @($__veyyonCommands.Keys)
		foreach ($k in $__veyyonCommands.Keys) { $tooltips[$k] = $__veyyonCommands[$k] }
	} elseif ($__veyyonCommandArgs.ContainsKey($sub)) {
		$candidates = __Veyyon-ValueCandidates $__veyyonCommandArgs[$sub] $wordToComplete
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
