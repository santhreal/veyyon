import { parseArgs as nodeParseArgs } from "node:util";
import { clampLow } from "./math";
import { startupMarker } from "./startup-marker";
import { errorMessage } from "./type-guards";

/**
 * A token that is a negative number rather than an option: `-1`, `-0.5`, `-1e-3`.
 * A short flag is a letter, so anything whose first character after the dash is a
 * digit or a decimal point cannot be one.
 */
const NEGATIVE_NUMBER = /^-(?:\d|\.\d)/;

/** Sentinel prefix for a masked negative number. Never valid user input. */
// Written as escapes, not literal NULs. A raw control byte in the source makes
// git classify this whole file as binary, which costs every reviewer the diff
// and makes a merge conflict here unresolvable by hand. The runtime value is
// identical.
const NEGATIVE_MASK = "\u0000neg\u0000";

interface ParsedArgs {
	values: Record<string, string | boolean | Array<string | boolean> | undefined>;
	positionals: string[];
}

/**
 * Replace negative-number tokens with sentinels so `node:util`'s parseArgs treats
 * them as ordinary words, and hand back the function that puts them where they
 * belong. Both halves of the result are restored: a negative number can arrive as
 * a positional (`config set presencePenalty -1`) or as a flag's value
 * (`--temperature -1`), and masking would otherwise leak the sentinel into one of
 * them.
 */
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

/**
 * A user-facing argument/flag validation failure. Thrown by {@link Command.parse}
 * for missing/invalid positionals and flags. The top-level {@link run} handler
 * prints its message plus the command usage line to stderr and exits 1, instead
 * of letting it bubble to the process-level catch — which would dump a minified
 * `dist/cli.js` code frame over a plain argument mistake (issue #5369).
 */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

// ---------------------------------------------------------------------------
// Flag & Arg descriptors
// ---------------------------------------------------------------------------

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
	/**
	 * Extra long names that mean the same flag. `--<alias>` parses into the
	 * canonical name and the help entry lists it beside that name.
	 *
	 * Declare an alias rather than a second flag whenever two spellings are one
	 * behaviour: two descriptors print two entries and imply they differ. This
	 * field used to be accepted and silently ignored, so `--yolo` was declared as
	 * an alias of `--auto-approve` with a comment claiming help would list it, and
	 * help never did.
	 */
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

/** Builders that match the `Flags.*()` / `Args.*()` API from oclif. */
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

// ---------------------------------------------------------------------------
// Parse result types — mirrors oclif's typed output from this.parse()
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command base class
// ---------------------------------------------------------------------------

export interface CommandCtor {
	new (argv: string[], config: CliConfig): Command;
	description?: string;
	hidden?: boolean;
	/** Diagnostic/dev tooling: listed under a separate DIAGNOSTIC COMMANDS help section. */
	devTool?: boolean;
	strict?: boolean;
	aliases?: string[];
	examples?: string[];
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
}

/** Configuration passed to every command instance and help renderers. */
export interface CliConfig {
	bin: string;
	version: string;
	/** All registered commands keyed by their canonical name. */
	commands: Map<string, CommandCtor>;
}

/** Minimal Command base matching the oclif surface we use. */
export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	/**
	 * Parse argv against the static `flags` and `args` declared on the
	 * concrete command class. Returns a typed `{ flags, args, argv }` object.
	 */
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

		// Build node:util parseArgs options from flag descriptors
		const options: Record<
			string,
			{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
		> = {};
		// Alias long name -> canonical long name. Registered as its own parseArgs
		// option (node:util has no alias concept) and folded back onto the
		// canonical name below, so a command reads one field no matter which
		// spelling the user typed.
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
		// Aliases register in a SECOND pass, after every canonical name exists.
		// Doing it inline would make the collision check depend on declaration
		// order: an alias declared before the flag it shadows would find nothing to
		// collide with and then be silently overwritten.
		for (const [name, desc] of Object.entries(flagDefs)) {
			for (const alias of desc.aliases ?? []) {
				if (options[alias]) {
					throw new Error(
						`Flag alias --${alias} on --${name} collides with an existing flag. ` +
							"Rename the alias or drop the duplicate declaration.",
					);
				}
				aliasToCanonical.set(alias, name);
				// The alias never carries the default: it would then look "provided"
				// on every run and win over the canonical name in the fold below.
				options[alias] = {
					type: options[name].type,
					...(options[name].multiple ? { multiple: true } : {}),
				};
			}
		}

		// strict=false when command declares args (positionals must pass through)
		// or when the command itself opts out
		const { values: rawValues, positionals } = (() => {
			// `node:util` parseArgs reads any leading `-` as an option, so a negative
			// number is rejected as an unknown short flag: `veyyon config set
			// presencePenalty -1` failed on a value the setting accepts, and the only
			// way through was the `-- "-1"` escape. Negative numbers are hidden behind
			// a sentinel for the parse and restored after, so they arrive as the value
			// they are while unknown-flag detection stays strict for everything else.
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

		// Fold an alias onto its canonical name before typing and validation, so
		// every check below (options constraint, required, integer parse) applies
		// to the alias exactly as it would to the canonical spelling. The canonical
		// name wins when both were given: a user who wrote both meant the one the
		// command actually reads, and picking the alias would be surprising.
		for (const [alias, canonical] of aliasToCanonical) {
			const aliasValue = rawValues[alias];
			if (aliasValue !== undefined && rawValues[canonical] === undefined) {
				rawValues[canonical] = aliasValue;
			}
		}

		// Convert raw values to proper types and validate
		const flags: Record<string, unknown> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const raw = rawValues[name];
			if (desc.kind === "integer") {
				if (raw === undefined || typeof raw === "boolean") {
					flags[name] = desc.default ?? undefined;
				} else {
					const n = Number.parseInt(raw as string, 10);
					if (Number.isNaN(n)) {
						throw new CliUsageError(`Expected integer for --${name}, got "${raw}"`);
					}
					flags[name] = n;
				}
			} else if (desc.kind === "boolean") {
				flags[name] =
					raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
			} else {
				// string
				const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
				// Validate options constraint
				if (val !== undefined && desc.options && !Array.isArray(val)) {
					if (!desc.options.includes(val as string)) {
						throw new CliUsageError(
							`Expected --${name} to be one of: ${[...desc.options].join(", ")}; got "${val}"`,
						);
					}
				}
				flags[name] = val;
			}
			// Validate required
			if (desc.required && flags[name] === undefined) {
				throw new CliUsageError(`Missing required flag: --${name}`);
			}
		}

		// Map positionals to named args in declaration order and validate
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
			// Validate required
			if (desc.required && args[argName] === undefined) {
				throw new CliUsageError(`Missing required argument: ${argName}`);
			}
			// Validate options constraint
			const argVal = args[argName];
			if (argVal !== undefined && desc.options && typeof argVal === "string") {
				if (!desc.options.includes(argVal)) {
					throw new CliUsageError(
						`Expected ${argName} to be one of: ${[...desc.options].join(", ")}; got "${argVal}"`,
					);
				}
			}
		}

		// Reject positionals that no declared arg consumed. Silently dropping them
		// lets an intuitive-but-wrong invocation run with a wider scope than the
		// user wrote — `usage invalidate anthropic` swallows `anthropic` and
		// invalidates every provider at exit 0 — so fail closed and name the stray
		// token instead (Law 10: no silent fallbacks). A command that means to take
		// arbitrary trailing positionals declares a `multiple` arg, which consumes
		// them here and never reaches this check.
		if (posIdx < positionals.length) {
			const stray = positionals.slice(posIdx);
			const label = stray.length === 1 ? "argument" : "arguments";
			throw new CliUsageError(`Unexpected ${label}: ${stray.map(token => `"${token}"`).join(", ")}`);
		}

		return { flags, args, argv: positionals } as never;
	}
}

/**
 * Split a command-argument string on whitespace, honoring double quotes and
 * backslash escapes: `add "phase one" x` → ["add", "phase one", "x"].
 */
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

// ---------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------

/**
 * Terminal width to lay help out for, clamped to something a human reads.
 *
 * Help used to be laid out for an infinite terminal: it padded to the widest entry and never
 * wrapped, so `veyyon --help` emitted 85 lines past 80 columns with a 221-character worst case, and
 * every one of those was re-wrapped by the terminal at an arbitrary point with no indent. The lower
 * bound keeps a narrow split pane from collapsing the description column to nothing; the upper one
 * stops a maximized window from producing lines too long to track back to their flag.
 */
function helpWidth(): number {
	const columns = process.stdout.columns;
	if (typeof columns === "number" && columns > 0) return clampLow(columns, 60, 100);
	// Not a TTY, so stdout reports no width. That is not the same as no width being KNOWN: piping
	// help into a pager or `less -R` is the normal way to read a long one, and the shell still
	// exports the real terminal size in COLUMNS. Consulting stdout alone laid out for 80 columns
	// inside a 60-column pane and put 113 lines past the edge, which is the wrapping bug again by a
	// different route. A junk COLUMNS falls through to the conventional 80 rather than being clamped
	// into range, since a nonsense value is no evidence of width.
	const exported = Number(process.env.COLUMNS);
	if (Number.isFinite(exported) && exported > 0) return clampLow(exported, 60, 100);
	return 80;
}

/**
 * The widest left column worth aligning to, given the terminal.
 *
 * ALIGNING TO THE LONGEST ENTRY IS THE BUG. One flag spelling out an enum
 * (`--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>`, 58 characters) set the gutter for
 * all seventy-odd, so every description started past column 62 and had roughly fifteen usable
 * columns left. A single outlier decided the layout for everything around it.
 *
 * So the gutter is capped at a third of the width. Entries within it still align, which is what
 * makes a flag list scannable; the few that overflow put their description on the next line instead
 * of dragging the column right. Trading alignment for one entry beats losing the column for all.
 */
function gutter(entries: readonly string[], width: number): number {
	// `Bun.stringWidth`, never `.length`: a styled entry carries escape bytes that occupy no columns.
	const longest = entries.length > 0 ? Math.max(...entries.map(entry => Bun.stringWidth(entry))) : 0;
	return Math.min(longest + 2, Math.floor(width / 3));
}

/**
 * Emit `left` and its description, wrapped, with continuation lines under the description.
 *
 * A wrapped description that returns to column 0 reads as a new entry, so the indent is what keeps
 * a two-line flag from looking like two flags. `Bun.wrapAnsi` is the repo's wrapper and is correct
 * for wide characters, which matters here because a description may quote a model id or a path.
 */
function pushWrapped(lines: string[], left: string, description: string, column: number, width: number): void {
	if (!description) {
		lines.push(left);
		return;
	}
	// An entry that would leave less than this before its description goes on its own line instead.
	// `>` alone was not enough: a name exactly as wide as the gutter padded to zero and produced
	// `ANTHROPIC_CUSTOM_HEADERSExtra headers ...`, one run-on token with no boundary at all.
	const MIN_GAP = 2;
	// Measured, not `.length`, so a styled left column pads to the right screen position.
	const leftWidth = Bun.stringWidth(left);
	const indent = " ".repeat(column);
	// `trim: true` matters twice: without it a wrapped line keeps the space it broke on, so every
	// continuation is indented one column too far AND every line carries invisible trailing bytes.
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

/**
 * Lay out a two-column help table so it fits the terminal, wrapping the right column.
 *
 * Exported because the same table is built by hand elsewhere. `getExtraHelpText` in the coding
 * agent held an eighty-five line environment-variable table with its gutter typed into every row as
 * literal spaces, three different gutters across its sections, and no wrapping at all, so the widest
 * row ran to 129 columns and the terminal re-broke it wherever it liked. A padded string cannot
 * respond to a terminal width; a table of rows can, and there is now one place that knows how.
 *
 * Widths go through `Bun.stringWidth`, not `.length`, because a caller may style the left column and
 * an escape sequence occupies no columns on screen while counting as characters in a string.
 */
export function renderHelpTable(
	rows: ReadonlyArray<readonly [name: string, description: string]>,
	options: { indent?: string } = {},
): string[] {
	const indent = options.indent ?? "  ";
	const width = helpWidth();
	const lefts = rows.map(([name]) => `${indent}${name}`);
	const column = gutter(lefts, width);
	const lines: string[] = [];
	for (const [index, [, description]] of rows.entries()) {
		pushWrapped(lines, lefts[index] ?? "", description, column, width);
	}
	return lines;
}

/**
 * Wrap a paragraph of help prose to the terminal, at a given indent.
 *
 * Prose interleaved into a table is how the environment section became unreadable: three sentences
 * about profile resolution sat between two variable rows, aligned as though they were rows, so the
 * eye read them as a variable with a very long name. Prose gets its own shape.
 */
export function renderHelpParagraph(text: string, options: { indent?: string } = {}): string[] {
	const indent = options.indent ?? "  ";
	const width = helpWidth();
	const usable = Math.max(20, width - Bun.stringWidth(indent));
	return Bun.wrapAnsi(text, usable, { trim: true })
		.split("\n")
		.map(line => `${indent}${line}`);
}

/** Render full root help: header, default command details, subcommand list. */
export function renderRootHelp(config: CliConfig): void {
	const { bin, version, commands } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push("USAGE");
	lines.push(`  $ ${bin} [COMMAND]\n`);

	// Show the default command's flags/args/examples inline.
	// The default command is the one marked hidden (it's the implicit entry point).
	const defaultCmd = [...commands.values()].find(C => C.hidden);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	// List visible subcommands; diagnostic/dev tools get their own section so the
	// main list reads as the product surface.
	const visible = [...commands.entries()].filter(([, C]) => !C.hidden);
	const sections: Array<[string, typeof visible]> = [
		["COMMANDS", visible.filter(([, C]) => !C.devTool)],
		["DIAGNOSTIC COMMANDS", visible.filter(([, C]) => C.devTool)],
	];
	const width = helpWidth();
	const column = gutter(
		visible.map(([name]) => `  ${name}`),
		width,
	);
	for (const [title, entries] of sections) {
		if (entries.length === 0) continue;
		lines.push(title);
		for (const [name, C] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
			pushWrapped(lines, `  ${name}`, C.description ?? "", column, width);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

/**
 * Format a command's positional args for a USAGE line. Required args render
 * bare (`MODELS`), optional args wrapped in brackets (`[MODELS]`), and
 * `multiple` args get a trailing ellipsis (`MODELS...`) so a required
 * variadic reads as `MODELS...`, not the misleading optional `[MODELS]`.
 */
function formatUsageArgs(Cmd: CommandCtor): string {
	const entries = Object.entries(Cmd.args ?? {});
	if (entries.length === 0) return "";
	const parts = entries.map(([name, desc]) => {
		const label = `${name.toUpperCase()}${desc.multiple ? "..." : ""}`;
		return desc.required ? label : `[${label}]`;
	});
	return ` ${parts.join(" ")}`;
}

/** Build the single USAGE line for a command (without the leading label). */
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

	// Arguments
	const argEntries = Object.entries(argDefs);
	if (argEntries.length > 0) {
		lines.push("ARGUMENTS");
		const lefts = argEntries.map(([name]) => `  ${name.toUpperCase()}`);
		const column = gutter(lefts, width);
		for (const [index, [, desc]] of argEntries.entries()) {
			const parts: string[] = [];
			if (desc.description) parts.push(desc.description);
			if (desc.options) parts.push(`(${[...desc.options].join("|")})`);
			pushWrapped(lines, lefts[index] ?? "", parts.join(" "), column, width);
		}
		lines.push("");
	}

	// Flags
	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length > 0) {
		lines.push("FLAGS");
		const formatted: [string, string][] = [];
		for (const [name, desc] of flagEntries) {
			const charPart = desc.char ? `-${desc.char}, ` : "    ";
			// Aliases share the canonical entry rather than getting one of their own:
			// two entries for one behaviour reads as two behaviours.
			const aliasPart = (desc.aliases ?? []).map(alias => `, --${alias}`).join("");
			const namePart = `--${name}${aliasPart}`;
			// Enum-constrained flags render their accepted values like args do —
			// values that only surface as a parse error are invisible until guessed.
			const typePart =
				desc.kind === "boolean"
					? ""
					: desc.options
						? `=<${[...desc.options].join("|")}>`
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

	// Examples
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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** A lazily-loaded command: canonical name, loader, and optional aliases. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];
	/** Custom help renderer. Receives fully-populated config. */
	help?: (config: CliConfig) => Promise<void> | void;
}

/** Find a command entry by exact name or alias. */
function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id));
}

/** Single source for the unknown-command message so every dispatch path agrees. */
function unknownCommandLine(commandId: string): string {
	return `Error: Unknown command '${commandId}'\n`;
}

/**
 * Main entry point — replaces `run()` from @oclif/core.
 *
 * Each command is explicitly registered with a lazy loader.
 * No filesystem scanning, no plugin system, no package.json reading.
 */
export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	// Top-level help
	if (commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "") {
		const config = await loadAllCommands(opts);
		if (opts.help) {
			await opts.help(config);
		} else {
			renderRootHelp(config);
		}
		return;
	}

	// Version
	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	// Per-command help: load only the requested command. Loading the full
	// command table here would make `veyyon <cmd> --help` hang or crash whenever
	// any *unrelated* command module misbehaves at import time.
	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		const entry = findEntry(opts.commands, commandId);
		if (entry) {
			const Cmd = await loadEntry(entry);
			renderCommandHelp(bin, entry.name, Cmd);
		} else {
			// An unknown command is an error on the help path too: exit non-zero so
			// `veyyon <typo> --help` matches `veyyon <typo>` (both exit 1) instead of
			// reporting the typo as success.
			process.stderr.write(unknownCommandLine(commandId));
			process.exitCode = 1;
		}
		return;
	}

	// Find command by name or alias
	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(unknownCommandLine(commandId));
		process.exitCode = 1;
		return;
	}

	const Cmd = await loadEntry(entry);
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	try {
		await instance.run();
	} catch (error) {
		// A usage mistake (missing/invalid arg or flag) is not a crash: print the
		// message and the command's usage line, then exit 1. Letting it reach the
		// process-level catch would dump a minified `dist/cli.js` code frame over a
		// plain argument error (issue #5369).
		if (error instanceof CliUsageError) {
			process.stderr.write(`Error: ${error.message}\n\n`);
			process.stderr.write(`USAGE\n  ${commandUsageLine(bin, entry.name, Cmd)}\n`);
			process.stderr.write(`\nRun \`${bin} ${entry.name} --help\` for details.\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
}

/** Load one command module, leaving streaming markers around the import. */
async function loadEntry(entry: CommandEntry): Promise<CommandCtor> {
	startupMarker(`cli:load:${entry.name}:start`);
	const Cmd = await entry.load();
	startupMarker(`cli:load:${entry.name}:done`);
	return Cmd;
}

/** Resolve all command loaders for help/alias display. */
async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await loadEntry(e)] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
