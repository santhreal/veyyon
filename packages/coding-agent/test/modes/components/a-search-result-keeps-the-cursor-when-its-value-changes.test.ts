/**
 * WHY: global settings search re-ranks on every keystroke, so it pins the
 * cursor to the top match as the query refines. Without that pin an
 * intermediate keystroke strands the cursor on a row the next keystroke
 * demotes, and Enter activates a setting nobody was looking at.
 *
 * Changing a value on a result row recomputes the same list, because values
 * feed the searchable text and a condition gate may have flipped. That
 * recompute is not a query edit, and pinning there threw the cursor off the
 * row that was edited: change the third result and the cursor jumped to the
 * first, so the next Enter opened the wrong setting.
 *
 * The class this closes: a list refresh that cannot tell why it was asked to
 * refresh. Only a query edit re-pins; every other recompute keeps the
 * selection `SettingsList.setItems` already preserves by item id. Both arms
 * are asserted here, so restoring the unconditional pin fails the first test
 * and dropping the pin entirely fails the second.
 *
 * Not caught: ranking quality itself, and the row that stops matching its own
 * query after the edit. That row leaves the result set, and no selection can
 * be kept for an item that is gone.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const DOWN = "\x1b[B";
const ENTER = "\r";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ rows: 40 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

/** The pane row carrying the list cursor, stripped of styling. */
function cursorRow(comp: SettingsSelectorComponent): string {
	const row = comp
		.render(160)
		.map(line => stripVTControlCharacters(line))
		.find(line => /│\s+›\s\S/.test(line));
	expect(row).toBeDefined();
	return row ?? "";
}

/**
 * Open search on "notif" and step the cursor down to `target`, a result below
 * the top match, so a re-pin is observable as a jump back to the top.
 */
function searchAndStepTo(comp: SettingsSelectorComponent, target: string, steps: number): SettingsSelectorComponent {
	comp.render(160);
	for (const character of "notif") comp.handleInput(character);
	expect(comp.getSelectedSettingId()).toBe("ask.notify");
	for (let step = 0; step < steps; step++) comp.handleInput(DOWN);
	expect(comp.getSelectedSettingId()).toBe(target);
	return comp;
}

describe("a settings search result being edited", () => {
	it("keeps the cursor on the row whose value changed", () => {
		// A boolean toggles in place: no chooser opens, so the recompute that
		// follows is the only thing that can move the cursor.
		const comp = searchAndStepTo(createSelector(), "recap.enabled", 3);
		expect(settings.get("recap.enabled")).toBe(true);

		comp.handleInput(ENTER);

		expect(comp.getSelectedSettingId()).toBe("recap.enabled");
		expect(settings.get("recap.enabled")).toBe(false);
		const row = cursorRow(comp);
		expect(row).toContain("Idle Recap");
		expect(row).toContain("false");
	});

	it("follows the new top match when the query itself changes", () => {
		const comp = searchAndStepTo(createSelector(), "recap.enabled", 3);

		// One more character re-ranks: the cursor must land on the new best
		// match rather than stay on a row the refined query demoted.
		comp.handleInput("y");

		expect(comp.getSelectedSettingId()).toBe("ask.notify");
		expect(cursorRow(comp)).toContain("Ask Notification");
	});
});
