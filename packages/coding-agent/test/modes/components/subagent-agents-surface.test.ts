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

import { describe, expect, it } from "bun:test";
import { SETTING_TABS, TAB_GROUPS } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import {
	nextSubagentEnableValue,
	SUBAGENT_ENABLE_STATE_LABEL,
	type SubagentEnableState,
} from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

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
