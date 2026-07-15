import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/pi-coding-agent/config/settings";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	TAB_GROUPS,
} from "@veyyon/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/pi-coding-agent/modes/components/settings-defs";

interface UiShape {
	tab: SettingTab;
	group?: string;
}

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const path in SETTINGS_SCHEMA) {
			const ui = (SETTINGS_SCHEMA[path as keyof typeof SETTINGS_SCHEMA] as { ui?: UiShape }).ui;
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${path}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${path}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("exposes native terminal progress in the appearance settings menu", () => {
		const def = getSettingsForTab("appearance").find(def => def.path === "terminal.showProgress");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Native Terminal Progress",
			group: "Display",
		});
	});

	it("exposes a Personality row in the model settings menu with runtime-resolved options", () => {
		const def = getSettingsForTab("model").find(def => def.path === "personality");

		expect(def).toMatchObject({
			// A string schema type with ui.options: "runtime" resolves to a
			// submenu whose choices are injected by the selector layer at
			// render time (see settings-selector.ts #createSubmenu).
			type: "submenu",
			label: "Personality",
			group: "Prompt",
		});
		expect(SETTINGS_SCHEMA.personality.type).toBe("string");
		expect(SETTINGS_SCHEMA.personality.ui.options).toBe("runtime");
	});

	it("exposes snapcompact.shape under context Experimental", () => {
		const def = getSettingsForTab("context").find(item => item.path === "snapcompact.shape");
		expect(def).toMatchObject({
			path: "snapcompact.shape",
			tab: "context",
			group: "Experimental",
			label: "Snapcompact Shape",
		});
		expect(SETTINGS_SCHEMA["snapcompact.shape"].values).toContain("silver16-bw");
	});

	it("exposes advisor sub-settings under the model Advisor group", () => {
		const advisorDependentPaths: SettingPath[] = ["advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"];
		for (const path of advisorDependentPaths) {
			const def = getSettingsForTab("model").find(item => item.path === path);
			expect(def).toMatchObject({
				path,
				tab: "model",
				group: "Advisor",
			});
		}
	});

	it("exposes provider request limits on the providers Services group", () => {
		const def = getSettingsForTab("providers").find(item => item.path === "providers.maxInFlightRequests");
		expect(def).toMatchObject({
			path: "providers.maxInFlightRequests",
			tab: "providers",
			group: "Services",
			label: "Max In-Flight Requests",
		});
	});

	it("exposes retry fallback chains on the model Retry & Fallback group", () => {
		const def = getSettingsForTab("model").find(item => item.path === "retry.fallbackChains");
		expect(def).toMatchObject({
			path: "retry.fallbackChains",
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
		});
	});

	it("exposes ask.enabled on the tools Available Tools group", () => {
		const def = getSettingsForTab("tools").find(item => item.path === "ask.enabled");
		expect(def).toMatchObject({
			path: "ask.enabled",
			tab: "tools",
			group: "Available Tools",
			label: "Ask",
		});
	});

	it("exposes core model thinking controls in the model tab", () => {
		const def = getSettingsForTab("model").find(item => item.path === "defaultThinkingLevel");
		expect(def).toMatchObject({
			path: "defaultThinkingLevel",
			tab: "model",
			group: "Thinking",
		});
	});

	it("exposes completion notifications on the interaction Notifications group", () => {
		const def = getSettingsForTab("interaction").find(item => item.path === "completion.notify");
		expect(def).toMatchObject({
			path: "completion.notify",
			tab: "interaction",
			group: "Notifications",
		});
	});

	it("exposes Privacy as a providers tab group (no standalone privacy tab)", () => {
		expect(SETTING_TABS).not.toContain("privacy");
		expect(TAB_GROUPS.providers).toContain("Privacy");
	});
});
