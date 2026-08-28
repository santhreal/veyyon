/**
 * Files → LSP is one row you enter; each nested piece is its own switch.
 *
 * Sibling rows on Files with names like Language Servers / Agent Tool /
 * Diagnostics after Write were unreadable as a flat list. The master is the
 * row you open. Nested knobs stay real settings (search and config still
 * name them) but they are not Files-tab siblings of that row.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import {
	formatLspSummary,
	getSettingDef,
	getSettingsForTab,
	invalidateSettingDefsCache,
	isNestedLspKnob,
	LSP_SETTING_PATHS,
	lspPanelPaths,
	settingsSearchLandingPath,
} from "@veyyon/coding-agent/modes/components/selectors/settings-defs";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	invalidateSettingDefsCache();
});

afterEach(() => {
	resetSettingsForTest();
	invalidateSettingDefsCache();
});

describe("the Files → LSP nested panel", () => {
	it("treats Language Servers as the enterable parent, not a boolean Files row", () => {
		const def = getSettingDef("lsp.enabled");
		expect(def?.type).toBe("lsp");
		expect(def?.label).toBe("Language Servers");
	});

	it("keeps every nested piece as its own boolean setting", () => {
		const nested = LSP_SETTING_PATHS.filter(path => path !== "lsp.enabled");
		expect(nested.length).toBeGreaterThanOrEqual(5);
		for (const path of nested) {
			expect(isNestedLspKnob(path)).toBe(true);
			expect(getSettingDef(path)?.type).toBe("boolean");
		}
		expect(isNestedLspKnob("lsp.enabled")).toBe(false);
	});

	it("still lists nested knobs on the Files tab for search, behind the master condition", () => {
		const paths = getSettingsForTab("files").map(def => def.path);
		expect(paths).toContain("lsp.enabled");
		expect(paths).toContain("lsp.tool");
		expect(paths).toContain("lsp.diagnosticsOnWrite");
		const tool = getSettingDef("lsp.tool");
		expect(tool?.condition).toBeDefined();
		settings.set("lsp.enabled", false);
		expect(tool?.condition?.()).toBe(false);
		settings.set("lsp.enabled", true);
		expect(tool?.condition?.()).toBe(true);
	});

	it("summarises the nested page on the parent row", () => {
		expect(formatLspSummary()).toBe("Off");
		settings.set("lsp.enabled", true);
		expect(formatLspSummary()).toBe("On · tool · write");
		settings.set("lsp.tool", false);
		settings.set("lsp.diagnosticsOnWrite", false);
		expect(formatLspSummary()).toBe("On · servers only");
		settings.set("lsp.diagnosticsOnEdit", true);
		settings.set("lsp.formatOnWrite", true);
		expect(formatLspSummary()).toBe("On · edit · format");
	});

	it("lands search for a nested knob on the enterable parent", () => {
		expect(settingsSearchLandingPath("lsp.tool")).toBe("lsp.enabled");
		expect(settingsSearchLandingPath("lsp.diagnosticsOnWrite")).toBe("lsp.enabled");
		expect(settingsSearchLandingPath("lsp.enabled")).toBe("lsp.enabled");
		expect(settingsSearchLandingPath("bash.enabled")).toBe("bash.enabled");
	});

	it("hides nested switches on the page until Language Servers is on", () => {
		settings.set("lsp.enabled", false);
		expect([...lspPanelPaths()]).toEqual(["lsp.enabled"]);
		settings.set("lsp.enabled", true);
		expect([...lspPanelPaths()]).toEqual([...LSP_SETTING_PATHS]);
	});

	it("draws every LSP row on the nested page, so a new lsp setting cannot go missing", () => {
		// Files drops every `lsp.*` row but the parent, and the page draws only
		// LSP_SETTING_PATHS. A new lsp row missing from that list is reachable
		// from neither surface, so the expected set is read off the schema at run
		// time instead of being restated here.
		const rows = (Object.keys(SETTINGS_SCHEMA) as SettingPath[])
			.filter(path => path.startsWith("lsp.") && getSettingDef(path) !== undefined)
			.sort();
		expect(rows).toEqual([...LSP_SETTING_PATHS].sort());
	});
});
