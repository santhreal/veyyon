import { describe, expect, it } from "bun:test";
import { getExtraHelpText } from "@veyyon/coding-agent/cli/args";
import { OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS, VALUELESS_FLAGS } from "@veyyon/coding-agent/cli/flag-tables";
import LaunchCommand from "@veyyon/coding-agent/commands/launch";
import { BUILTIN_TOOL_NAMES, isKnownToolName } from "@veyyon/coding-agent/tools/builtin-names";
import type { FlagDescriptor } from "@veyyon/utils/cli";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

/**
 * Every flag the launcher accepts must appear in `--help`, and every flag
 * `--help` advertises must be accepted.
 *
 * WHY THIS SUITE EXISTS (OUT-5). The launch surface has TWO flag definitions,
 * and they are not derived from each other:
 *
 *   - `cli/flag-tables.ts` decides what `parseArgs` ACCEPTS. It has to exist
 *     separately because the profile bootstrap consults it before the command
 *     modules can be imported at all.
 *   - `commands/launch.ts` `static flags` decides what `--help` PRINTS, because
 *     the CLI framework generates the FLAGS section straight from that table.
 *
 * Two tables, no compiler relationship, so they drift the moment someone adds a
 * setter without adding a descriptor. When this suite was written they had, and
 * seven working flags were invisible in help: `--fork`, `--session`,
 * `--subagent-model`, `--compaction-model`, `--plugin-dir`,
 * `--provider-session-id`, and `--prompt-cache-key`. An undocumented flag is not
 * a cosmetic problem. Nobody can use a capability they cannot discover, and
 * `--fork` in particular is the only non-destructive way to branch a session:
 * without it in help, the reachable answer is `--resume`, which writes into the
 * original.
 *
 * The check runs in BOTH directions on purpose. A one-way check would let the
 * opposite drift through, and help that lists a flag the parser rejects is the
 * worse failure of the two: the user follows the documentation and gets an
 * error.
 *
 * The reconciliation is asserted as an exact SET rather than a count, so the
 * failure message names the offending flag instead of saying a number moved.
 */

/** Flags the CLI framework implements itself; no command declares them. */
const FRAMEWORK_FLAGS = new Set(["--help", "--version"]);

/**
 * Flags consumed by the profile bootstrap BEFORE the launch parser runs.
 *
 * `--profile` and `--alias` choose which agent directory the process reads, so
 * they must be resolved before anything that touches settings is imported.
 * `extractProfileFlags` in `cli/profile-bootstrap.ts` strips them from argv, so
 * they never reach `flag-tables.ts` and would otherwise read as documented but
 * unparsed.
 */
const BOOTSTRAP_FLAGS = new Set(["--profile", "--alias"]);

/** Every flag `parseArgs` will accept, long forms and short forms alike. */
function parsedFlags(): Set<string> {
	const flags = new Set<string>([...STRING_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...VALUELESS_FLAGS]);
	for (const framework of FRAMEWORK_FLAGS) flags.delete(framework);
	return flags;
}

/**
 * The launch flag table read as a plain record. The declaration is a wide
 * literal type (fifty-odd distinct descriptor shapes), which cannot be indexed
 * by a computed name; every check here is about the table as data, not about any
 * one flag's static type.
 */
function launchFlags(): Record<string, FlagDescriptor> {
	return (LaunchCommand.flags ?? {}) as Record<string, FlagDescriptor>;
}

/** Every flag `--help` advertises: canonical names, aliases, and short chars. */
function documentedFlags(): Set<string> {
	const flags = new Set<string>();
	for (const [name, descriptor] of Object.entries(launchFlags())) {
		flags.add(`--${name}`);
		for (const alias of descriptor.aliases ?? []) flags.add(`--${alias}`);
		if (descriptor.char) flags.add(`-${descriptor.char}`);
	}
	return flags;
}

describe("the launch parser and its help agree on the flag list", () => {
	/**
	 * THE REGRESSION. A flag with a setter but no descriptor is accepted and
	 * invisible, which is how seven of them accumulated.
	 */
	it("documents every flag the parser accepts", () => {
		const documented = documentedFlags();
		const undocumented = [...parsedFlags()].filter(flag => !documented.has(flag)).sort();

		expect(undocumented).toEqual([]);
	});

	/**
	 * THE OTHER DIRECTION, and the worse failure: a user reads help, types the
	 * flag, and gets an error. Only the bootstrap-consumed flags are exempt, and
	 * they are named individually rather than pattern-matched so a third one
	 * cannot slip in behind the exemption.
	 */
	it("accepts every flag the help advertises", () => {
		const parsed = parsedFlags();
		const unparsed = [...documentedFlags()].filter(flag => !parsed.has(flag) && !BOOTSTRAP_FLAGS.has(flag)).sort();

		expect(unparsed).toEqual([]);
	});

	/**
	 * The exemption list is itself checked. If `--profile` ever gains an ordinary
	 * setter, the exemption becomes a lie that hides real drift, and this is what
	 * says so.
	 */
	it("keeps the bootstrap flags out of the ordinary parser tables", () => {
		const parsed = parsedFlags();
		for (const flag of BOOTSTRAP_FLAGS) expect(parsed.has(flag)).toBe(false);
	});
});

describe("the flags that were missing are named in help", () => {
	/**
	 * Each of the seven is asserted by name with a real description, not merely
	 * by presence in the set. A descriptor added with an empty description would
	 * satisfy the reconciliation above while still telling a reader nothing.
	 */
	it.each([
		["fork", "branching a session without writing to the original"],
		["session", "the alias of --resume"],
		["subagent-model", "the model subagents run on"],
		["compaction-model", "the model that summarizes on compaction"],
		["plugin-dir", "an extra plugin discovery root"],
		["provider-session-id", "reusing a provider-side session"],
		["prompt-cache-key", "an explicit provider cache key"],
	])("describes --%s (%s)", flagName => {
		const flags = launchFlags();
		const descriptor = flags[flagName] ?? Object.values(flags).find(f => (f.aliases ?? []).includes(flagName));

		expect(descriptor).toBeDefined();
		expect(descriptor?.description?.trim().length ?? 0).toBeGreaterThan(10);
	});

	/**
	 * `--session` is an ALIAS of `--resume`, not a second flag. Declaring it as
	 * its own descriptor would print two entries for one behaviour and imply they
	 * differ.
	 */
	it("declares --session as an alias of --resume rather than a separate flag", () => {
		const flags = launchFlags();

		expect(flags.session).toBeUndefined();
		expect(flags.resume?.aliases).toContain("session");
	});
});

describe("every documented flag carries a usable description", () => {
	/**
	 * A flag with no description renders as a bare name in the FLAGS block, which
	 * is the same discoverability failure as not being listed at all, only harder
	 * to notice because the reconciliation above passes.
	 */
	it("gives every flag a non-empty description", () => {
		const undescribed = Object.entries(launchFlags())
			.filter(([, descriptor]) => (descriptor.description ?? "").trim().length === 0)
			.map(([name]) => name)
			.sort();

		expect(undescribed).toEqual([]);
	});

	/**
	 * Enum flags list their accepted values. A value set that only surfaces as a
	 * parse error is invisible until guessed, which is the same problem one level
	 * down.
	 */
	it("constrains --mode and --thinking to a declared value set", () => {
		const flags = launchFlags();

		expect(flags.mode?.options?.length ?? 0).toBeGreaterThan(1);
		expect(flags.thinking?.options?.length ?? 0).toBeGreaterThan(1);
	});
});

/**
 * The same reconciliation one level down, for the tool names help offers.
 *
 * WHY. `--tools` takes a comma-separated list of tool names, and the only place
 * a user can read those names is the BUILT-IN TOOLS block of `veyyon --help`.
 * That block was fifteen hand-written rows and it had stopped describing the
 * build: it listed `python` and `notebook`, which `--tools` refuses with
 * `Unknown tool passed to --tools` and EXIT_USAGE, and it omitted twenty tools
 * that do exist, including `eval`, `job`, `irc`, `ssh`, `github`, the AST pair
 * and the whole memory set. Both halves are real damage: a name that does not
 * work sends the reader to an error, and a name that is never printed cannot be
 * used at all.
 *
 * This asserts the rendered help, not the source table, because the rendered
 * text is what the user reads and it is the thing that was wrong.
 */
describe("the built-in tool list in help is the list --tools accepts", () => {
	/** Tool names as they appear in the rendered BUILT-IN TOOLS block. */
	function documentedToolNames(): string[] {
		const help = stripAnsi(getExtraHelpText());
		const start = help.indexOf("BUILT-IN TOOLS");
		expect(start).toBeGreaterThan(-1);
		const end = help.indexOf("PLUGIN OPTIONS", start);
		expect(end).toBeGreaterThan(start);

		const names: string[] = [];
		for (const line of help.slice(start, end).split("\n")) {
			// A row is two leading spaces, the name, then at least two spaces
			// before the description. Wrapped continuation lines indent further and
			// start with a word, so the name anchor is what distinguishes them.
			const match = /^ {2}([a-z][a-z0-9_]*) {2,}\S/.exec(line);
			if (match?.[1]) names.push(match[1]);
		}
		return names;
	}

	/**
	 * THE REGRESSION, in the direction that hurts a reader: help offered `python`
	 * and `notebook`, and typing either into `--tools` fails.
	 */
	it("offers no name that --tools rejects", () => {
		const rejected = documentedToolNames().filter(name => !isKnownToolName(name));

		expect(rejected).toEqual([]);
	});

	/**
	 * The other direction: a tool nobody can discover may as well not ship. The
	 * assertion is the exact set so the failure names the missing tool.
	 */
	it("offers every built-in tool", () => {
		expect(documentedToolNames().sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
	});

	/**
	 * A row with no description is the same discoverability failure as a missing
	 * row, and the record's keys alone would satisfy the two set checks above.
	 */
	it("describes each one", () => {
		const help = stripAnsi(getExtraHelpText());
		const start = help.indexOf("BUILT-IN TOOLS");
		const block = help.slice(start, help.indexOf("PLUGIN OPTIONS", start));

		for (const name of BUILTIN_TOOL_NAMES) {
			const row = new RegExp(`^ {2}${name} {2,}(\\S.*)$`, "m").exec(block);
			expect(row?.[1]?.trim().length ?? 0, `${name} has no description in help`).toBeGreaterThan(10);
		}
	});
});
