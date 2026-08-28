import { APP_ALIAS, collapseWhitespace } from "@veyyon/utils";
import type { ArgDescriptor, CliConfig, CommandCtor, FlagDescriptor } from "@veyyon/utils/cli";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";

export type Shell = "bash" | "zsh" | "fish" | "powershell";

export type ValueSource =
	| { kind: "flag" } // boolean — takes no value
	| { kind: "value" } // takes a value with no completable candidates (e.g. integer, free text)
	| { kind: "enum"; values: readonly string[] } // static single value
	| { kind: "list"; values: readonly string[] } // static comma-separated list
	| { kind: "models"; multiple: boolean } // dynamic: live model catalog
	| { kind: "sessions" } // dynamic: on-disk sessions
	| { kind: "settings" } // dynamic: setting keys from SETTINGS_SCHEMA
	| { kind: "setting-values" }
	| { kind: "file" }
	| { kind: "dir" }
	| { kind: "at-file" };

export interface CompletionFlag {
	name: string;
	char?: string;
	description: string;
	value: ValueSource;
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
	binAliases: readonly string[];
	root: { flags: CompletionFlag[]; args: CompletionArg[] };
	commands: CompletionCommand[];
}

export function binNames(spec: CompletionSpec): string[] {
	return [spec.bin, ...spec.binAliases.filter(a => a && a !== spec.bin)];
}

const MODEL_FLAGS: Record<string, true> = {
	model: true,
	smol: true,
	slow: true,
	plan: true,
	"prewalk-into": true,
	"plan-yolo-into": true,
};
const SESSION_FLAGS: Record<string, true> = { resume: true, fork: true, session: true };
const DIR_FLAGS: Record<string, true> = {
	"session-dir": true,
	"plugin-dir": true,
	"agent-dir": true,
	cwd: true,
	dir: true,
};
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

export const FILE_ARGS: Record<string, true> = {
	"auth-broker.source": true,
	"grep.path": true,
	"install.targets": true,
	"plugin.targets": true,
	"read.path": true,
	"ttsr.snippet": true,
};
export const AT_FILE_ARGS: Record<string, true> = { "launch.messages": true };
export const MODEL_ARGS: Record<string, true> = {
	"bench/throughput.models": true,
	"dry-balance.model": true,
	"tiny-models.model": true,
};

export const SETTING_ARGS: Record<string, ValueSource> = {
	"config.key": { kind: "settings" },
	"config.value": { kind: "setting-values" },
};

function argValue(command: string, name: string, desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	const key = `${command}.${name}`;
	if (SETTING_ARGS[key]) return SETTING_ARGS[key];
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
	const binAliases = options.includeLaunchAlias === false ? [] : [APP_ALIAS];
	return { bin: config.bin, binAliases, root, commands };
}

function takesValue(v: ValueSource): boolean {
	return v.kind !== "flag";
}

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

function bashWords(values: readonly string[]): string {
	return values.join(" ").replace(/"/g, '\\"');
}

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

function bashFlagCase(bin: string, flags: CompletionFlag[]): string {
	const lines: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		const labels = [`--${f.name}`, ...(f.char ? [`-${f.char}`] : [])];
		lines.push(`\t\t${labels.join("|")})\n\t\t\t${bashValueBranch(bin, f.value)}\n\t\t\t;;`);
	}
	return lines.join("\n");
}

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

function zshDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[\r\n]+/g, " ")
		.replace(/:/g, " ")
		.trim();
}

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
	const listFlag = spec.root.flags.concat(spec.commands.flatMap(c => c.flags)).find(f => f.value.kind === "list");
	const toolNames = listFlag?.value.kind === "list" ? listFlag.value.values.join(" ") : "";
	const parts: string[] = [];
	parts.push(`#compdef ${binNames(spec).join(" ")}`);
	parts.push(`# zsh completion for ${bin} — generated by \`${bin} completions zsh\``);
	parts.push("");

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

	const cmdRows = spec.commands.map(c => `\t\t'${c.name}:${zshDesc(c.description)}'`).join("\n");
	parts.push(`_veyyon_commands() {
	local -a commands
	commands=(
${cmdRows}
	)
	_describe -t commands 'command' commands
}`);
	parts.push("");

	for (const c of spec.commands) {
		const specs = ["'(-h --help)'{-h,--help}'[Show help]'", ...c.flags.map(zshFlagSpec), ...c.args.map(zshArgSpec)];
		parts.push(`_veyyon_cmd_${bashFn(c.name)}() {
	_arguments -s \\
		${specs.join(" \\\n\t\t")}
}`);
		parts.push("");
	}

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

function fishDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

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

	const rootValueFlags = valueFlagLabels(spec.root.flags);
	lines.push(`function __veyyon_subcommand`);
	lines.push(`\tset -l tokens (commandline -opc)`);
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
		lines.push(`function __veyyon_at_file_candidates`);
		lines.push(`\tset -l cur (commandline -ct)`);
		lines.push(`\tstring match -q '@*' -- $cur; or return`);
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

	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`complete -c ${bin} -f -n '${rootCond}' -a '${token}' -d '${fishDesc(c.description)}'`);
		}
	}
	lines.push("");

	for (const f of spec.root.flags) {
		lines.push(fishFlagLine(bin, rootCond, f));
	}
	const seenRootArgs = new Set<string>();
	for (const a of spec.root.args) {
		if (!fishValueHasCandidates(a.value)) continue;
		const arg = fishValue(bin, a.value);
		if (!arg || seenRootArgs.has(arg)) continue;
		seenRootArgs.add(arg);
		lines.push(`complete -c ${bin} -n '${rootCond}' ${arg} -d '${fishDesc(a.description)}'`);
	}
	lines.push("");

	for (const c of spec.commands) {
		const cond = `__veyyon_using ${c.name}`;
		for (const f of c.flags) {
			lines.push(fishFlagLine(bin, cond, f));
		}
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

	for (const alias of binNames(spec).slice(1)) {
		lines.push(`complete -c ${alias} -w ${bin}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function psDesc(s: string): string {
	return psQuote(collapseWhitespace(s));
}

function psArray(values: readonly string[]): string {
	return values.length === 0 ? "@()" : `@(${values.map(psQuote).join(", ")})`;
}

function psValueEntry(v: ValueSource): string {
	const values = v.kind === "enum" || v.kind === "list" ? v.values : [];
	const multiple = v.kind === "models" ? v.multiple : false;
	return `@{ Kind = ${psQuote(v.kind)}; Values = ${psArray(values)}; Multiple = $${multiple} }`;
}

function psFlagTable(flags: CompletionFlag[], indent: string): string {
	const lines: string[] = [];
	for (const f of flags) {
		const entry = `@{ Desc = ${psDesc(f.description)}; Value = ${psValueEntry(f.value)} }`;
		lines.push(`${indent}${psQuote(`--${f.name}`)} = ${entry}`);
		if (f.char) lines.push(`${indent}${psQuote(`-${f.char}`)} = ${entry}`);
	}
	return lines.join("\n");
}

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

	lines.push("$global:__veyyonCommandArgs = @{");
	for (const c of spec.commands) {
		const enums = c.args.flatMap(a => (a.value.kind === "enum" ? a.value.values.slice() : []));
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

const PS_COMPLETER_BODY =
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
