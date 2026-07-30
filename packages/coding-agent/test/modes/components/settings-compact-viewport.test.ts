/**
 * Compact settings layouts must keep keyboard actions visible. If the viewport
 * cannot carry a usable pane, the component becomes explicitly non-actionable.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const DOWN = "\x1b[B";
let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function createSelector(onCancel: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel },
	);
}

function strippedFrame(component: SettingsSelectorComponent, width: number): string[] {
	return component.render(width).map(stripVTControlCharacters);
}

describe("settings compact viewport", () => {
	/** A short but usable modal must scroll with its selection instead of clipping the active row. */
	it("keeps every traversed Appearance row visible at 70 by 14", () => {
		geometryStub = stubStdoutGeometry({ columns: 70, rows: 14 });
		const component = createSelector();

		for (let step = 0; step <= 10; step++) {
			const id = component.getSelectedSettingId();
			expect(id).toBeDefined();
			const label = id ? getSettingsForTab("appearance").find(def => def.path === id)?.label : undefined;
			expect(label).toBeDefined();
			const selectedLine = strippedFrame(component, 70).find(line => (label ? line.includes(label) : false));
			expect(selectedLine).toContain("›");
			component.handleInput(DOWN);
		}
	});

	/** A terminal too narrow for labels plus state must refuse edits instead of hiding the target of Enter. */
	it("shows a non-actionable resize message at 24 columns", () => {
		geometryStub = stubStdoutGeometry({ columns: 24, rows: 14 });
		const component = createSelector();
		expect(component.selectSetting("colorBlindMode")).toBe(true);

		const frame = strippedFrame(component, 24);
		component.handleInput("\n");

		expect(frame.join("\n")).toContain("Settings needs more room");
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
	});

	/** Real terminal height is authoritative; undersized screens must not receive fabricated off-screen rows. */
	it("honors sub-14-row terminals and leaves only Escape active", () => {
		geometryStub = stubStdoutGeometry({ columns: 70, rows: 8 });
		const cancellations: string[] = [];
		const component = createSelector(() => cancellations.push("cancel"));
		expect(component.selectSetting("colorBlindMode")).toBe(true);

		const frame = strippedFrame(component, 70);
		expect(frame).toHaveLength(8);
		expect(frame.join("\n")).toContain("Settings needs a larger terminal");
		component.handleInput("\n");
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
		component.handleInput("\x1b");
		expect(cancellations).toEqual(["cancel"]);
	});
});
