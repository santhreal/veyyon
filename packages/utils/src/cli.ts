import { parseArgs as nodeParseArgs } from "node:util";
import { CliUsageError } from "./cli-usage-error";
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
 * The status a command-line mistake exits with, following the conventional Unix
 * meaning of `2`: the invocation was wrong, so nothing ran and an identical retry
 * cannot help.
 *
 * `packages/coding-agent/src/cli/exit-codes.ts` declares the same number as
 * `EXIT_USAGE` rather than importing this one, because that module sits on
 * `cli.ts`'s static boot graph and this one does not: `the-boot-path-stays-thin`
 * caps that graph, and a boot-path module edge for a single integer is not worth
 * the parse on every `veyyon --version`. The two are held equal by an assertion
 * in `packages/coding-agent/test/cli/exit-codes.test.ts`, which is what stops
 * them drifting.
 */
export const CLI_EXIT_USAGE = 2;

/**
 * {@link Command.parse} throws a {@link CliUsageError} for a missing or invalid positional or
 * flag; the top-level {@link run} handler exits {@link CLI_EXIT_USAGE} on one. The class is
 * `./cli-usage-error`, a leaf a CLI entry catches without loading this module.
 */
export { CliUsageError } from "./cli-usage-error";

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
	/**
	 * Listing metadata for the FULL registry, present when root help was
	 * rendered from the command table without loading every module. The
	 * `commands` map may then hold only the default command. Absent when the
	 * config was built by loading everything.
	 */
	summaries?: Map<string, CommandSummary>;
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
		const { options, aliasToCanonical } = parseOptions(flagDefs);
		const { values: rawValues, positionals } = parseArgv(this.argv, options, Cmd.strict !== false);
		// Fold an alias onto its canonical name before typing and validation, so
		// every check in typedFlags (options constraint, required, integer parse)
		// applies to the alias exactly as it would to the canonical spelling. The
		// canonical name wins when both were given: a user who wrote both meant the
		// one the command reads, and picking the alias would be surprising.
		for (const [alias, canonical] of aliasToCanonical) {
			const aliasValue = rawValues[alias];
			if (aliasValue !== undefined && rawValues[canonical] === undefined) {
				rawValues[canonical] = aliasValue;
			}
		}
		const flags = typedFlags(flagDefs, rawValues);
		const args = namedArgs(argDefs, positionals);
		return { flags, args, argv: positionals } as never;
	}
}

/** One `node:util` parseArgs option, built from a {@link FlagDescriptor}. */
interface ParseOption {
	type: "string" | "boolean";
	short?: string;
	multiple?: boolean;
	default?: string | boolean;
}

/**
 * The parseArgs options for `flagDefs`, one per flag and one per alias, and the
 * canonical name of each alias. node:util has no alias concept, so an alias is
 * its own option, folded back onto the canonical name after the parse.
 */
function parseOptions(flagDefs: Record<string, FlagDescriptor>): {
	options: Record<string, ParseOption>;
	aliasToCanonical: Map<string, string>;
} {
	const options: Record<string, ParseOption> = {};
	for (const [name, desc] of Object.entries(flagDefs)) options[name] = parseOption(desc);
	// Aliases register in a SECOND pass, after every canonical name exists.
	// Doing it inline would make the collision check depend on declaration
	// order: an alias declared before the flag it shadows would find nothing to
	// collide with and then be silently overwritten.
	const aliasToCanonical = new Map<string, string>();
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
			// on every run and win over the canonical name in the fold.
			options[alias] = {
				type: options[name].type,
				...(options[name].multiple ? { multiple: true } : {}),
			};
		}
	}
	return { options, aliasToCanonical };
}

/** The parseArgs option of one flag: its value type, short name, repetition and default. */
function parseOption(desc: FlagDescriptor): ParseOption {
	const opt: ParseOption = { type: desc.kind === "boolean" ? "boolean" : "string" };
	if (desc.char) opt.short = desc.char;
	if (desc.multiple) opt.multiple = true;
	if (desc.default !== undefined) {
		opt.default = desc.kind === "boolean" ? Boolean(desc.default) : String(desc.default);
	}
	return opt;
}

/**
 * `argv` parsed against `options`, with a parse failure thrown as a {@link CliUsageError}.
 *
 * `node:util` parseArgs reads any leading `-` as an option, so a negative number is rejected as
 * an unknown short flag: `veyyon config set presencePenalty -1` failed on a value the setting
 * accepts, and the only way through was the `-- "-1"` escape. Negative numbers are hidden behind a
 * sentinel for the parse and restored after, so they arrive as the value they are while
 * unknown-flag detection stays strict for everything else.
 */
function parseArgv(argv: readonly string[], options: Record<string, ParseOption>, strict: boolean): ParsedArgs {
	const { args, restore } = maskNegativeNumbers(argv);
	try {
		return restore(nodeParseArgs({ args, options, allowPositionals: true, strict }));
	} catch (error) {
		throw new CliUsageError(errorMessage(error));
	}
}

/** Each flag of `flagDefs` typed from its raw parsed value, validated in declaration order. */
function typedFlags(
	flagDefs: Record<string, FlagDescriptor>,
	rawValues: ParsedArgs["values"],
): Record<string, unknown> {
	const flags: Record<string, unknown> = {};
	for (const [name, desc] of Object.entries(flagDefs)) {
		const value = flagValue(name, desc, rawValues[name]);
		if (desc.required && value === undefined) {
			throw new CliUsageError(`Missing required flag: --${name}`);
		}
		flags[name] = value;
	}
	return flags;
}

/** The typed value of flag `--name` from its raw parsed value, or its default. */
function flagValue(name: string, desc: FlagDescriptor, raw: ParsedArgs["values"][string]): unknown {
	if (desc.kind === "boolean") {
		return raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
	}
	if (desc.kind === "integer") return integerFlag(name, desc, raw);
	const value = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
	if (value !== undefined && desc.options && !Array.isArray(value)) assertOneOf(`--${name}`, desc.options, value);
	return value;
}

/** The integer value of flag `--name`, or its default when it was not given a value. */
function integerFlag(name: string, desc: FlagDescriptor, raw: ParsedArgs["values"][string]): unknown {
	if (raw === undefined || typeof raw === "boolean") return desc.default ?? undefined;
	const n = Number.parseInt(raw as string, 10);
	if (Number.isNaN(n)) {
		throw new CliUsageError(`Expected integer for --${name}, got "${raw}"`);
	}
	return n;
}

/**
 * `positionals` mapped to the args of `argDefs` in declaration order and validated. A `multiple`
 * arg takes every positional left.
 *
 * A positional that no declared arg consumed is rejected. Silently dropping it lets an
 * intuitive-but-wrong invocation run with a wider scope than the user wrote — `usage invalidate
 * anthropic` swallows `anthropic` and invalidates every provider at exit 0 — so fail closed and name
 * the stray token instead (Law 10: no silent fallbacks). A command that means to take arbitrary
 * trailing positionals declares a `multiple` arg, which consumes them.
 */
function namedArgs(argDefs: Record<string, ArgDescriptor>, positionals: readonly string[]): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let posIdx = 0;
	for (const [argName, desc] of Object.entries(argDefs)) {
		let value: string | string[] | undefined;
		if (desc.multiple) {
			const rest = positionals.slice(posIdx);
			value = rest.length > 0 ? rest : undefined;
			posIdx = positionals.length;
		} else {
			value = positionals[posIdx];
			posIdx++;
		}
		args[argName] = value;
		if (desc.required && value === undefined) {
			throw new CliUsageError(`Missing required argument: ${argName}`);
		}
		if (desc.options && typeof value === "string") assertOneOf(argName, desc.options, value);
	}
	if (posIdx < positionals.length) {
		const stray = positionals.slice(posIdx);
		const label = stray.length === 1 ? "argument" : "arguments";
		throw new CliUsageError(`Unexpected ${label}: ${stray.map(token => `"${token}"`).join(", ")}`);
	}
	return args;
}

/** Throws the usage error for a `value` of `label` outside the `options` it accepts. */
function assertOneOf(label: string, options: readonly string[], value: unknown): void {
	if (!options.includes(value as string)) {
		throw new CliUsageError(`Expected ${label} to be one of: ${options.slice().join(", ")}; got "${value}"`);
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
 * How much of the terminal the left column may take when the caller does not say.
 *
 * One owner, defaulted on `gutter` itself rather than at each call site. It was briefly defaulted
 * in `renderHelpTable` instead, which left `renderRootHelp`'s direct `gutter` call passing nothing
 * for a required parameter: `width * undefined` is `NaN`, `Math.min(n, NaN)` is `NaN`, and the pad
 * silently collapsed to zero, printing `grepRun the grep tool standalone...` with no gap at all.
 * A layout constant with two homes is a layout constant with one stale home.
 */
const DEFAULT_GUTTER_FRACTION = 1 / 3;

/**
 * The widest left column worth aligning to, given the terminal.
 *
 * ALIGNING TO THE LONGEST ENTRY IS THE BUG. One flag spelling out an enum
 * (`--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>`, 58 characters) set the gutter for
 * all seventy-odd, so every description started past column 62 and had roughly fifteen usable
 * columns left. A single outlier decided the layout for everything around it.
 *
 * So the gutter is capped. Entries within it still align, which is what makes a flag list
 * scannable; the few that overflow put their description on the next line instead of dragging the
 * column right. Trading alignment for one entry beats losing the column for all.
 *
 * `maxFraction` is how much of the width that cap may take, and it is a parameter because the right
 * answer depends on what the left column IS. For flags a third is generous: the name is short and
 * the description is the content. For `veyyon config list` the left column is a dotted setting path
 * that legitimately runs to thirty characters, so a third pushed a four-character value like `true`
 * onto its own line and grew the listing from 470 lines to 714 for no gain in readability.
 */
function gutter(entries: readonly string[], width: number, maxFraction: number = DEFAULT_GUTTER_FRACTION): number {
	// `Bun.stringWidth`, never `.length`: a styled entry carries escape bytes that occupy no columns.
	const longest = entries.length > 0 ? Math.max(...entries.map(entry => Bun.stringWidth(entry))) : 0;
	return Math.min(longest + 2, Math.floor(width * maxFraction));
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
	options: { indent?: string; maxGutterFraction?: number } = {},
): string[] {
	const indent = options.indent ?? "  ";
	const width = helpWidth();
	const lefts = rows.map(([name]) => `${indent}${name}`);
	// The default lives on `gutter`; a caller whose left column is inherently longer (a dotted
	// setting path) raises it rather than reimplementing the layout. See the note there.
	const column = gutter(lefts, width, options.maxGutterFraction);
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
	const { bin, version, commands, summaries } = config;
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
	// main list reads as the product surface. Rows come from the registry
	// summaries when the config was built without loading every module, and
	// from the loaded statics otherwise — both describe the same classes.
	type ListingRow = { name: string; description?: string; devTool?: boolean };
	const listing: ListingRow[] = summaries
		? [...summaries.entries()]
				.filter(([, s]) => !s.hidden)
				.map(([name, s]) => ({ name, description: s.description, devTool: s.devTool }))
		: [...commands.entries()]
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
	const width = helpWidth();
	pushArgumentsSection(lines, Cmd.args ?? {}, width);
	pushFlagsSection(lines, Cmd.flags ?? {}, width);
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

/** The ARGUMENTS section: each arg's name, description and accepted values. Nothing for no args. */
function pushArgumentsSection(lines: string[], argDefs: Record<string, ArgDescriptor>, width: number): void {
	const argEntries = Object.entries(argDefs);
	if (argEntries.length === 0) return;
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

/** The FLAGS section: each flag's spellings and value shape, then its description. Nothing for no flags. */
function pushFlagsSection(lines: string[], flagDefs: Record<string, FlagDescriptor>, width: number): void {
	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length === 0) return;
	lines.push("FLAGS");
	const formatted = flagEntries.map(([name, desc]) => [flagHelpLeft(name, desc), desc.description ?? ""] as const);
	const column = gutter(
		formatted.map(([left]) => left),
		width,
	);
	for (const [left, right] of formatted) {
		pushWrapped(lines, left, right, column, width);
	}
	lines.push("");
}

/** A flag's help entry: its short name, its long name and aliases, and the value it takes. */
function flagHelpLeft(name: string, desc: FlagDescriptor): string {
	const charPart = desc.char ? `-${desc.char}, ` : "    ";
	// Aliases share the canonical entry rather than getting one of their own:
	// two entries for one behaviour reads as two behaviours.
	const aliasPart = (desc.aliases ?? []).map(alias => `, --${alias}`).join("");
	// Enum-constrained flags render their accepted values like args do —
	// values that only surface as a parse error are invisible until guessed.
	const typePart =
		desc.kind === "boolean"
			? ""
			: desc.options
				? `=<${desc.options.slice().join("|")}>`
				: desc.kind === "integer"
					? "=<int>"
					: "=<value>";
	return `  ${charPart}--${name}${aliasPart}${typePart}`;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** Root-help listing metadata for a command, mirrored from the class statics. */
export interface CommandSummary {
	description?: string;
	hidden?: boolean;
	/** Diagnostic/dev tooling: listed under a separate DIAGNOSTIC COMMANDS help section. */
	devTool?: boolean;
}

/** A lazily-loaded command: canonical name, loader, and optional aliases. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
	/**
	 * Listing metadata copied from the loaded class's statics. When EVERY entry
	 * in the registry carries one, root help renders from the table and loads
	 * only the default (hidden) command — on a large registry this removes most
	 * of `veyyon --help`'s module-load cost. A parity test in each product pins
	 * the copy against the real statics so it cannot drift.
	 */
	summary?: CommandSummary;
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
		const config = await loadRootHelpConfig(opts);
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
			// `veyyon <typo> --help` matches `veyyon <typo>` instead of reporting the
			// typo as success. Both are CLI_EXIT_USAGE, because a command name that
			// does not exist is a command line that cannot succeed on a retry.
			process.stderr.write(unknownCommandLine(commandId));
			process.exitCode = CLI_EXIT_USAGE;
		}
		return;
	}

	// Find command by name or alias
	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(unknownCommandLine(commandId));
		process.exitCode = CLI_EXIT_USAGE;
		return;
	}

	await runCommand(bin, version, entry, commandArgv);
}

/**
 * Load `entry` and run its command on `argv`. A usage mistake (missing/invalid arg or flag) is not
 * a crash: it prints the message and the command's usage line and exits CLI_EXIT_USAGE. Letting it
 * reach the process-level catch would dump a minified `dist/cli.js` code frame over a plain
 * argument error (issue #5369).
 *
 * The status is 2, not 1, because a subcommand's command line is still a command line: `veyyon
 * --nope` and `veyyon config --nope` are the same mistake, and the published exit-code table
 * promises 2 for "an unrecognized flag, a bad flag value". Returning 1 here split one mistake down
 * the middle and told a wrapper script that retrying might help.
 */
async function runCommand(bin: string, version: string, entry: CommandEntry, argv: string[]): Promise<void> {
	const Cmd = await loadEntry(entry);
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(argv, config);
	try {
		await instance.run();
	} catch (error) {
		if (!(error instanceof CliUsageError)) throw error;
		process.stderr.write(`Error: ${error.message}\n\n`);
		process.stderr.write(`USAGE\n  ${commandUsageLine(bin, entry.name, Cmd)}\n`);
		process.stderr.write(`\nRun \`${bin} ${entry.name} --help\` for details.\n`);
		process.exitCode = CLI_EXIT_USAGE;
	}
}

/** Load one command module, leaving streaming markers around the import. */
async function loadEntry(entry: CommandEntry): Promise<CommandCtor> {
	startupMarker(`cli:load:${entry.name}:start`);
	const Cmd = await entry.load();
	startupMarker(`cli:load:${entry.name}:done`);
	return Cmd;
}

/**
 * Build the config for ROOT help. Root help lists every command's name and
 * one-line description, plus the default (hidden) command's full flag table.
 * When every registry entry carries a `summary`, the listing renders from the
 * table and ONLY the default command's module loads — on a large registry
 * this is most of `veyyon --help`'s cost. Any entry without a summary falls
 * back to loading everything, so an unsummarized command degrades the help
 * path instead of misrendering it.
 */
async function loadRootHelpConfig(opts: RunOptions): Promise<CliConfig> {
	const summaries = new Map<string, CommandSummary>();
	for (const entry of opts.commands) {
		// One unsummarized command degrades the help path to loading everything
		// rather than rendering a listing that is missing a row.
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

/** Resolve all command loaders for help/alias display. */
async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await loadEntry(e)] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
