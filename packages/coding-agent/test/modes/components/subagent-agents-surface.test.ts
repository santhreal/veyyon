/**
 * The Agents table — the surface that answers "which agent types does this
 * session offer, and what does each one run".
 *
 * ONE surface renders it: the `Agents` row in the Subagents settings tab. It
 * used to be two — `/agents` carried a copy — and the bug this whole area exists
 * to fix was exactly two surfaces disagreeing about which setting decided a
 * subagent's model. The Control Center is now the live picture only, so the
 * table has a single home and cannot drift from itself.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
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
	it("renders as the dedicated per-agent editor in the Agents group of the Subagents tab", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("subagents").find(entry => entry.path === "subagent.agents");
		expect(def?.type).toBe("subagentAgents");
		expect(def?.label).toBe("Agents");
		expect(def?.group).toBe("Agents");
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
	 * dead entry that reads as a promised section. "Agents" was exactly that until
	 * the table got its `ui` block.
	 */
	it("fills the Agents group it declares", () => {
		invalidateSettingDefsCache();
		expect(TAB_GROUPS.subagents).toContain("Agents");
		const groups = new Set(getSettingsForTab("subagents").map(entry => entry.group));
		for (const group of TAB_GROUPS.subagents) {
			expect(groups.has(group)).toBe(true);
		}
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
	 * Opening a picker must highlight the value already stored on the agent row.
	 * Starting every picker on Inherit makes an explicit override look inactive
	 * and lets Enter erase it without the operator moving the cursor.
	 */
	it("opens the recursion picker on the persisted per-agent override", async () => {
		settings.set("subagent.agents", { designer: { maxNestedSpawnDepth: 2 } });
		// Agent discovery is async and reports completion by asking for a re-render, so wait on that
		// callback rather than on the clock: the frame is checked once per request until the roster is
		// there, and a discovery that never reports fails as a test timeout instead of a flaky sleep.
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
				availableModels: [],
				requestRender: () => rendered.resolve(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("subagents");
		expect(component.selectSetting("subagent.agents")).toBe(true);
		component.handleInput("\n");
		while (!paneLines(component).some(line => line.includes("designer"))) {
			await rendered.promise;
			rendered = Promise.withResolvers<void>();
		}

		// Reach the rows by name rather than by a press count. The roster is alphabetical,
		// so renaming any agent reorders it, and a fixed number of Down presses silently
		// configured whichever agent happened to sort first instead of the one with the
		// persisted override.
		const selectRow = (needle: string): void => {
			for (let step = 0; step < 32; step++) {
				const line = paneLines(component).find(candidate => candidate.includes(needle));
				if (line?.includes("›")) return;
				component.handleInput("\u001b[B");
			}
			throw new Error(`never landed on the ${needle} row`);
		};

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
