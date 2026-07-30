/**
 * Settings navigation is contextual: each category remembers its own cursor, and
 * rebuilding a category must keep that cursor visible or choose a visible fallback.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { SettingTab } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const WIDTH = 70;

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: WIDTH, rows: 14 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium", "light"],
			availablePersonalities: ["default", "friendly"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

function driveDownTo(component: SettingsSelectorComponent, targetId: string): void {
	for (let step = 0; step < 64 && component.getSelectedSettingId() !== targetId; step++) {
		component.handleInput(DOWN);
	}
	expect(component.getSelectedSettingId()).toBe(targetId);
}

function expectSelectedRowVisible(component: SettingsSelectorComponent, tab: SettingTab, targetId: string): void {
	expect(component.getSelectedSettingId()).toBe(targetId);
	const definition = getSettingsForTab(tab).find(candidate => candidate.path === targetId);
	expect(definition).toBeDefined();
	const selectedLine = component
		.render(WIDTH)
		.map(stripVTControlCharacters)
		.find(line => (definition ? line.includes(definition.label) : false));
	expect(selectedLine).toBeDefined();
	expect(selectedLine).toContain("›");
}

describe("SettingsSelectorComponent tab context", () => {
	/**
	 * Rebuilding a category used to reset its list to the first row. A keyboard
	 * cursor deep in Appearance and Model must instead survive repeated openTab
	 * round trips, with list scrolling keeping that exact row painted at 70x14.
	 */
	it("restores the last visible Appearance and Model setting after round trips", () => {
		const component = createSelector();

		driveDownTo(component, "statusLine.separator");
		expectSelectedRowVisible(component, "appearance", "statusLine.separator");

		component.openTab("model");
		driveDownTo(component, "includeModelInPrompt");
		expectSelectedRowVisible(component, "model", "includeModelInPrompt");

		component.openTab("appearance");
		expectSelectedRowVisible(component, "appearance", "statusLine.separator");

		component.openTab("model");
		expectSelectedRowVisible(component, "model", "includeModelInPrompt");
	});

	/**
	 * A remembered id can disappear when its schema condition changes. Restoring
	 * that category must reject the stale id and select the first visible setting,
	 * never leave an invisible cursor or revive the condition-gated row.
	 */
	it("falls back to a visible setting when the remembered row becomes hidden", () => {
		settings.set("memory.backend", "hindsight");
		const component = createSelector();

		component.openTab("memory");
		driveDownTo(component, "hindsight.apiUrl");
		expectSelectedRowVisible(component, "memory", "hindsight.apiUrl");

		component.openTab("appearance");
		component.openTab("memory");
		expectSelectedRowVisible(component, "memory", "hindsight.apiUrl");

		component.openTab("appearance");
		settings.set("memory.backend", "off");
		component.openTab("memory");

		expectSelectedRowVisible(component, "memory", "memory.backend");
		const frame = component.render(WIDTH).map(stripVTControlCharacters).join("\n");
		expect(frame).toContain("Memory Backend");
		expect(frame).not.toContain("Hindsight API URL");
	});

	/**
	 * When a condition hides a remembered row in the middle of a category, the
	 * fallback must stay near that row instead of jumping to the category start.
	 */
	it("selects the nearest visible row when a remembered conditional row disappears", () => {
		settings.set("argot.enabled", true);
		const component = createSelector();

		component.openTab("experimental");
		driveDownTo(component, "argot.subagents");
		component.openTab("appearance");
		settings.set("argot.enabled", false);
		component.openTab("experimental");

		expectSelectedRowVisible(component, "experimental", "tools.format");
		const frame = component.render(WIDTH).map(stripVTControlCharacters).join("\n");
		expect(frame).toContain("Tool Calling Mode");
		expect(frame).not.toContain("Argot in Subagents");
	});

	/**
	 * Search is also navigation: Escape lands on the exact result. That jump must
	 * become Model's remembered cursor without erasing the Appearance cursor that
	 * existed before search replaced the pane.
	 */
	it("preserves tab cursors across a search jump and Escape exit", () => {
		const component = createSelector();
		driveDownTo(component, "statusLine.separator");

		for (const character of "include model in prompt") component.handleInput(character);
		expectSelectedRowVisible(component, "model", "includeModelInPrompt");

		component.handleInput(ESCAPE);
		expectSelectedRowVisible(component, "model", "includeModelInPrompt");

		component.openTab("appearance");
		expectSelectedRowVisible(component, "appearance", "statusLine.separator");
		component.openTab("model");
		expectSelectedRowVisible(component, "model", "includeModelInPrompt");
	});
});
