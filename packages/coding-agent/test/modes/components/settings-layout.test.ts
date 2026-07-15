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

	it("keeps advanced snapcompact shapes schema-only (not in the lean settings UI)", () => {
		const def = getSettingsForTab("appearance")
			.concat(getSettingsForTab("model"))
			.concat(getSettingsForTab("editor"))
			.concat(getSettingsForTab("privacy"))
			.concat(getSettingsForTab("advanced"))
			.find(def => def.path === "snapcompact.shape");

		expect(def).toBeUndefined();
		expect(SETTINGS_SCHEMA["snapcompact.shape"].values).toContain("silver16-bw");
	});

	it("keeps advisor sub-settings schema-only in the lean settings UI", () => {
		const advisorDependentPaths: SettingPath[] = ["advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"];
		const visible = SETTING_TABS.flatMap(tab => getSettingsForTab(tab));
		for (const path of advisorDependentPaths) {
			expect(visible.some(def => def.path === path)).toBe(false);
		}
	});

	it("keeps provider request limits schema-only in the lean settings UI", () => {
		const visible = SETTING_TABS.flatMap(tab => getSettingsForTab(tab));
		expect(visible.some(def => def.path === "providers.maxInFlightRequests")).toBe(false);
	});

	it("keeps retry fallback chains schema-only in the lean settings UI", () => {
		const visible = SETTING_TABS.flatMap(tab => getSettingsForTab(tab));
		expect(visible.some(def => def.path === "retry.fallbackChains")).toBe(false);
	});

	it("keeps ask.enabled schema-only in the lean settings UI", () => {
		const visible = SETTING_TABS.flatMap(tab => getSettingsForTab(tab));
		expect(visible.some(def => def.path === "ask.enabled")).toBe(false);
	});

	it("exposes core model thinking controls in the lean model tab", () => {
		const def = getSettingsForTab("model").find(item => item.path === "defaultThinkingLevel");
		expect(def).toMatchObject({
			path: "defaultThinkingLevel",
			tab: "model",
			group: "Thinking",
		});
	});

	it("exposes privacy notifications in the lean privacy tab", () => {
		const def = getSettingsForTab("privacy").find(item => item.path === "completion.notify");
		expect(def).toMatchObject({
			path: "completion.notify",
			tab: "privacy",
			group: "Notifications",
		});
	});
});
