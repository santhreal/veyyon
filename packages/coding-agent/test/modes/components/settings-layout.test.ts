import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	TAB_GROUPS,
} from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";

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

	/**
	 * Every group the tab DECLARES is reachable, exactly once, in declaration order.
	 *
	 * The previous version of this case computed its expectation as
	 * `TAB_GROUPS[tab].filter(group => grouped.includes(group))`, which derives the
	 * expected list from the observed one: a group that disappeared from the panel
	 * dropped out of both sides and the equality still held. Measured by making one
	 * real appearance group unreachable from `getSettingsForTab`, which left all
	 * eleven cases in this file green while the group was gone from /settings. That
	 * is the exact symptom the preflight entry for this suite names, so the suite was
	 * asserting order and calling it coverage.
	 *
	 * Comparing against `TAB_GROUPS[tab]` as WRITTEN pins all three properties at
	 * once: every declared group present, none twice, and in declaration order. A
	 * group with no settings behind it is therefore a failure rather than an empty
	 * section, which is why `experimental` no longer declares a "Display" group: it
	 * was introduced with the tab and never had a setting.
	 */
	it("renders every group TAB_GROUPS declares, once each, in declaration order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear. A group
			// appearing twice survives this collapse and breaks the equality below,
			// which is how non-contiguous sections are caught.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			const grouped = sequence.filter(group => group !== "");
			expect(grouped).toEqual([...TAB_GROUPS[tab]]);
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

	it("exposes Default Effort in the model tab as the one effort control", () => {
		// The profile's effort surface is the `defaultEffort` list. Its predecessor
		// `defaultThinkingLevel` stays in the schema for migration only and must NOT
		// come back as a second UI row: two settings writing one axis, neither
		// stating which wins, is what made effort unreadable (report 2026-07-24).
		const rows = getSettingsForTab("model");
		expect(rows.find(item => item.path === "defaultEffort")).toMatchObject({
			path: "defaultEffort",
			tab: "model",
			group: "Thinking",
			label: "Default Effort",
		});
		expect(rows.find(item => item.path === "defaultThinkingLevel")).toBeUndefined();
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
