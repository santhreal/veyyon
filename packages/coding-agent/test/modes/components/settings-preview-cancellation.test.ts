/**
 * Settings submenus may preview state without persisting it. Every way out of the
 * surface must cancel that transient state before the settings modal disappears.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

/** SGR left-button press at a 1-based screen row and column. */
function leftClick(row: number, col: number): string {
	return `\x1b[<0;${col};${row}M`;
}

function lineContaining(frame: readonly string[], needle: string): { row: number; text: string } {
	const row = frame.findIndex(line => stripVTControlCharacters(line).includes(needle));
	return { row, text: row >= 0 ? stripVTControlCharacters(frame[row]!) : "" };
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

function openThemePreview(events: string[]): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium", "light"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => events.push(`change:${path}:${String(value)}`),
			onThemePreview: value => {
				events.push(`preview:${value}`);
			},
			onCancel: () => events.push("cancel"),
		},
	);
	expect(Settings.instance.get("theme.dark")).toBe("titanium");
	expect(component.selectSetting("theme.dark")).toBe(true);
	component.handleInput("\n");
	component.handleInput("\x1b[B");
	expect(events).toEqual(["preview:light"]);
	return component;
}

describe("settings preview cancellation", () => {
	/** Clicking the frame close control must restore the saved theme before the host removes the modal. */
	it("restores an unsaved theme preview before mouse close", () => {
		const events: string[] = [];
		const component = openThemePreview(events);
		const frame = component.render(120);
		const title = lineContaining(frame, "[x]");
		expect(title.row).toBeGreaterThanOrEqual(0);

		component.handleInput(leftClick(title.row + 1, title.text.indexOf("[x]") + 2));

		expect(Settings.instance.get("theme.dark")).toBe("titanium");
		expect(events).toEqual(["preview:light", "preview:titanium", "cancel"]);
	});

	/** An outside click closes the modal too, so it must follow the same preview rollback path as `[x]`. */
	it("restores an unsaved theme preview before outside-click close", () => {
		const events: string[] = [];
		const component = openThemePreview(events);
		component.render(120);

		component.handleInput(leftClick(1, 1));

		expect(Settings.instance.get("theme.dark")).toBe("titanium");
		expect(events).toEqual(["preview:light", "preview:titanium", "cancel"]);
	});

	/** Switching categories discards an open picker but keeps settings open, so it must rollback without host cancellation. */
	it("restores an unsaved theme preview before a sidebar switch", () => {
		const events: string[] = [];
		const component = openThemePreview(events);
		const frame = component.render(120);
		const interaction = lineContaining(frame, "Interaction");
		expect(interaction.row).toBeGreaterThanOrEqual(0);

		component.handleInput(leftClick(interaction.row + 1, interaction.text.indexOf("Interaction") + 1));

		expect(Settings.instance.get("theme.dark")).toBe("titanium");
		expect(events).toEqual(["preview:light", "preview:titanium"]);
		expect(component.getSelectedSettingId()).not.toBe("theme.dark");
	});

	/** Confirming the preview persists it, and a later close must not roll back a value the operator accepted. */
	it("keeps a confirmed theme when the modal closes", () => {
		const events: string[] = [];
		const component = openThemePreview(events);
		component.handleInput("\n");
		const frame = component.render(120);
		const title = lineContaining(frame, "[x]");

		component.handleInput(leftClick(title.row + 1, title.text.indexOf("[x]") + 2));

		expect(Settings.instance.get("theme.dark")).toBe("light");
		expect(events).toEqual(["preview:light", "change:theme.dark:light", "cancel"]);
	});
});
