/**
 * The agent roster — the surface that answers "which agent types does this
 * session offer, how deep may each one go, and what does each one run".
 *
 * ONE surface renders it: the `Agent Roster` row in the Agents settings
 * tab. It used to be two — `/agents` carried a copy — and the bug this whole area
 * exists to fix was exactly two surfaces disagreeing about which setting decided a
 * agent's model. The Control Center is now the live picture only, so the
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
import {
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import {
	AGENT_ENABLE_STATE_LABEL,
	type AgentEnableState,
	nextAgentEnableValue,
} from "@veyyon/coding-agent/task/agent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { useIsolatedAgentDir } from "../../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

beforeAll(async () => {
	await initTheme();
});

describe("agent.agents settings surface", () => {
	/**
	 * The table used to have no `ui` block at all: `agent.agents` was reachable
	 * only by hand-editing config, while `/agents` was the only screen that knew the
	 * agent names. An operator opening the Agents tab to turn a specialist on
	 * found the delegation switch, the blanket model, and nothing about agents.
	 */
	it("renders as the dedicated per-agent editor in the Agents group of the Agents tab", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("agents").find(entry => entry.path === "agent.agents");
		expect(def?.type).toBe("agents");
		expect(def?.label).toBe("Roster");
		expect(def?.group).toBe("Agents");
	});

	/**
	 * A record with no dedicated type falls through to the generic text control,
	 * which would ask the operator to type JSON for keys only discovery knows. That
	 * regression is invisible in a smoke test, so pin the type, not just presence.
	 */
	it("never degrades to the generic record-as-text control", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("agents").find(entry => entry.path === "agent.agents");
		expect(def?.type).not.toBe("text");
	});

	/** One surface per setting: the table must not also appear under Model or Tools. */
	it("appears on exactly one tab", () => {
		invalidateSettingDefsCache();
		const tabs = SETTING_TABS.filter(tab => getSettingsForTab(tab).some(entry => entry.path === "agent.agents"));
		expect(tabs).toEqual(["agents"]);
	});

	/**
	 * `TAB_GROUPS` declares section order, and a group nothing renders into is a
	 * dead entry that reads as a promised section. The roster's group was exactly
	 * that until the table got its `ui` block.
	 */
	it("fills the Agents group it declares", () => {
		invalidateSettingDefsCache();
		expect(TAB_GROUPS.agents).toContain("Agents");
		const groups = new Set(getSettingsForTab("agents").map(entry => entry.group));
		for (const group of TAB_GROUPS.agents) {
			expect(groups.has(group)).toBe(true);
		}
	});

	/**
	 * The blanket ceiling and the per-agent overrides that outrank it are one
	 * decision. The ceiling used to sit under Limits, two sections below the roster
	 * that overrides it, so the picker inside the roster referred to a row the
	 * reader could not see and an operator could raise one while the other held.
	 * Same group, adjacent, in that order.
	 */
	it("keeps the blanket spawn ceiling in the roster's own section", () => {
		invalidateSettingDefsCache();
		const tab = getSettingsForTab("agents");
		const roster = tab.findIndex(entry => entry.path === "agent.agents");
		const depth = tab.findIndex(entry => entry.path === "agent.maxNestedSpawnDepth");
		expect(roster).toBeGreaterThanOrEqual(0);
		expect(depth).toBe(roster + 1);
		expect(tab[depth]?.group).toBe(tab[roster]?.group);
		expect(tab[depth]?.group).not.toBe("Limits");
	});

	/**
	 * One word for one thing. Enumerated from the tab rather than from a list of
	 * known rows, so a new row labelled with the retired "Subagent" fails here.
	 */
	it("never calls an agent a subagent in a heading or a row label", () => {
		invalidateSettingDefsCache();
		const offenders: string[] = [];
		for (const group of TAB_GROUPS.agents) {
			if (/\bSubagents?\b/i.test(group)) offenders.push(`group "${group}"`);
		}
		for (const entry of getSettingsForTab("agents")) {
			if (/\bSubagents?\b/i.test(entry.label)) offenders.push(`${entry.path}: "${entry.label}"`);
			if (entry.group && /\bSubagents?\b/i.test(entry.group))
				offenders.push(`${entry.path}: group "${entry.group}"`);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The right-hand pane of one rendered line, with the tab sidebar cut off.
	 *
	 * WHY THIS EXISTS, and why a whole-line search is a trap. The sidebar and the pane share a rendered
	 * LINE: `│ › Agents        │    Nested spawn depth        Two nested levels     │`. The sidebar
	 * draws its own `›` for the selected TAB, so `line.includes("›")` is true for whichever pane row
	 * happens to sit on the Agents line, and every helper that located a row that way reported it as
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
		component.openTab("agents");
		expect(component.selectSetting("agent.agents")).toBe(true);
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
		const labelOf = (line: string): string =>
			line
				.replace(/^[\s›]*/, "")
				.split(/\s{2,}/)[0]
				?.trim() ?? "";
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
	 * The screen is named for what it configures. "Agents" over a list of agents,
	 * inside a tab called Agents, is two names for one thing, and a heading is the
	 * string a reader cannot skip. The schema sweep above cannot see these: both
	 * headings are drawn by the submenu, not by a `ui.label`.
	 */
	it("heads the roster and the per-agent editor with the word agent", async () => {
		const { component, selectRow } = await openRoster("designer");
		const roster = paneLines(component).map(line => line.trim());
		expect(roster).toContain("Agents");
		expect(roster).not.toContain("Subagents");

		selectRow("designer");
		component.handleInput("\n");
		const editor = paneLines(component).map(line => line.trim());
		expect(editor).toContain("Agent: designer");
		expect(editor.some(line => line.startsWith("Subagent: "))).toBe(false);
	});

	/**
	 * Opening a picker must highlight the value already stored on that lane.
	 * Starting every picker on Inherit makes an explicit override look inactive
	 * and lets Enter erase it without the operator moving the cursor.
	 */
	it("opens a lane's effort picker on the level that lane stores, not on Inherit", async () => {
		settings.set("agent.agents", { designer: { thinkingLevel: "medium" } });
		const { component, selectRow } = await openRoster("designer");

		selectRow("designer");
		component.handleInput("\n");
		selectRow("Effort");
		component.handleInput("\n");

		const frame = paneLines(component);
		// The picker is bound to THIS lane, which its title is what proves: the blanket picker over
		// the same options titles itself "every agent".
		expect(frame.some(line => line.includes("Effort · designer"))).toBe(true);
		// By LABEL, never by substring: every effort word also appears inside `auto`'s description
		// ("Choose per prompt from minimal, low, medium, high"), so a line search for "medium"
		// matches a row nobody selected and passes while the picker opens on Inherit.
		const selected = frame.find(line => line.trim().startsWith("›"));
		expect(
			selected
				?.replace(/^[\s›]*/, "")
				.split(/\s{2,}/)[0]
				?.trim(),
		).toBe("medium");
	});

	/**
	 * The page draws the ceiling the SPAWN GATE applies, never a rule of its own. A hardcoded "one
	 * level is fine" on this screen is invisible: the row reads as available, the operator leaves it
	 * alone because it already says what they want, and the gate refuses the spawn anyway. The two
	 * arms differ only in the blanket ceiling, so a page default that stopped reading it stays green
	 * on one arm and red on the other.
	 */
	it("draws the nesting row from the ceiling the spawn gate applies", async () => {
		const labelOf = (line: string): string =>
			line
				.replace(/^[\s›]*/, "")
				.split(/\s{2,}/)[0]
				?.trim() ?? "";
		const nestingRow = async (): Promise<string> => {
			const { component, selectRow } = await openRoster("designer");
			selectRow("designer");
			component.handleInput("\n");
			const row = paneLines(component).find(line => labelOf(line) === "Agents");
			if (row === undefined) throw new Error(`no Agents row:\n${paneLines(component).join("\n")}`);
			return row;
		};

		// The shipped default: this session may spawn `designer`, and `designer` may not spawn in turn.
		settings.set("agent.maxNestedSpawnDepth", 0);
		expect(await nestingRow()).toContain("may not spawn");

		// One nested level granted, and the row stops saying the level is closed.
		settings.set("agent.maxNestedSpawnDepth", 1);
		expect(await nestingRow()).not.toContain("may not spawn");
	});

	/**
	 * The roster lists agents and NOTHING that reaches more than one of them. The switch that does
	 * reach every agent is a row on the tab above, not a row inside this page, so a choice aimed at
	 * one agent and a choice aimed at the whole roster are never one row apart.
	 *
	 * Every case here drives the real component and asserts on the stored settings, so a screen
	 * that shows a value and cannot change it, or changes more than the agent named on it, turns
	 * this red.
	 *
	 * WHAT IT DOES NOT CATCH: the model picker's own catalog behaviour. This
	 * harness has no models, so the chain rows it can reach are the ones that
	 * need none (an existing chain, and clearing it).
	 */
	it("lists agents and offers no row that reaches more than one", async () => {
		settings.set("agent.model", ["anthropic/claude-sonnet-4"]);
		settings.set("agent.thinkingLevel", "high");
		const { component } = await openRoster("designer");
		const lines = paneLines(component);

		expect(lines.some(line => line.includes("designer"))).toBe(true);
		expect(lines.some(line => line.includes("Same Shared Model"))).toBe(false);
		// A stored blanket value the switch is not reading must not be on screen: a
		// row answering for everybody is what this page was collapsed to end.
		expect(lines.some(line => line.includes("every agent"))).toBe(false);
		// The dead end this screen replaced.
		expect(lines.some(line => line.includes("Change it in"))).toBe(false);
	});

	/**
	 * The two scopes are exclusive on screen, not only in the resolver. While the switch is on, the
	 * agent's page must not draw a Model or an Effort row: a row showing a value no spawn reads is
	 * the exact confusion that retired the first version of this switch. The page says where the
	 * answer is instead of losing one.
	 */
	it("replaces an agent's Model and Effort rows with a signpost while the switch is on", async () => {
		settings.set("agent.sharedModel", true);
		settings.set("agent.agents", { designer: { model: "anthropic/claude-sonnet-4" } });
		const { component, selectRow } = await openRoster("designer");
		selectRow("designer");
		component.handleInput("\n");
		const labels = paneLines(component).map(
			line =>
				line
					.replace(/^[\s›]*/, "")
					.split(/\s{2,}/)[0]
					?.trim() ?? "",
		);

		expect(labels).toContain("Enabled");
		expect(labels).not.toContain("Model");
		expect(labels).not.toContain("Effort");
		expect(paneLines(component).join(" ").replace(/\s+/g, " ")).toContain("Agents → Shared Model");
	});

	/** Off is the default, and the agent's own rows are back the moment it is. */
	it("draws an agent's Model and Effort rows while the switch is off", async () => {
		settings.set("agent.sharedModel", false);
		settings.set("agent.agents", { designer: { model: "anthropic/claude-sonnet-4" } });
		const { component, selectRow } = await openRoster("designer");
		selectRow("designer");
		component.handleInput("\n");
		const labels = paneLines(component).map(
			line =>
				line
					.replace(/^[\s›]*/, "")
					.split(/\s{2,}/)[0]
					?.trim() ?? "",
		);

		expect(labels).toContain("Model");
		expect(labels).toContain("Effort");
		expect(paneLines(component).join(" ").replace(/\s+/g, " ")).not.toContain("Shared Model");
	});

	/**
	 * Authoring an agent was reachable only by knowing a directory path and
	 * finding a handbook page nothing linked. The roster is where someone looking
	 * for an agent that does not exist yet arrives, so the hint lives here, states
	 * where the file goes, and names the document rather than gesturing at "the
	 * docs". Joined across the pane because the sentence wraps at this width, and
	 * a hint whose second half is off-screen names nothing.
	 */
	it("says an operator may write an agent, and names where the instructions are", async () => {
		const { component } = await openRoster("designer");
		const pane = paneLines(component).join(" ").replace(/\s+/g, " ");

		expect(pane).toContain("Write your own");
		expect(pane).toContain("~/.veyyon/agents/");
		expect(pane).toContain("features/agents-authoring");
	});

	/**
	 * The per-agent page shows what THAT lane runs, and the value it shows is the value it
	 * changes: an effort chosen here lands on the agent's own row and leaves every other agent
	 * alone. The screen this replaced printed a shared value on the agent's page and wrote the
	 * shared path from it, so configuring one lane silently retuned every other one.
	 */
	it("writes the agent's own lane from the per-agent page, and moves no other agent", async () => {
		settings.unset("agent.thinkingLevel");
		settings.unset("agent.agents");
		const changed: string[] = [];
		const { component, selectRow } = await openRoster("designer", changed);
		selectRow("designer");
		component.handleInput("\n");
		expect(paneLines(component).some(line => line.includes("Change it in"))).toBe(false);

		selectRow("Effort");
		component.handleInput("\n");
		selectRow("minimal");
		component.handleInput("\n");

		expect(settings.get("agent.agents")).toEqual({ designer: { thinkingLevel: "minimal" } });
		expect(settings.get("agent.thinkingLevel")).toBeUndefined();
		expect(changed).toContain("agent.agents");
		expect(changed).not.toContain("agent.thinkingLevel");
		// Back on the AGENT page it came from, not the roster.
		expect(paneLines(component).some(line => line.includes("Agent: designer"))).toBe(true);
	});

	/**
	 * ONE OWNER PER SCOPE, enumerated from the schema at run time. Everything on this tab that
	 * decides what an agent runs sits in the roster's own group: the per-agent table, and the
	 * shared switch with the two rows it owns. A run-affecting setting added to this tab in a
	 * section of its own fails here instead of quietly reopening the three-surface split.
	 *
	 * `agent.modelByDepth` keyed a chain to a spawn depth rather than to an agent and offers no
	 * row in either scope.
	 */
	it("keeps every setting that decides what an agent runs in the roster's section", () => {
		invalidateSettingDefsCache();
		expect(TAB_GROUPS.agents.filter(group => /model/i.test(group))).toEqual([]);
		const tab = getSettingsForTab("agents");

		expect(
			tab.find(entry => entry.path === "agent.modelByDepth"),
			"agent.modelByDepth is retired and must offer no row",
		).toBeUndefined();

		const deciding = ["agent.agents", "agent.sharedModel", "agent.model", "agent.thinkingLevel"];
		for (const path of deciding) {
			const entry = tab.find(candidate => candidate.path === path);
			expect(entry, `${path} must offer a row`).toBeDefined();
			expect(entry?.group, `${path} belongs beside the roster`).toBe("Agents");
		}
		expect(tab.find(entry => entry.path === "agent.agents")?.type).toBe("agents");
	});
});

describe("agent enable-state wording", () => {
	/** Every state a row can express needs words; a missing one renders `undefined`. */
	it("labels both states, distinctly", () => {
		const states: AgentEnableState[] = ["on", "off"];
		const labels = states.map(state => AGENT_ENABLE_STATE_LABEL[state]);
		expect(Object.keys(AGENT_ENABLE_STATE_LABEL).sort()).toEqual([...states].sort());
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
		expect(AGENT_ENABLE_STATE_LABEL.on).toBe("Enabled");
		expect(AGENT_ENABLE_STATE_LABEL.off).toBe("Disabled");
		for (const label of Object.values(AGENT_ENABLE_STATE_LABEL)) {
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
		const first = nextAgentEnableValue(scout, undefined);
		const second = nextAgentEnableValue(scout, first);
		const third = nextAgentEnableValue(scout, second);
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(third).toBe(true);
	});
});
