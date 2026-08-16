/**
 * The subagent roster — the surface that answers "which subagent types does this
 * session offer, how deep may each one go, and what does each one run".
 *
 * ONE surface renders it: the `Subagent Roster` row in the Subagents settings
 * tab. It used to be two — `/agents` carried a copy — and the bug this whole area
 * exists to fix was exactly two surfaces disagreeing about which setting decided a
 * subagent's model. The Control Center is now the live picture only, so the
 * table has a single home and cannot drift from itself.
 *
 * It also holds the WORDING contract for the tab. Every row here configures a
 * spawned worker, and calling half of them "agents" put the reader in front of two
 * names for one thing with nothing saying they were the same thing. The sweep
 * below enumerates the tab at run time, so a row added later with "Agent" in its
 * label or a section named "Agents" turns this suite red rather than reopening the
 * question one row at a time.
 *
 * WHAT IT DOES NOT CATCH: prose. A description sentence may still say "agent", and
 * this suite only pins the names the pane draws as headings and row labels.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { settings } from "@veyyon/coding-agent/config/settings";
import { SETTING_TABS, TAB_GROUPS } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	nextSubagentEnableValue,
	SUBAGENT_ENABLE_STATE_LABEL,
	type SubagentEnableState,
} from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

beforeAll(async () => {
	await initTheme();
});

describe("subagent.agents settings surface", () => {
	/**
	 * The table used to have no `ui` block at all: `subagent.agents` was reachable
	 * only by hand-editing config, while `/agents` was the only screen that knew the
	 * agent names. An operator opening the Subagents tab to turn a specialist on
	 * found the delegation switch, the blanket model, and nothing about agents.
	 */
	it("renders as the dedicated per-agent editor in the Subagents group of the Subagents tab", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("subagents").find(entry => entry.path === "subagent.agents");
		expect(def?.type).toBe("subagentAgents");
		expect(def?.label).toBe("Subagent Roster");
		expect(def?.group).toBe("Subagents");
	});

	/**
	 * A record with no dedicated type falls through to the generic text control,
	 * which would ask the operator to type JSON for keys only discovery knows. That
	 * regression is invisible in a smoke test, so pin the type, not just presence.
	 */
	it("never degrades to the generic record-as-text control", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("subagents").find(entry => entry.path === "subagent.agents");
		expect(def?.type).not.toBe("text");
	});

	/** One surface per setting: the table must not also appear under Model or Tools. */
	it("appears on exactly one tab", () => {
		invalidateSettingDefsCache();
		const tabs = SETTING_TABS.filter(tab => getSettingsForTab(tab).some(entry => entry.path === "subagent.agents"));
		expect(tabs).toEqual(["subagents"]);
	});

	/**
	 * `TAB_GROUPS` declares section order, and a group nothing renders into is a
	 * dead entry that reads as a promised section. The roster's group was exactly
	 * that until the table got its `ui` block.
	 */
	it("fills the Subagents group it declares", () => {
		invalidateSettingDefsCache();
		expect(TAB_GROUPS.subagents).toContain("Subagents");
		const groups = new Set(getSettingsForTab("subagents").map(entry => entry.group));
		for (const group of TAB_GROUPS.subagents) {
			expect(groups.has(group)).toBe(true);
		}
	});

	/**
	 * The blanket ceiling and the per-subagent overrides that outrank it are one
	 * decision. The ceiling used to sit under Limits, two sections below the roster
	 * that overrides it, so the picker inside the roster referred to a row the
	 * reader could not see and an operator could raise one while the other held.
	 * Same group, adjacent, in that order.
	 */
	it("keeps the blanket spawn ceiling in the roster's own section", () => {
		invalidateSettingDefsCache();
		const tab = getSettingsForTab("subagents");
		const roster = tab.findIndex(entry => entry.path === "subagent.agents");
		const depth = tab.findIndex(entry => entry.path === "subagent.maxNestedSpawnDepth");
		expect(roster).toBeGreaterThanOrEqual(0);
		expect(depth).toBe(roster + 1);
		expect(tab[depth]?.group).toBe(tab[roster]?.group);
		expect(tab[depth]?.group).not.toBe("Limits");
	});

	/**
	 * One word for one thing. Enumerated from the tab rather than from a list of
	 * known rows, so a new row labelled "Agent Something" fails here.
	 */
	it("never calls a subagent an agent in a heading or a row label", () => {
		invalidateSettingDefsCache();
		const offenders: string[] = [];
		for (const group of TAB_GROUPS.subagents) {
			if (/\bAgents?\b/.test(group)) offenders.push(`group "${group}"`);
		}
		for (const entry of getSettingsForTab("subagents")) {
			if (/\bAgents?\b/.test(entry.label)) offenders.push(`${entry.path}: "${entry.label}"`);
			if (entry.group && /\bAgents?\b/.test(entry.group)) offenders.push(`${entry.path}: group "${entry.group}"`);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The right-hand pane of one rendered line, with the tab sidebar cut off.
	 *
	 * WHY THIS EXISTS, and why a whole-line search is a trap. The sidebar and the pane share a rendered
	 * LINE: `│ › Subagents        │    Nested spawn depth        Two nested levels     │`. The sidebar
	 * draws its own `›` for the selected TAB, so `line.includes("›")` is true for whichever pane row
	 * happens to sit on the Subagents line, and every helper that located a row that way reported it as
	 * selected without ever moving the cursor. That is not hypothetical: this case passed for months while
	 * pressing Enter on the wrong row, toggling `Enabled` instead of opening the depth picker, and its
	 * assertion on the selected value was reading the sidebar's marker.
	 */
	function paneOf(line: string): string {
		const columns = stripVTControlCharacters(line).split("│");
		return columns.length >= 4 ? columns[2]! : "";
	}

	function paneLines(component: SettingsSelectorComponent): string[] {
		return component.render(120).map(paneOf);
	}

	/**
	 * Open the roster submenu and wait for it to have read the agent directories.
	 *
	 * Discovery is async and reports completion by asking for a re-render, so this
	 * waits on that callback rather than on the clock: the frame is checked once per
	 * request until the roster is there, and a discovery that never reports fails as
	 * a test timeout instead of a flaky sleep.
	 */
	async function openRoster(
		present: string,
		/** Every settings path the surface reports having written, in order. */
		changed: string[] = [],
	): Promise<{
		component: SettingsSelectorComponent;
		selectRow: (needle: string) => void;
	}> {
		let rendered = Promise.withResolvers<void>();
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: ["default"],
				providers: [],
				cwd: process.cwd(),
				modelRegistry: {} as ModelRegistry,
				// A real catalog, because the blanket Effort row offers the union of what the models in
				// this session declare and nothing else. With an empty list there is no level to pick,
				// which is correct behaviour and a useless fixture. `gpt-5` declares
				// `minimal, low, medium, high`, which is what these cases choose from.
				availableModels: [getBundledModel("azure", "gpt-5")],
				requestRender: () => rendered.resolve(),
			},
			{ onChange: path => changed.push(path), onCancel: () => {} },
		);
		component.openTab("subagents");
		expect(component.selectSetting("subagent.agents")).toBe(true);
		component.handleInput("\n");
		while (!paneLines(component).some(line => line.includes(present))) {
			await rendered.promise;
			rendered = Promise.withResolvers<void>();
		}

		// Reach the rows by LABEL rather than by a press count or a substring. The roster is
		// alphabetical, so renaming any agent reorders it and a fixed number of Down presses
		// configures whichever agent happens to sort first. The label rather than the whole line,
		// because a description names other rows: the `auto` row describes itself as "Choose per
		// prompt from minimal, low, medium, high", so a search for `minimal` landed on `auto` and
		// stored the wrong level while reporting success.
		const labelOf = (line: string): string => line.replace(/^[\s›]*/, "").split(/\s{2,}/)[0]?.trim() ?? "";
		const selectRow = (needle: string): void => {
			for (let step = 0; step < 32; step++) {
				const line = paneLines(component).find(candidate => labelOf(candidate) === needle);
				if (line?.includes("›")) return;
				component.handleInput("\u001b[B");
			}
			throw new Error(`never landed on the ${needle} row`);
		};
		return { component, selectRow };
	}

	/**
	 * The screen is named for what it configures. "Agents" over a list of subagents,
	 * inside a tab called Subagents, is two names for one thing, and a heading is the
	 * string a reader cannot skip. The schema sweep above cannot see these: both
	 * headings are drawn by the submenu, not by a `ui.label`.
	 */
	it("heads the roster and the per-subagent editor with the word subagent", async () => {
		const { component, selectRow } = await openRoster("designer");
		const roster = paneLines(component).map(line => line.trim());
		expect(roster).toContain("Subagents");
		expect(roster).not.toContain("Agents");

		selectRow("designer");
		component.handleInput("\n");
		const editor = paneLines(component).map(line => line.trim());
		expect(editor).toContain("Subagent: designer");
		expect(editor.some(line => line.startsWith("Agent: "))).toBe(false);
	});

	/**
	 * Opening a picker must highlight the value already stored on the agent row.
	 * Starting every picker on Inherit makes an explicit override look inactive
	 * and lets Enter erase it without the operator moving the cursor.
	 */
	it("opens the recursion picker on the persisted per-agent override", async () => {
		settings.set("subagent.agents", { designer: { maxNestedSpawnDepth: 2 } });
		const { component, selectRow } = await openRoster("designer");

		selectRow("designer");
		component.handleInput("\n");
		selectRow("Nested spawn depth");
		component.handleInput("\n");

		const frame = paneLines(component);
		// The picker is open, which the row it replaced no longer being on screen is what proves: the
		// options are the depths themselves, so finding "Two nested levels" on the editor page would
		// have matched the row's own VALUE column and said nothing about a picker.
		expect(frame.some(line => line.includes("Nested spawn depth") && line.includes("Enabled"))).toBe(false);
		const selected = frame.find(line => line.includes("Two nested levels"));
		expect(selected).toContain("›");
		const inherit = frame.find(line => line.includes("Inherit"));
		expect(inherit).toBeDefined();
		expect(inherit).not.toContain("›");
	});

	/**
	 * WHY: the roster showed what every lane RUNS and then printed a sentence
	 * naming another section to change it on ("Change it in Models · Subagent
	 * Model and Subagent Effort"). Every case below drives the real
	 * `SettingsSelectorComponent` from the tab through the roster and asserts on
	 * the stored settings, so a screen that shows a value and cannot change it
	 * turns this red.
	 *
	 * The CLASS is wider than the two rows: any run-affecting subagent setting
	 * that lands on this tab must be reachable from one section, which the
	 * enumerating case below fails on rather than leaving to a reader.
	 *
	 * WHAT IT DOES NOT CATCH: the model picker's own catalog behaviour. This
	 * harness has no models, so the chain rows it can reach are the ones that
	 * need none (an existing chain, and clearing it).
	 */
	it("offers the model and the effort every subagent runs above the lanes", async () => {
		settings.unset("subagent.model");
		settings.unset("subagent.thinkingLevel");
		const { component } = await openRoster("designer");
		const lines = paneLines(component);
		const model = lines.findIndex(line => /\bModel\b/.test(line) && line.includes("every subagent"));
		const effort = lines.findIndex(line => /\bEffort\b/.test(line) && line.includes("every subagent"));
		const lane = lines.findIndex(line => line.includes("designer"));
		expect(model).toBeGreaterThanOrEqual(0);
		expect(effort).toBe(model + 1);
		expect(lane).toBeGreaterThan(effort);
		// The dead end this screen replaced.
		expect(lines.some(line => line.includes("Change it in"))).toBe(false);
	});

	/**
	 * The effort row writes the blanket setting, and reports THAT path so the tab
	 * row behind it re-reads the value it prints. Reporting `subagent.agents` for
	 * an effort write is how the row and the roster would start disagreeing.
	 */
	it("stores the blanket effort chosen in the roster and reports the path it wrote", async () => {
		settings.unset("subagent.thinkingLevel");
		const changed: string[] = [];
		const { component, selectRow } = await openRoster("designer", changed);

		selectRow("Effort");
		component.handleInput("\n");
		expect(paneLines(component).some(line => line.includes("Subagent Effort · every subagent"))).toBe(true);

		// "medium" appears in exactly one row; "high" and "low" are substrings of
		// other rows' text ("xhigh", "Auto-detect per prompt (low–xhigh)"), which is
		// how a by-name selector lands on the wrong row.
		selectRow("medium");
		component.handleInput("\n");
		expect(settings.get("subagent.thinkingLevel")).toBe("medium");
		expect(changed).toContain("subagent.thinkingLevel");
		expect(changed).not.toContain("subagent.agents");
		// Back on the roster, showing the value it just wrote.
		expect(paneLines(component).some(line => /\bEffort\b/.test(line) && line.includes("medium"))).toBe(true);
	});

	/**
	 * Inherit is the ABSENCE of a value. Storing the empty string leaves the key
	 * configured, which reads downstream as a choice nobody made and prints as a
	 * blank effort on every surface that shows the stored value.
	 */
	it("unsets the blanket effort rather than blanking it when Inherit is chosen", async () => {
		settings.set("subagent.thinkingLevel", "high");
		const { component, selectRow } = await openRoster("designer");

		selectRow("Effort");
		component.handleInput("\n");
		selectRow("Inherit");
		component.handleInput("\n");

		expect(settings.get("subagent.thinkingLevel")).toBeUndefined();
	});

	/**
	 * The model row opens the ONE chain editor bound to `subagent.model` — the
	 * same component the tab row opens — so clearing the chain here clears the
	 * setting itself rather than some copy the roster kept.
	 */
	it("edits the blanket model chain through the roster", async () => {
		settings.set("subagent.model", ["anthropic/claude-sonnet-4"]);
		const changed: string[] = [];
		const { component, selectRow } = await openRoster("designer", changed);
		// The value column truncates, so the needle is the part that always survives.
		expect(paneLines(component).some(line => /\bModel\b/.test(line) && line.includes("anthropic/"))).toBe(true);

		selectRow("Model");
		component.handleInput("\n");
		const chain = paneLines(component);
		expect(chain.some(line => line.includes("Subagent Model · every subagent"))).toBe(true);
		expect(chain.some(line => line.includes("1. ") && line.includes("claude-sonnet-4"))).toBe(true);

		selectRow("Clear (inherit)");
		component.handleInput("\n");
		expect(settings.get("subagent.model")).toBeUndefined();
		expect(changed).toContain("subagent.model");
	});

	/**
	 * The per-subagent page shows what that lane runs, so it carries the same two
	 * rows. It must not grow a per-agent model or effort while doing it: both rows
	 * say "every subagent" and write the blanket paths.
	 */
	it("changes what every subagent runs from the per-subagent page too", async () => {
		settings.unset("subagent.thinkingLevel");
		settings.unset("subagent.agents");
		const changed: string[] = [];
		const { component, selectRow } = await openRoster("designer", changed);
		selectRow("designer");
		component.handleInput("\n");
		const editor = paneLines(component);
		expect(editor.some(line => line.includes("Change it in"))).toBe(false);
		expect(editor.some(line => /\bModel\b/.test(line) && line.includes("every subagent"))).toBe(true);

		selectRow("Effort");
		component.handleInput("\n");
		selectRow("minimal");
		component.handleInput("\n");
		expect(settings.get("subagent.thinkingLevel")).toBe("minimal");
		expect(changed).toContain("subagent.thinkingLevel");
		// Back on the SUBAGENT page it came from, not the roster.
		expect(paneLines(component).some(line => line.includes("Subagent: designer"))).toBe(true);
		// A blanket write must not touch the per-agent table on its way past.
		expect(settings.get("subagent.agents")).toEqual({});
	});

	/**
	 * One section for what a subagent is and what it runs. Enumerated from the
	 * schema at run time, so a run-affecting setting added to this tab in a
	 * section of its own fails here instead of quietly reopening the split.
	 */
	it("keeps every setting that decides what a subagent runs in the roster's section", () => {
		invalidateSettingDefsCache();
		expect(TAB_GROUPS.subagents.filter(group => /model/i.test(group))).toEqual([]);
		const tab = getSettingsForTab("subagents");
		const runPaths = ["subagent.model", "subagent.thinkingLevel", "subagent.modelByDepth"];
		for (const path of runPaths) {
			const def = tab.find(entry => entry.path === path);
			expect(def).toBeDefined();
			expect(def?.group).toBe("Subagents");
		}
	});
});

describe("subagent enable-state wording", () => {
	/** Every state a row can express needs words; a missing one renders `undefined`. */
	it("labels both states, distinctly", () => {
		const states: SubagentEnableState[] = ["on", "off"];
		const labels = states.map(state => SUBAGENT_ENABLE_STATE_LABEL[state]);
		expect(Object.keys(SUBAGENT_ENABLE_STATE_LABEL).sort()).toEqual([...states].sort());
		expect(new Set(labels).size).toBe(2);
		for (const label of labels) expect(label.length).toBeGreaterThan(0);
	});

	/**
	 * The wording says what the switch does and nothing else.
	 *
	 * It used to include "Not offered (default) — still runs when named", a label
	 * that had to explain why the off position was not off. An operator reading it
	 * cannot tell what pressing the key will accomplish, and the honest reading —
	 * "this control does not fully work" — is the one users reached. Two plain
	 * words replace it, and the behaviour behind them is now equally plain.
	 */
	it("says only enabled or disabled, and never that a disabled agent still runs", () => {
		expect(SUBAGENT_ENABLE_STATE_LABEL.on).toBe("Enabled");
		expect(SUBAGENT_ENABLE_STATE_LABEL.off).toBe("Disabled");
		for (const label of Object.values(SUBAGENT_ENABLE_STATE_LABEL)) {
			expect(label).not.toContain("still runs");
			expect(label).not.toContain("Not offered");
		}
	});

	/**
	 * A toggle, not a cycle, and it never lands back on "no value".
	 *
	 * The old three-stop cycle returned to unset, a keypress that changed nothing
	 * the operator could see and was indistinguishable from the toggle failing.
	 * Writing an explicit value both ways also means the choice survives a change
	 * to the shipped default.
	 */
	it("toggles between the two states without a third stop", () => {
		const scout = { name: "scout", source: "bundled" } as AgentDefinition;
		const first = nextSubagentEnableValue(scout, undefined);
		const second = nextSubagentEnableValue(scout, first);
		const third = nextSubagentEnableValue(scout, second);
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(third).toBe(true);
	});
});
