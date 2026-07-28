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
 * Every name the parser accepts: each command's own name and each of its aliases.
 *
 * Subcommands (`/session info`) are deliberately not in here. They are documented
 * on their parent's row, they are not typeable on their own, and folding them in
 * would turn a rule about commands into a rule about argument grammar.
 */
function registryNames(): string[] {
	const defs = BUILTIN_SLASH_COMMAND_DEFS as ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
	return [...new Set(defs.flatMap(def => [def.name, ...(def.aliases ?? [])]))].sort();
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
});
