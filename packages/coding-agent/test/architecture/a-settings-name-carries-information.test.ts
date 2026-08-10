/**
 * A row's name and its heading each say something the other does not.
 *
 * WHY THIS SUITE EXISTS. `/settings` is 282 rows under 66 headings, and the names
 * are the whole interface: an operator finds a knob by reading, or by typing a word
 * into a search bar that matches labels. Eight headings printed the same words as
 * their own row, so the screen said `◆ LSP` and then `LSP`, `◆ Agents` and then
 * `Agents`, `◆ Session instrumentation` and then `Session instrumentation`. Two rows
 * on different tabs both read `Interrupt Mode`, one for steering during a tool call
 * and one for stream-rule matching, so the global search offered a choice between
 * two identical names. Three headings were sentence case while the other sixty-odd
 * were title case.
 *
 * None of that is style. A heading that repeats its row wastes the only line the
 * operator was going to read, a duplicated label makes search ambiguous at the
 * moment it is supposed to disambiguate, and mixed casing reads as two features
 * built by two people, which is what invites the reader to trust neither.
 *
 * WHY IT IS DERIVED. From `SETTINGS_SCHEMA` and the group order tables at run time.
 * A new row with a label its heading already carries, or one that reuses a label
 * from another tab, is red on arrival rather than found by scrolling.
 *
 * WHY THE ORDER TABLE IS HELD TOO. Renaming a group means renaming it in two
 * places: the `ui.group` on every row and `TAB_GROUPS`, which is what the pane
 * sections by. Miss the second and the rows render ABOVE every heading with their
 * section silently gone, while a `TAB_GROUPS` entry nothing fills promises a section
 * that never appears. Both directions are asserted here, so a half-finished rename
 * cannot land.
 *
 * WHAT IT DOES NOT CATCH. Whether a name is a GOOD name: "Prewalk" means nothing to
 * a new operator and this suite is happy with it. It only holds the three properties
 * a name can be wrong about mechanically: repeating its heading, colliding with
 * another row, and disagreeing with the casing every other heading uses.
 */
import { describe, expect, it } from "bun:test";
import { SETTING_TABS, TAB_GROUPS } from "@veyyon/coding-agent/config/settings-schema";
import { getAllSettingDefs, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";

invalidateSettingDefsCache();
const DEFS = getAllSettingDefs();

/**
 * Small words a title-cased phrase leaves lowercase after the first word.
 *
 * "Grep & Browser" and "Read Summaries" are the shape; "Eval & Runtimes" keeps
 * "Runtimes" capitalized because it follows the ampersand rather than a preposition.
 */
const CONNECTING_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"in",
	"of",
	"on",
	"or",
	"the",
	"to",
	"vs",
	"with",
]);

/**
 * Whether a heading follows the casing the rest of them use.
 *
 * A word passes when it carries a capital ANYWHERE, which is what lets a brand keep
 * its own spelling: `macOS` in "Power (macOS)" is correct and a list of allowed
 * names would have to be maintained forever to say so. Lowercase connecting words
 * are allowed after the first position, and a word with no letters at all (a number,
 * a bare parenthesis) is not a casing question.
 */
function titleCased(group: string): boolean {
	const words = group.split(/[\s/&]+/).filter(Boolean);
	return words.every((word, index) => {
		const bare = word.replace(/[^A-Za-z]/g, "");
		if (!bare) return true;
		if (index > 0 && CONNECTING_WORDS.has(bare.toLowerCase())) return true;
		return bare !== bare.toLowerCase();
	});
}

describe("a settings name carries information", () => {
	/**
	 * NON-VACUITY. Every rule below walks a derived list and an empty list satisfies
	 * all of them. The floors are the measured surface.
	 */
	it("reads the whole labelled surface", () => {
		expect(DEFS.length).toBeGreaterThanOrEqual(280);
		expect(new Set(DEFS.map(def => def.group).filter(Boolean)).size).toBeGreaterThanOrEqual(60);
		expect(SETTING_TABS.length).toBeGreaterThanOrEqual(15);
	});

	/** A heading that repeats its own row spends the line and says nothing. */
	it("never gives a row the same name as its heading", () => {
		const echoes = DEFS.filter(def => def.group && def.group.toLowerCase() === def.label.toLowerCase()).map(
			def => `${def.tab} / ${def.group} -> ${def.label} [${def.path}]`,
		);

		expect(echoes, "the heading already said this; name the row for what it does").toEqual([]);
	});

	/**
	 * And no two rows anywhere carry one name. The search bar is global, so a
	 * collision across two tabs is worse than one within a tab: the two results are
	 * indistinguishable in the list that was supposed to tell them apart.
	 */
	it("gives every row a name no other row has", () => {
		const byLabel = new Map<string, string[]>();
		for (const def of DEFS) {
			const seen = byLabel.get(def.label) ?? [];
			seen.push(`${def.tab}:${def.path}`);
			byLabel.set(def.label, seen);
		}
		const collisions = [...byLabel.entries()]
			.filter(([, where]) => where.length > 1)
			.map(([label, where]) => `"${label}" -> ${where.join(", ")}`);

		expect(collisions, "the global settings search cannot tell these apart").toEqual([]);
	});

	/** One casing for every heading, so the screen reads as one product. */
	it("titles every heading the same way", () => {
		const odd: string[] = [];
		for (const tab of SETTING_TABS) {
			for (const group of TAB_GROUPS[tab] ?? []) {
				if (!titleCased(group)) odd.push(`${tab}: "${group}"`);
			}
		}

		expect(odd, "every other heading is Title Case").toEqual([]);
	});

	/**
	 * The rename trap, both ways. `ui.group` and `TAB_GROUPS` are two spellings of
	 * one name and nothing but this makes them agree.
	 */
	it("declares every heading it renders, and renders every heading it declares", () => {
		const undeclared: string[] = [];
		const unfilled: string[] = [];
		for (const tab of SETTING_TABS) {
			const declared = TAB_GROUPS[tab] ?? [];
			const rendered = new Set(
				DEFS.filter(def => def.tab === tab)
					.map(def => def.group)
					.filter((group): group is string => group !== undefined),
			);
			for (const group of rendered) {
				if (!declared.includes(group)) undeclared.push(`${tab}: "${group}" renders above every heading`);
			}
			for (const group of declared) {
				if (!rendered.has(group)) unfilled.push(`${tab}: "${group}" is promised and empty`);
			}
		}

		expect([...undeclared, ...unfilled], "TAB_GROUPS and the rows disagree about a heading's name").toEqual([]);
	});
});
