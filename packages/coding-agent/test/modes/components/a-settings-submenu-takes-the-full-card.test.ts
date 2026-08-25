/**
 * A settings submenu owns the whole card while it is open.
 *
 * WHY THIS SUITE EXISTS. A drill-down (enum picker, roster, threshold) used to
 * render inside the right-hand pane beside the category sidebar: 22 columns of
 * inert tabs the keyboard could not reach squeezed every nested list into half
 * the card, and option descriptions clipped to fragments ("The model's con…").
 * Worse, the one thing the sidebar COULD do there — be clicked — discarded the
 * open submenu without a word. The sidebar now hides while a submenu owns the
 * card; the breadcrumb and the "esc back" chip are the way out.
 *
 * What this does not catch: mouse hit columns (covered by
 * every-settings-submenu-answers-the-pointer), and the search-mode sidebar.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 100, rows: 40 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function frame(component: SettingsSelectorComponent): string[] {
	return component.render(100).map(stripVTControlCharacters);
}

describe("a settings submenu takes the full card", () => {
	it("hides the category sidebar while a submenu is open", () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: [],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("model");
		expect(component.selectSetting("compaction.threshold")).toBe(true);
		component.handleInput("\n");

		const lines = frame(component);
		// Sidebar category names sit left of the hairline; with the sidebar gone
		// no line carries them, while the breadcrumb names the open drill-down.
		expect(lines.some(line => line.includes("Interaction"))).toBe(false);
		expect(lines.some(line => line.includes("Subagents"))).toBe(false);
		expect(lines.some(line => line.includes("› Auto-Compaction Threshold"))).toBe(true);
	});

	it("shows the sidebar again once the submenu closes", () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: [],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("model");
		expect(component.selectSetting("compaction.threshold")).toBe(true);
		component.handleInput("\n");
		component.handleInput("\x1b");

		const lines = frame(component);
		expect(lines.some(line => line.includes("Interaction"))).toBe(true);
	});
});
