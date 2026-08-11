/**
 * A group whose every row is hidden prints no heading.
 *
 * WHY THIS SUITE EXISTS. Hiding a knob is half of "an off feature hides its knobs
 * completely". The other half is the heading above it: a section title with
 * nothing under it is the greyed-out row by another name, and it is worse, because
 * the operator cannot even read what the missing knobs were. Three groups are
 * fully hidden on a fresh install: Mnemopi and Hindsight while `memory.backend` is
 * `off`, and GitHub, which became fully hidden when the view cache and its two
 * TTLs were finally conditioned on the tool that ships off. The heading suppression
 * is real but structural rather than declared: `#buildItemsForDefs` pushes a
 * heading only after a row survives its condition, so the behavior depends on the
 * order of two statements and nothing was watching it.
 *
 * WHY IT IS DERIVED. The fully-hidden groups are computed from the live schema and
 * the live conditions rather than named, so a group that becomes empty later, for
 * a feature nobody here thought about, is covered on arrival. Naming them is
 * exactly how the GitHub group went unnoticed.
 *
 * WHY THE POSITIVE CONTROL MATTERS. "No heading" is also what a screen that
 * renders nothing at all produces. So the same group is asserted to come back,
 * heading and rows, the moment its feature is switched on inside one session.
 *
 * AND THE SEARCH BAR IS THE THIRD SURFACE. `/settings` search walks the same tabs,
 * so a knob that the list hides and the search still offers is hidden in name only:
 * the operator types "ttl", gets a row, changes it, and nothing happens. The gate
 * lives in `#defToItemBase`, which both paths go through, and that is the thing
 * worth pinning rather than the fact that one of them calls it.
 *
 * WHAT IT DOES NOT CATCH. Nothing about the sidebar's own section list, only the
 * headings in the row list; and nothing about whether a group's remaining rows
 * still make sense once some of its siblings are hidden.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SETTING_TABS, type SettingTab } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

/** The rendered form of a group heading: a diamond, then the group name. */
const HEADING = (group: string): string => `◆ ${group}`;

let geometry: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	// Tall enough that the whole row list renders, so an assertion about a heading
	// is about the heading and not about where the viewport happened to cut.
	geometry = stubStdoutGeometry({ columns: 120, rows: 400 });
});

afterEach(() => {
	resetSettingsForTest();
	geometry?.restore();
	geometry = undefined;
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

/**
 * Every frame the tab can show, walked top to bottom.
 *
 * One `render` is one viewport, and on a long tab a heading below the fold is
 * absent from it for a reason that has nothing to do with conditions: an absence
 * assertion against a single frame would be green by luck. So the list is walked
 * one row at a time and every frame is kept, which means every item that exists
 * appears in the text at least once.
 */
function everyFrame(tab: SettingTab): string {
	const comp = createSelector();
	comp.openTab(tab);
	const steps = getSettingsForTab(tab).length + 40;
	const frames: string[] = [];
	for (let i = 0; i < steps; i++) {
		frames.push(comp.render(120).join("\n"));
		comp.handleInput("\x1b[B");
	}
	return stripVTControlCharacters(frames.join("\n"));
}

/** Groups on this tab where every single row is condition-hidden right now. */
function fullyHiddenGroups(tab: SettingTab): string[] {
	const shown = new Map<string, number>();
	for (const def of getSettingsForTab(tab)) {
		if (!def.group) continue;
		const visible = def.condition === undefined || def.condition() === true;
		shown.set(def.group, (shown.get(def.group) ?? 0) + (visible ? 1 : 0));
	}
	return [...shown.entries()].filter(([, visible]) => visible === 0).map(([group]) => group);
}

function everyFullyHiddenGroup(): { tab: SettingTab; group: string }[] {
	return SETTING_TABS.flatMap(tab => fullyHiddenGroups(tab).map(group => ({ tab, group })));
}

describe("a group with every row hidden", () => {
	/** NON-VACUITY: the derived set is not empty, and it holds the three known cases. */
	it("finds the groups that are empty on a fresh install", () => {
		const empty = everyFullyHiddenGroup();
		expect(empty.length).toBeGreaterThanOrEqual(3);
		expect(empty).toEqual(
			expect.arrayContaining([
				{ tab: "memory", group: "Mnemopi" },
				{ tab: "memory", group: "Hindsight" },
				{ tab: "tools", group: "GitHub" },
			]),
		);
	});

	it("prints no heading for it", () => {
		const printed: string[] = [];
		for (const tab of SETTING_TABS) {
			const empty = fullyHiddenGroups(tab);
			if (empty.length === 0) continue;
			const screen = everyFrame(tab);
			for (const group of empty) {
				if (screen.includes(HEADING(group))) printed.push(`${tab} / ${group}`);
			}
		}

		expect(printed, "these headings sit above nothing, which reads as a broken feature").toEqual([]);
	});

	/**
	 * THE POSITIVE CONTROL. The GitHub group is three rows for a tool that ships
	 * off. Turning the tool on brings the heading and the rows back without leaving
	 * the tab, which is what proves the absence above is suppression rather than a
	 * screen that renders nothing.
	 */
	it("prints the heading and the rows the moment the feature is on", () => {
		const before = everyFrame("tools");
		expect(before).not.toContain(HEADING("GitHub"));
		// The master itself is always reachable, under a different group.
		expect(before).toContain("GitHub CLI");

		settings.set("github.enabled", true);
		const after = everyFrame("tools");

		expect(after).toContain(HEADING("GitHub"));
		expect(after).toContain("Cache Soft TTL");
		expect(after).toContain("Cache Hard TTL");
	});

	/**
	 * And the memory backend does the same thing through a submenu rather than a
	 * boolean, so the suppression is not specific to one kind of gate.
	 */
	it("prints the backend's heading once a backend is chosen", () => {
		expect(everyFrame("memory")).not.toContain(HEADING("Hindsight"));

		settings.set("memory.backend", "hindsight");
		const after = everyFrame("memory");

		expect(after).toContain(HEADING("Hindsight"));
		expect(after).not.toContain(HEADING("Mnemopi"));
	});
});

/**
 * The RESULTS of a global settings search, with the search bar itself removed.
 *
 * The bar echoes the query, so a frame that contains the label proves nothing while
 * the label IS the query: every assertion below would have been trivially true.
 */
function searchResults(query: string): string {
	const comp = createSelector();
	for (const ch of query) comp.handleInput(ch);
	return comp
		.render(120)
		.map(line => stripVTControlCharacters(line))
		.filter(line => !line.includes("⌕"))
		.join("\n");
}

describe("a knob its feature hides", () => {
	/**
	 * The row the operator would find by name. Searching a hidden knob's own label
	 * must return nothing, because a row found by search is a row you can change,
	 * and changing an inert setting is the confusion the hiding was meant to end.
	 *
	 * It builds a selector and types a whole label per conditional row across every
	 * tab, which is seconds of real work: 2.4s alone and 6.3s under a loaded
	 * full-suite run, against the 5s default. The deadline is stated so the sweep
	 * stays exhaustive rather than being narrowed to a sample to fit.
	 */
	it("is not offered by the settings search either", () => {
		const offered: string[] = [];
		for (const tab of SETTING_TABS) {
			for (const def of getSettingsForTab(tab)) {
				if (!def.condition || def.condition()) continue;
				if (searchResults(def.label).includes(def.label)) offered.push(`${tab} / ${def.label}`);
			}
		}

		expect(offered, "search offers these rows while the feature behind them is off").toEqual([]);
	}, 30_000);

	/**
	 * THE POSITIVE CONTROL. The same query finds the same row once its tool is on,
	 * so the silence above is the condition gate and not a search bar that never
	 * matches a three-word label.
	 */
	it("is offered the moment its feature is on", () => {
		expect(searchResults("Cache Soft TTL")).not.toContain("Cache Soft TTL");

		settings.set("github.enabled", true);

		expect(searchResults("Cache Soft TTL")).toContain("Cache Soft TTL");
	});
});
