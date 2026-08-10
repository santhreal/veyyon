/**
 * Rules are their own sidebar section, and every rules setting lives in it.
 *
 * WHY THIS SUITE EXISTS. The rules surface used to be one group inside Context,
 * next to prompt caching and session instrumentation, so the screen that lists
 * every rule the project loads was three groups down a tab named after
 * something else. Splitting it out is only real if two things hold together:
 * the tab is registered everywhere a tab has to be registered, and the settings
 * actually moved. Either half alone is a broken screen — a tab declared with no
 * settings renders an empty sidebar section, and settings pointing at a tab
 * nothing declares vanish from the UI entirely while still existing in config.
 *
 * The per-key assertions are deliberately by name rather than by count: a
 * later `ttsr.*` setting added to the wrong tab is exactly the regression this
 * catches, and a count would happily absorb it.
 */
import { describe, expect, it } from "bun:test";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab, type SettingDef } from "@veyyon/coding-agent/modes/components/settings-defs";

/** The rules surface, and the group each key is expected to render under. */
const RULES_SETTINGS: ReadonlyMap<string, string> = new Map([
	["ttsr.builtinRules", "Rules"],
	["ttsr.disabledRules", "Rules"],
	["ttsr.enabled", "Stream Interrupts (TTSR)"],
	["ttsr.contextMode", "Stream Interrupts (TTSR)"],
	["ttsr.interruptMode", "Stream Interrupts (TTSR)"],
	["ttsr.repeatMode", "Stream Interrupts (TTSR)"],
	["ttsr.repeatGap", "Stream Interrupts (TTSR)"],
]);

describe("the Rules settings tab", () => {
	/**
	 * A tab needs an entry in all three tables to reach the screen: the ordered
	 * list the sidebar iterates, the label and icon it draws, and the group order
	 * the pane sections by. A tab missing from any one of them is either invisible
	 * or renders its settings ungrouped above every heading.
	 */
	it("is registered in the tab order, the metadata and the group order", () => {
		expect(SETTING_TABS).toContain("rules");
		expect(TAB_METADATA.rules).toEqual({ label: "Rules", icon: "tab.rules" });
		expect(TAB_GROUPS.rules).toEqual(["Rules", "Stream Interrupts (TTSR)"]);
	});

	/**
	 * The list of rules is what the section is named after, so it comes first.
	 * Ordering is a real contract here: `TAB_GROUPS` is what the pane renders by,
	 * not declaration order in the domain file, so the two can disagree silently.
	 */
	it("puts the rule list above the stream-interrupt knobs", () => {
		expect(TAB_GROUPS.rules?.[0]).toBe("Rules");
	});

	it("carries every rules setting, each in its expected group", () => {
		const byPath = new Map<string, SettingDef>(getSettingsForTab("rules").map(def => [def.path, def]));
		for (const [path, group] of RULES_SETTINGS) {
			const def = byPath.get(path);
			expect(def, `${path} is missing from the Rules tab`).toBeDefined();
			expect(def?.group, `${path} is in the wrong group`).toBe(group);
		}
	});

	/**
	 * The other half of the move. Leaving a copy behind on Context would put the
	 * same key on two screens, where changing it in one place silently disagrees
	 * with what the other shows.
	 */
	it("leaves no rules setting behind on the Context tab", () => {
		const contextPaths = getSettingsForTab("context").map(def => def.path);
		for (const path of RULES_SETTINGS.keys()) expect(contextPaths).not.toContain(path);
		expect(TAB_GROUPS.context).not.toContain("Rules (TTSR)");
	});

	/**
	 * Every group the tab declares must be produced by a setting, and every group
	 * a setting names must be declared. An undeclared group renders its settings
	 * above the first heading with nothing labelling them; a declared group that
	 * no setting fills renders a heading with nothing under it.
	 */
	it("declares exactly the groups its settings produce", () => {
		const produced = new Set(getSettingsForTab("rules").map(def => def.group));
		expect([...produced].sort()).toEqual([...(TAB_GROUPS.rules ?? [])].sort());
	});
});
