/**
 * Text-setting editors are transient selector state. Category changes and modal
 * dismissal must cancel that editor before routing any later keyboard input.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

function leftClick(frame: readonly string[], needle: string): string {
	const row = frame.findIndex(line => stripVTControlCharacters(line).includes(needle));
	const col = row >= 0 ? stripVTControlCharacters(frame[row]!).indexOf(needle) : -1;
	expect(row).toBeGreaterThanOrEqual(0);
	expect(col).toBeGreaterThanOrEqual(0);
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function createSelector(cancellations: string[]): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => cancellations.push("cancel") },
	);
}

function openExemptToolsEditor(component: SettingsSelectorComponent): readonly string[] {
	component.openTab("model");
	expect(component.selectSetting("model.toolCallLoopGuard.exemptTools")).toBe(true);
	component.handleInput("\n");
	component.handleInput("temporary-value");
	return component.render(120);
}

describe("settings text editor cancellation", () => {
	/** A category click must clear the selector-owned text-input flag before global search resumes. */
	it("restores normal keyboard routing after a sidebar switch", () => {
		const cancellations: string[] = [];
		const component = createSelector(cancellations);
		const frame = openExemptToolsEditor(component);

		component.handleInput(leftClick(frame, "Appearance"));
		for (const char of "theme") component.handleInput(char);
		const searched = component.render(120).map(stripVTControlCharacters).join("\n");

		expect(searched).toContain("⌕ theme");
		component.handleInput("\x1b");
		expect(cancellations).toEqual([]);
		expect(Settings.instance.get("model.toolCallLoopGuard.exemptTools")).not.toContain("temporary-value");
	});

	/** Closing the modal while editing must discard the buffer before the host receives cancellation. */
	it("discards an open text editor before mouse close", () => {
		const cancellations: string[] = [];
		const component = createSelector(cancellations);
		const frame = openExemptToolsEditor(component);

		component.handleInput(leftClick(frame, "[x]"));

		expect(cancellations).toEqual(["cancel"]);
		expect(Settings.instance.get("model.toolCallLoopGuard.exemptTools")).not.toContain("temporary-value");
	});
});
