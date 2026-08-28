/**
 * Emptying the settings search box leaves search mode.
 *
 * WHY THIS SUITE EXISTS. Backspacing the last character out of the settings
 * search left the dialog in search mode reporting "0 matches" against an empty
 * query, and only `esc` got back to the settings list. Clearing the box is the
 * ordinary way to undo a search, so the state the user could reach by typing
 * was one they could not leave the same way.
 *
 * THE CLASS. Emptying the box is not one keystroke: backspace, delete, the
 * word kill and the line kill all reach the same empty string through the
 * shared `Input`, so the exit has to hang off the resulting VALUE and never off
 * the key that produced it. Every route is swept below.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const BACKSPACE = "\x7f";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const HOME = "\x01";
const DELETE_FORWARD = "\x04";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

function frameText(comp: SettingsSelectorComponent): string {
	return comp.render(160).map(strip).join("\n");
}

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

function openSelector(): SettingsSelectorComponent {
	const comp = new SettingsSelectorComponent(
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
	comp.render(160);
	return comp;
}

/** In search mode the pane carries the match counter; the settings list never does. */
function inSearchMode(comp: SettingsSelectorComponent): boolean {
	return /\d+ match(es)?\b/.test(frameText(comp));
}

describe("clearing the settings search leaves search mode", () => {
	it("typing opens search and the counter appears", () => {
		const comp = openSelector();
		comp.handleInput("theme");

		expect(inSearchMode(comp)).toBe(true);
	});

	/** The incident: backspace to empty, and the dialog must be back on the settings list. */
	it("backspacing the query empty returns to the settings list", () => {
		const comp = openSelector();
		comp.handleInput("theme");
		for (let i = 0; i < "theme".length; i++) comp.handleInput(BACKSPACE);

		expect(inSearchMode(comp)).toBe(false);
	});

	/** A query that matches nothing is still a query you can back out of. */
	it("backspacing a zero-match query empty returns to the settings list", () => {
		const comp = openSelector();
		comp.handleInput("zzzqqq");
		expect(frameText(comp)).toContain("0 matches");

		for (let i = 0; i < "zzzqqq".length; i++) comp.handleInput(BACKSPACE);

		expect(inSearchMode(comp)).toBe(false);
	});

	/** THE CLASS: every other way the box reaches empty. */
	it.each([
		["ctrl+u line kill", CTRL_U],
		["ctrl+w word kill", CTRL_W],
	])("%s empties the query and returns to the settings list", (_label, key) => {
		const comp = openSelector();
		comp.handleInput("theme");
		comp.handleInput(key);

		expect(inSearchMode(comp)).toBe(false);
	});

	/**
	 * A box holding only spaces LOOKS cleared and matches nothing, so leaving it in
	 * search mode puts "cleared" and "0 matches" on screen at once with `esc` the only
	 * way out. Emptiness is what the box shows, not its character count.
	 */
	it("a query reduced to whitespace is treated as cleared", () => {
		const comp = openSelector();
		comp.handleInput("theme");
		comp.handleInput(CTRL_U);
		comp.handleInput("a");
		comp.handleInput(" ");
		comp.handleInput(HOME);
		comp.handleInput(DELETE_FORWARD);

		expect(inSearchMode(comp)).toBe(false);
	});
});
