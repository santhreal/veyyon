import { parseArgs as nodeParseArgs } from "node:util";
import { clampLow } from "./math";
import { startupMarker } from "./startup-marker";
import { errorMessage } from "./type-guards";

const NEGATIVE_NUMBER = /^-(?:\d|\.\d)/;
const NEGATIVE_MASK = "\u0000neg\u0000";

interface ParsedArgs {
	values: Record<string, string | boolean | Array<string | boolean> | undefined>;
	positionals: string[];
}

/** Mask negative-number tokens so parseArgs does not treat them as flags. */
function maskNegativeNumbers(argv: readonly string[]): {
	args: string[];
	restore: (parsed: ParsedArgs) => ParsedArgs;
} {
	const masked: string[] = [];
	const originals: string[] = [];
	let afterDoubleDash = false;
	for (const token of argv) {
		if (afterDoubleDash || !NEGATIVE_NUMBER.test(token)) {
			masked.push(token);
			if (token === "--") afterDoubleDash = true;
			continue;
		}
		masked.push(`${NEGATIVE_MASK}${originals.length}`);
		originals.push(token);
	}

	if (originals.length === 0) return { args: masked, restore: parsed => parsed };

	const unmask = (value: string): string => {
		if (!value.startsWith(NEGATIVE_MASK)) return value;
		const index = Number(value.slice(NEGATIVE_MASK.length));
		return originals[index] ?? value;
	};

	return {
		args: masked,
		restore: parsed => {
			const values: ParsedArgs["values"] = {};
			for (const [name, value] of Object.entries(parsed.values)) {
				if (typeof value === "string") values[name] = unmask(value);
				else if (Array.isArray(value))
					values[name] = value.map(item => (typeof item === "string" ? unmask(item) : item));
				else values[name] = value;
			}
			return { values, positionals: parsed.positionals.map(unmask) };
		},
	};
}

/** Exit code for CLI usage mistakes. */
export const CLI_EXIT_USAGE = 2;

/** Validation error for missing/invalid CLI arguments or flags. */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
	aliases?: readonly string[];
}

export interface ArgDescriptor {
	kind: "string";
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

interface FlagInput {
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
	aliases?: readonly string[];
}

interface ArgInput {
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

export const Flags = {
	string<T extends FlagInput>(opts?: T): FlagDescriptor<"string"> & T {
		return { kind: "string" as const, ...opts } as FlagDescriptor<"string"> & T;
	},
	boolean<T extends FlagInput>(opts?: T): FlagDescriptor<"boolean"> & T {
		return { kind: "boolean" as const, ...opts } as FlagDescriptor<"boolean"> & T;
	},
	integer<T extends FlagInput & { default?: number }>(opts?: T): FlagDescriptor<"integer"> & T {
		return { kind: "integer" as const, ...opts } as FlagDescriptor<"integer"> & T;
	},
};

export const Args = {
	string<T extends ArgInput>(opts?: T): ArgDescriptor & T {
		return { kind: "string" as const, ...opts } as ArgDescriptor & T;
	},
};

type FlagValue<D extends FlagDescriptor> = D["kind"] extends "boolean"
	? D extends { default: boolean }
		? boolean
		: boolean | undefined
	: D["kind"] extends "integer"
		? D extends { default: number }
			? number
			: number | undefined
		: D extends { multiple: true }
			? string[] | undefined
			: string | undefined;

type ArgValue<D extends ArgDescriptor> = D extends { multiple: true } ? string[] | undefined : string | undefined;

type FlagValues<T extends Record<string, FlagDescriptor>> = { [K in keyof T]: FlagValue<T[K]> };
type ArgValues<T extends Record<string, ArgDescriptor>> = { [K in keyof T]: ArgValue<T[K]> };

export interface ParseOutput<
	F extends Record<string, FlagDescriptor> = Record<string, FlagDescriptor>,
	A extends Record<string, ArgDescriptor> = Record<string, ArgDescriptor>,
> {
	flags: FlagValues<F>;
	args: ArgValues<A>;
	argv: string[];
}

export interface CommandCtor {
	new (argv: string[], config: CliConfig): Command;
	description?: string;
	hidden?: boolean;
	devTool?: boolean;
	strict?: boolean;
	aliases?: string[];
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
	examples?: string[];
}

/** Configuration passed to command instances and help renderers. */
export interface CliConfig {
	bin: string;
	version: string;
	commands: Map<string, CommandCtor>;
	summaries?: Map<string, CommandSummary>;
}

function parseFlagValue(name: string, desc: FlagDescriptor, raw: unknown): unknown {
	if (desc.kind === "integer") {
		if (raw === undefined || typeof raw === "boolean") {
			return desc.default ?? undefined;
		}
		const n = Number.parseInt(raw as string, 10);
		if (Number.isNaN(n)) {
			throw new CliUsageError(`Expected integer for --${name}, got "${raw}"`);
		}
		return n;
	}
	if (desc.kind === "boolean") {
		return raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
	}
	const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
	if (val !== undefined && desc.options && !Array.isArray(val)) {
		if (!desc.options.includes(val as string)) {
			throw new CliUsageError(`Expected --${name} to be one of: ${desc.options.slice().join(", ")}; got "${val}"`);
		}
	}
	return val;
}

function buildFlagParseOptions(flagDefs: Record<string, FlagDescriptor>): {
	options: Record<
		string,
		{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
	>;
	aliasToCanonical: Map<string, string>;
} {
	const options: Record<
		string,
		{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
	> = {};
	const aliasToCanonical = new Map<string, string>();

	for (const [name, desc] of Object.entries(flagDefs)) {
		const opt: (typeof options)[string] = {
			type: desc.kind === "boolean" ? "boolean" : "string",
		};
		if (desc.char) opt.short = desc.char;
		if (desc.multiple) opt.multiple = true;
		if (desc.default !== undefined) {
			opt.default = desc.kind === "boolean" ? Boolean(desc.default) : String(desc.default);
		}
		options[name] = opt;
	}

	for (const [name, desc] of Object.entries(flagDefs)) {
		for (const alias of desc.aliases ?? []) {
			if (options[alias]) {
				throw new Error(
					`Flag alias --${alias} on --${name} collides with an existing flag. ` +
						"Rename the alias or drop the duplicate declaration.",
				);
			}
			aliasToCanonical.set(alias, name);
			options[alias] = {
				type: options[name].type,
				...(options[name].multiple ? { multiple: true } : {}),
			};
		}
	}

	return { options, aliasToCanonical };
}

/** Minimal Command base matching the oclif surface used by veyyon. */
export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	/** Parse argv against the static flags and args declared on the command class. */
	async parse<C extends CommandCtor>(
		_Cmd: C,
	): Promise<
		ParseOutput<
			NonNullable<C["flags"]> extends Record<string, FlagDescriptor>
				? NonNullable<C["flags"]>
				: Record<string, FlagDescriptor>,
			NonNullable<C["args"]> extends Record<string, ArgDescriptor>
				? NonNullable<C["args"]>
				: Record<string, ArgDescriptor>
		>
	> {
		const Cmd = _Cmd as CommandCtor;
		const flagDefs = (Cmd.flags ?? {}) as Record<string, FlagDescriptor>;
		const argDefs = (Cmd.args ?? {}) as Record<string, ArgDescriptor>;
		const strict = Cmd.strict !== false;

		const { options, aliasToCanonical } = buildFlagParseOptions(flagDefs);

		const { values: rawValues, positionals } = (() => {
			const { args: maskedArgs, restore } = maskNegativeNumbers(this.argv);
			try {
				const parsed = nodeParseArgs({
					args: maskedArgs,
					options,
					allowPositionals: true,
					strict,
				});
				return restore(parsed);
			} catch (error) {
				throw new CliUsageError(errorMessage(error));
			}
		})();

		for (const [alias, canonical] of aliasToCanonical) {
			const aliasValue = rawValues[alias];
			if (aliasValue !== undefined && rawValues[canonical] === undefined) {
				rawValues[canonical] = aliasValue;
			}
		}

		const flags: Record<string, unknown> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			flags[name] = parseFlagValue(name, desc, rawValues[name]);
			if (desc.required && flags[name] === undefined) {
				throw new CliUsageError(`Missing required flag: --${name}`);
			}
		}

		const args: Record<string, unknown> = {};
		let posIdx = 0;
		for (const [argName, desc] of Object.entries(argDefs)) {
			if (desc.multiple) {
				const val = positionals.slice(posIdx);
				args[argName] = val.length > 0 ? val : undefined;
				posIdx = positionals.length;
			} else {
				const val = positionals[posIdx];
				args[argName] = val;
				posIdx++;
			}
			if (desc.required && args[argName] === undefined) {
				throw new CliUsageError(`Missing required argument: ${argName}`);
			}
			const argVal = args[argName];
			if (argVal !== undefined && desc.options && typeof argVal === "string") {
				if (!desc.options.includes(argVal)) {
					throw new CliUsageError(
						`Expected ${argName} to be one of: ${desc.options.slice().join(", ")}; got "${argVal}"`,
					);
				}
			}
		}

		if (posIdx < positionals.length) {
			const stray = positionals.slice(posIdx);
			const label = stray.length === 1 ? "argument" : "arguments";
			throw new CliUsageError(`Unexpected ${label}: ${stray.map(token => `"${token}"`).join(", ")}`);
		}

		return { flags, args, argv: positionals } as never;
	}
}

/** Split command arguments honoring quotes and backslash escapes. */
export function tokenizeQuotedArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			current += input[++index];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function helpWidth(): number {
	const columns = process.stdout.columns;
	if (typeof columns === "number" && columns > 0) return clampLow(columns, 60, 100);
	const exported = Number(process.env.COLUMNS);
	if (Number.isFinite(exported) && exported > 0) return clampLow(exported, 60, 100);
	return 80;
}

const DEFAULT_GUTTER_FRACTION = 1 / 3;

function gutter(entries: readonly string[], width: number, maxFraction: number = DEFAULT_GUTTER_FRACTION): number {
	const longest = entries.length > 0 ? Math.max(...entries.map(entry => Bun.stringWidth(entry))) : 0;
	return Math.min(longest + 2, Math.floor(width * maxFraction));
}

function pushWrapped(lines: string[], left: string, description: string, column: number, width: number): void {
	if (!description) {
		lines.push(left);
		return;
	}
	const MIN_GAP = 2;
	const leftWidth = Bun.stringWidth(left);
	const indent = " ".repeat(column);
	const wrapped = Bun.wrapAnsi(description, Math.max(20, width - column), { trim: true }).split("\n");
	const [first, ...rest] = wrapped;
	if (leftWidth + MIN_GAP > column) {
		lines.push(left);
		lines.push(`${indent}${first}`);
	} else {
		lines.push(`${left}${" ".repeat(column - leftWidth)}${first}`);
	}
	for (const line of rest) lines.push(`${indent}${line}`);
}

/** Lay out a two-column help table wrapped to terminal width. */
export function renderHelpTable(
	rows: ReadonlyArray<readonly [name: string, description: string]>,
	options: { indent?: string; maxGutterFraction?: number } = {},
): string[] {
	const indent = options.indent ?? "  ";
	const width = helpWidth();
	const lefts = rows.map(([name]) => `${indent}${name}`);
	const column = gutter(lefts, width, options.maxGutterFraction);
	const lines: string[] = [];
	for (const [index, [, description]] of rows.entries()) {
		pushWrapped(lines, lefts[index] ?? "", description, column, width);
	}
	return lines;
}

/** Wrap a paragraph of help text to the terminal at a given indent. */
export function renderHelpParagraph(text: string, options: { indent?: string } = {}): string[] {
	const indent = options.indent ?? "  ";
	const width = helpWidth();
	const usable = Math.max(20, width - Bun.stringWidth(indent));
	return Bun.wrapAnsi(text, usable, { trim: true })
		.split("\n")
		.map(line => `${indent}${line}`);
}

/** Render full root help for the CLI. */
export function renderRootHelp(config: CliConfig): void {
	const { bin, version, commands, summaries } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push("USAGE");
	lines.push(`  $ ${bin} [COMMAND]\n`);

	const defaultCmd = Array.from(commands.values()).find(C => C.hidden);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	type ListingRow = { name: string; description?: string; devTool?: boolean };
	const listing: ListingRow[] = summaries
		? Array.from(summaries.entries())
				.filter(([, s]) => !s.hidden)
				.map(([name, s]) => ({ name, description: s.description, devTool: s.devTool }))
		: Array.from(commands.entries())
				.filter(([, C]) => !C.hidden)
				.map(([name, C]) => ({ name, description: C.description, devTool: C.devTool }));
	const sections: Array<[string, ListingRow[]]> = [
		["COMMANDS", listing.filter(r => !r.devTool)],
		["DIAGNOSTIC COMMANDS", listing.filter(r => r.devTool)],
	];
	const width = helpWidth();
	const column = gutter(
		listing.map(r => `  ${r.name}`),
		width,
	);
	for (const [title, entries] of sections) {
		if (entries.length === 0) continue;
		lines.push(title);
		for (const row of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			pushWrapped(lines, `  ${row.name}`, row.description ?? "", column, width);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

function formatUsageArgs(Cmd: CommandCtor): string {
	const entries = Object.entries(Cmd.args ?? {});
	if (entries.length === 0) return "";
	const parts = entries.map(([name, desc]) => {
		const label = `${name.toUpperCase()}${desc.multiple ? "..." : ""}`;
		return desc.required ? label : `[${label}]`;
	});
	return ` ${parts.join(" ")}`;
}

/** Build the usage line for a command. */
export function commandUsageLine(bin: string, id: string, Cmd: CommandCtor): string {
	const hasFlags = Object.keys(Cmd.flags ?? {}).length > 0;
	return `$ ${bin} ${id}${formatUsageArgs(Cmd)}${hasFlags ? " [FLAGS]" : ""}`;
}

/** Render help for a single command. */
export function renderCommandHelp(bin: string, id: string, Cmd: CommandCtor): void {
	const lines: string[] = [];
	if (Cmd.description) lines.push(`${Cmd.description}\n`);
	lines.push("USAGE");
	lines.push(`  ${commandUsageLine(bin, id, Cmd)}\n`);
	renderCommandBody(lines, Cmd);
	process.stdout.write(lines.join("\n"));
}

function renderCommandBody(lines: string[], Cmd: CommandCtor): void {
	const argDefs = Cmd.args ?? {};
	const flagDefs = Cmd.flags ?? {};
	const width = helpWidth();

	const argEntries = Object.entries(argDefs);
	if (argEntries.length > 0) {
		lines.push("ARGUMENTS");
		const lefts = argEntries.map(([name]) => `  ${name.toUpperCase()}`);
		const column = gutter(lefts, width);
		for (const [index, [, desc]] of argEntries.entries()) {
			const parts: string[] = [];
			if (desc.description) parts.push(desc.description);
			if (desc.options) parts.push(`(${desc.options.slice().join("|")})`);
			pushWrapped(lines, lefts[index] ?? "", parts.join(" "), column, width);
		}
		lines.push("");
	}

	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length > 0) {
		lines.push("FLAGS");
		const formatted: [string, string][] = [];
		for (const [name, desc] of flagEntries) {
			const charPart = desc.char ? `-${desc.char}, ` : "    ";
			const aliasPart = (desc.aliases ?? []).map(alias => `, --${alias}`).join("");
			const namePart = `--${name}${aliasPart}`;
			const typePart =
				desc.kind === "boolean"
					? ""
					: desc.options
						? `=<${desc.options.slice().join("|")}>`
						: desc.kind === "integer"
							? "=<int>"
							: "=<value>";
			formatted.push([`  ${charPart}${namePart}${typePart}`, desc.description ?? ""]);
		}
		const column = gutter(
			formatted.map(([left]) => left),
			width,
		);
		for (const [left, right] of formatted) {
			pushWrapped(lines, left, right, column, width);
		}
		lines.push("");
	}

	if (Cmd.examples && Cmd.examples.length > 0) {
		lines.push("EXAMPLES");
		for (const ex of Cmd.examples) {
			for (const line of ex.split("\n")) {
				lines.push(`  ${line}`);
			}
		}
		lines.push("");
	}
}

/** Root-help listing metadata for a command. */
export interface CommandSummary {
	description?: string;
	hidden?: boolean;
	devTool?: boolean;
}

/** A lazily-loaded command entry. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
	summary?: CommandSummary;
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];
	help?: (config: CliConfig) => Promise<void> | void;
}

function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id));
}

function unknownCommandLine(commandId: string): string {
	return `Error: Unknown command '${commandId}'\n`;
}

/** Main CLI entry point. */
export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	if (commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "") {
		const config = await loadRootHelpConfig(opts);
		if (opts.help) {
			await opts.help(config);
		} else {
			renderRootHelp(config);
		}
		return;
	}

	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		const entry = findEntry(opts.commands, commandId);
		if (entry) {
			const Cmd = await loadEntry(entry);
			renderCommandHelp(bin, entry.name, Cmd);
		} else {
			process.stderr.write(unknownCommandLine(commandId));
			process.exitCode = CLI_EXIT_USAGE;
		}
		return;
	}

	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(unknownCommandLine(commandId));
		process.exitCode = CLI_EXIT_USAGE;
		return;
	}

	const Cmd = await loadEntry(entry);
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	try {
		await instance.run();
	} catch (error) {
		if (error instanceof CliUsageError) {
			process.stderr.write(`Error: ${error.message}\n\n`);
			process.stderr.write(`USAGE\n  ${commandUsageLine(bin, entry.name, Cmd)}\n`);
			process.stderr.write(`\nRun \`${bin} ${entry.name} --help\` for details.\n`);
			process.exitCode = CLI_EXIT_USAGE;
			return;
		}
		throw error;
	}
}

async function loadEntry(entry: CommandEntry): Promise<CommandCtor> {
	startupMarker(`cli:load:${entry.name}:start`);
	const Cmd = await entry.load();
	startupMarker(`cli:load:${entry.name}:done`);
	return Cmd;
}

async function loadRootHelpConfig(opts: RunOptions): Promise<CliConfig> {
	const summaries = new Map<string, CommandSummary>();
	for (const entry of opts.commands) {
		if (!entry.summary) return loadAllCommands(opts);
		summaries.set(entry.name, entry.summary);
	}

	const commands = new Map<string, CommandCtor>();
	const defaultEntry = opts.commands.find(e => e.summary?.hidden === true);
	if (defaultEntry) {
		commands.set(defaultEntry.name, await loadEntry(defaultEntry));
	}
	return { bin: opts.bin, version: opts.version, commands, summaries };
}

async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await loadEntry(e)] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
