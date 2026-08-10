/**
 * The slash-command reference page lists every builtin command and every alias.
 *
 * WHY THIS SUITE EXISTS. `docs/handbook/src/reference/slash-commands.md` is the
 * page a user reads to find out what they can type, and nothing tied it to the
 * registry that decides what they can actually type. A command added without a
 * row is invisible to everyone who did not write it, and a row for a command that
 * has been removed sends a reader to type something that errors.
 *
 * The drift when this was first measured was small and pointed straight at the
 * shape of the problem: three ALIASES were missing while all 67 primary names were
 * present. Aliases are what a reader is least likely to guess and most likely to
 * be surprised by, and one of the three proves it. `/status` is an alias for
 * `/extensions`, so a user typing `/status` to see how their session is doing gets
 * the Extension Control Center. That is worth a row precisely because nobody would
 * predict it.
 *
 * The check runs BOTH WAYS on purpose. Only checking that documented commands
 * exist would pass a page that documents three commands out of sixty-seven, and
 * only checking that commands are documented would leave a page free to invent
 * them.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";

const REFERENCE = path.resolve(import.meta.dir, "../../../../docs/handbook/src/reference/slash-commands.md");

/**
 * Every name the parser accepts as a COMMAND: each command's own name and each of
 * its aliases. Subcommands have their own rule below, because they are typed and
 * they were missing.
 */
function registryNames(): string[] {
	const defs = BUILTIN_SLASH_COMMAND_DEFS as ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
	return [...new Set(defs.flatMap(def => [def.name, ...(def.aliases ?? [])]))].sort();
}

/** The heading whose table is the only place subcommands are enumerated. */
const SUBCOMMAND_SECTION_HEADING = "## Every subcommand";

/**
 * Every subcommand the registry accepts, as the user types it: `todo done`.
 *
 * `memory` carries two-level names (`mm delete`), so a subcommand name is not one
 * word and the reader below must not assume it is.
 */
function registrySubcommands(): string[] {
	const defs = BUILTIN_SLASH_COMMAND_DEFS as ReadonlyArray<{
		name: string;
		subcommands?: ReadonlyArray<{ name: string }>;
	}>;
	return defs.flatMap(def => (def.subcommands ?? []).map(sub => `${def.name} ${sub.name}`)).sort();
}

/**
 * Every subcommand the page enumerates, read from that one table.
 *
 * Scoped to the section rather than the whole page on purpose. The category tables
 * write `/shake elide|images` and `/usage show|reset` in prose cells, so a
 * page-wide pattern would report those two as covered and the other 99 as missing,
 * which is the shape of a gate that gets deleted instead of fixed.
 */
export function documentedSubcommands(markdown: string): string[] {
	const lines = markdown.split("\n");
	const start = lines.indexOf(SUBCOMMAND_SECTION_HEADING);
	if (start < 0) return [];
	const found: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("## ")) break;
		const row = line.match(/^\| `\/([a-z][\w:-]*)` \| (.+) \|$/);
		if (!row) continue;
		for (const cell of (row[2] as string).split(",")) {
			const name = cell.trim().replace(/^`/, "").replace(/`$/, "");
			if (name.length > 0) found.push(`${row[1]} ${name}`);
		}
	}
	return found.sort();
}

/**
 * Every `/command` token written in the reference.
 *
 * The trailing `:` is part of the pattern because one alias really is `force:`,
 * which is how `/force:tool` parses. Dropping it would report that alias as
 * undocumented forever, and the response to a permanent failure is to delete the
 * gate.
 */
export function documentedNames(markdown: string): Set<string> {
	return new Set([...markdown.matchAll(/`\/([a-z][\w:-]*)/g)].map(match => match[1] as string));
}

const REFERENCE_TEXT = fs.readFileSync(REFERENCE, "utf8");

describe("the slash-command reference lists every builtin", () => {
	/**
	 * Both sides are real and non-empty. A registry that failed to load, or a page
	 * that failed to read, would satisfy one of the rules below while comparing
	 * nothing at all.
	 */
	it("reads a registry and a page with substance in them", () => {
		expect(registryNames().length).toBeGreaterThan(60);
		expect(documentedNames(REFERENCE_TEXT).size).toBeGreaterThan(60);
		expect(registryNames()).toContain("agents");
		expect(documentedNames(REFERENCE_TEXT).has("agents")).toBe(true);
	});

	/**
	 * Every command a user can type has a row. A failure names the command, and
	 * the fix is a row in the table its category belongs to.
	 */
	it("documents every command name and alias the registry accepts", () => {
		const documented = documentedNames(REFERENCE_TEXT);

		const missing = registryNames().filter(name => !documented.has(name));

		expect(
			missing,
			"these builtin commands are typeable and undocumented. Add a row to docs/handbook/src/reference/slash-commands.md",
		).toEqual([]);
	});

	/**
	 * And the page invents nothing. A row left behind by a removed command tells a
	 * reader to type something that errors, which is worse than no row.
	 */
	it("documents no command the registry does not have", () => {
		const real = new Set(registryNames());

		const ghosts = [...documentedNames(REFERENCE_TEXT)].filter(name => !real.has(name)).sort();

		expect(
			ghosts,
			"these are documented and not in the builtin registry. Remove the row, or say in the prose that an extension provides it",
		).toEqual([]);
	});

	/**
	 * The same rule one level down, and the reason this suite grew: 88 of the 101
	 * subcommands the registry accepts appeared nowhere on the page. Among them
	 * `/permissions yolo`, `/account login`, `/todo done` and `/memory rebuild`,
	 * which are things a reader goes looking for by name. The category tables write
	 * `/todo …` and `/mcp …`, so the elision was deliberate and the enumeration was
	 * simply never written.
	 */
	it("documents every subcommand the registry accepts", () => {
		const documented = new Set(documentedSubcommands(REFERENCE_TEXT));

		const missing = registrySubcommands().filter(name => !documented.has(name));

		expect(
			missing,
			`these subcommands are typeable and unlisted. Add them under "${SUBCOMMAND_SECTION_HEADING}" in docs/handbook/src/reference/slash-commands.md`,
		).toEqual([]);
	});

	/** And the table invents none, the same way the command tables may not. */
	it("lists no subcommand the registry does not have", () => {
		const real = new Set(registrySubcommands());

		const ghosts = documentedSubcommands(REFERENCE_TEXT).filter(name => !real.has(name));

		expect(ghosts, "these are listed and the registry does not accept them").toEqual([]);
	});

	/**
	 * The section itself is load-bearing. Renaming or dropping the heading makes the
	 * reader return nothing, and an empty set satisfies the ghost rule silently
	 * while every subcommand goes undocumented again.
	 */
	it("finds a subcommand table with the whole set in it", () => {
		expect(registrySubcommands().length).toBeGreaterThanOrEqual(101);
		expect(documentedSubcommands(REFERENCE_TEXT).length).toBe(registrySubcommands().length);
		expect(documentedSubcommands(REFERENCE_TEXT)).toContain("permissions yolo");
	});
});

describe("the token reader sees what a user would type", () => {
	/**
	 * The alias with a colon in it, which is the one a naive word pattern drops.
	 */
	it("reads a command whose name ends in a colon", () => {
		expect(documentedNames("| `/force <tool>` (`/force:`) | Force a tool |").has("force:")).toBe(true);
	});

	/**
	 * Several commands on one row, which is how the page documents aliases.
	 */
	it("reads every command on a row that lists aliases", () => {
		const names = documentedNames("| `/new`, `/fresh` | New session |");

		expect([...names].sort()).toEqual(["fresh", "new"]);
	});

	/**
	 * A hyphenated name, and not the prose around it. A path or a flag written in
	 * the same page must not read as a command.
	 */
	it("reads a hyphenated command and ignores prose that is not one", () => {
		const names = documentedNames("Use `/status-line` but not /barefoot or `packages/coding-agent` or `--flag`.");

		expect([...names]).toEqual(["status-line"]);
	});

	/**
	 * A two-level subcommand name, which is what `memory` has. Splitting on
	 * whitespace would read `mm delete` as two subcommands and report both as
	 * ghosts.
	 */
	it("reads a subcommand name that is two words", () => {
		const listed = documentedSubcommands(
			["## Every subcommand", "", "| `/memory` | `stats`, `mm delete` |"].join("\n"),
		);

		expect(listed).toEqual(["memory mm delete", "memory stats"]);
	});

	/**
	 * Rows outside the section are not subcommand rows. The category tables are
	 * two-column too, so a reader that ignored the heading would turn `/new`,
	 * `/fresh` into a subcommand called `New session`.
	 */
	it("reads no subcommand from a table above the section", () => {
		const listed = documentedSubcommands(
			["| `/new`, `/fresh` | New session |", "", "## Every subcommand", ""].join("\n"),
		);

		expect(listed).toEqual([]);
	});
});
