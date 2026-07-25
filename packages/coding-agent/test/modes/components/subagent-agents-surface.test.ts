/**
 * The Agents table — the surface that answers "which agent types does this
 * session offer, and what does each one run".
 *
 * Two surfaces render it: the `Agents` row in the Subagents settings tab and
 * `/agents`. Both must reach it, and both must say the same words about the same
 * row, because the bug this whole area exists to fix was exactly two surfaces
 * disagreeing about which setting decided a subagent's model.
 */

import { afterEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { DEFAULT_ENABLED_BUNDLED_AGENT } from "@veyyon/coding-agent/config/settings-domains/subagents";
import { SETTING_TABS, TAB_GROUPS } from "@veyyon/coding-agent/config/settings-schema";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	nextSubagentEnableValue,
	SUBAGENT_ENABLE_STATE_LABEL,
	type SubagentEnableState,
} from "@veyyon/coding-agent/task/subagent-settings";
import { removeWithRetries } from "@veyyon/utils";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const tempDirs: string[] = [];

/** Settings that answer "nothing configured", i.e. a stock install. */
const defaultSettings = {
	get: (_key: string) => undefined,
	set: (_key: string, _value: unknown) => {},
	getModelRole: (_role: string) => undefined,
} as unknown as Settings;

async function makeTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-subagent-surface-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
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
});

describe("subagent enable-state wording", () => {
	/** Every state a row can express needs words; a missing one renders `undefined`. */
	it("labels all four states, distinctly", () => {
		const states: SubagentEnableState[] = ["on", "default-on", "default-off", "off"];
		const labels = states.map(state => SUBAGENT_ENABLE_STATE_LABEL[state]);
		expect(Object.keys(SUBAGENT_ENABLE_STATE_LABEL).sort()).toEqual([...states].sort());
		expect(new Set(labels).size).toBe(4);
		for (const label of labels) expect(label.length).toBeGreaterThan(0);
	});

	/**
	 * The middle state is the one that needs explaining: an unadvertised agent is
	 * not blocked, and `/review` naming `reviewer` still works. If the wording ever
	 * loses that, operators read default-off as broken and turn everything on.
	 */
	it("says the default-off state still runs when named", () => {
		expect(SUBAGENT_ENABLE_STATE_LABEL["default-off"]).toBe("Not offered (default) — still runs when named");
		expect(SUBAGENT_ENABLE_STATE_LABEL.off).toBe("Blocked");
	});

	/**
	 * Cycling must return to unset. A two-state toggle would write `enabled: true`
	 * on the worker forever, freezing a default that later ships differently.
	 */
	it("cycles unset to offered to blocked and back to unset", () => {
		const first = nextSubagentEnableValue(undefined);
		const second = nextSubagentEnableValue(first);
		const third = nextSubagentEnableValue(second);
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(third).toBeUndefined();
	});
});

describe("/agents rows use the shared wording", () => {
	/**
	 * The dashboard used to own its own state strings. Rendering the real component
	 * against a stock install proves the words the operator sees are the ones the
	 * settings tab shows for the same row — a source-level copy would pass a
	 * presence check and still drift.
	 */
	test("shows the worker as offered by default and a specialist as not offered", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), defaultSettings, 24, {});
		const plain = (): string => dashboard.render(200).join("\n").replace(ANSI_PATTERN, "");

		// Selection starts on the first bundled agent, a specialist.
		const specialist = plain();
		expect(specialist).toContain(SUBAGENT_ENABLE_STATE_LABEL["default-off"]);
		expect(specialist).not.toContain(SUBAGENT_ENABLE_STATE_LABEL["default-on"]);

		// Walk down to the worker, the one bundled agent that ships offered. Stepping
		// until its inspector appears rather than a fixed count, so adding a bundled
		// specialist does not silently make this assert the wrong row.
		let worker = specialist;
		for (let step = 0; step < 20 && !worker.includes(`${DEFAULT_ENABLED_BUNDLED_AGENT}\n`); step++) {
			dashboard.handleInput("\x1b[B");
			worker = plain();
		}
		expect(worker).toContain(SUBAGENT_ENABLE_STATE_LABEL["default-on"]);
		expect(worker).not.toContain(SUBAGENT_ENABLE_STATE_LABEL.off);
	});
});
