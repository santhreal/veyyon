/**
 * WHY. Backspace in a list filter deletes one code point, not one UTF-16 unit. The filter used to
 * be split with `[...query]` and popped; the hot path now cuts by index, and an index cut has two ways
 * to drift from code-point semantics: leaving half of a surrogate pair behind, or eating a character
 * before a lone low surrogate because it looked like the tail of a pair.
 *
 * THE CLASS THIS CLOSES. Any index-based backspace in a filter field that disagrees with iterating
 * the string by code point. Both lists that own a filter query are driven through their real key
 * path, so a fresh rewrite of either site fails here before it ships.
 *
 * WHAT IT DOES NOT CATCH. Grapheme clusters wider than one code point (a flag, a ZWJ sequence): the
 * contract is and was one code point per keypress, so those take several presses in both versions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SelectList } from "@veyyon/tui/components/select-list";
import { SettingsList } from "@veyyon/tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@veyyon/utils/keybindings";

const BACKSPACE = "\x7f";

const box = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" };
const sharp = { ...box, teeDown: "┬", teeUp: "┴", teeLeft: "┤", teeRight: "├", cross: "┼" };
const identity = (text: string) => text;
const selectTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		hrChar: "─",
		quoteBorder: "│",
		boxRound: box,
		boxSharp: sharp,
		table: sharp,
		spinnerFrames: ["|"],
	},
};
const settingsTheme = {
	label: identity,
	value: identity,
	cursor: "›",
	description: identity,
	hint: identity,
	scrollInfo: identity,
};

/** The query the list is filtering on, read back from the rendered search row. */
function searchQuery(lines: readonly string[]): string {
	const row = lines.find(line => line.includes("Search: "));
	expect(row).toBeDefined();
	return row!
		.slice(row!.indexOf("Search: ") + "Search: ".length)
		.replace(/ · .*$/, "")
		.replace(/\|.*$/, "")
		.trimEnd();
}

const cases: ReadonlyArray<[label: string, typed: string, afterBackspace: string]> = [
	["a BMP character", "ab", "a"],
	["an astral character as a whole pair", "a😀", "a"],
	["a lone high surrogate", "a\ud83d", "a"],
	["a lone low surrogate without touching the character before it", "a\udc00", "a"],
];

describe("a filter backspace removes one code point", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	describe("SelectList", () => {
		for (const [label, typed, expected] of cases) {
			it(`removes ${label}`, () => {
				const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` }));
				const list = new SelectList(items, 3, selectTheme);
				for (const ch of typed) list.handleInput(ch);
				expect(searchQuery(list.render(80))).toBe(typed);
				list.handleInput(BACKSPACE);
				expect(searchQuery(list.render(80))).toBe(expected);
			});
		}
	});

	describe("SettingsList", () => {
		for (const [label, typed, expected] of cases) {
			it(`removes ${label}`, () => {
				const items = Array.from({ length: 6 }, (_, i) => ({
					id: `setting-${i}`,
					label: `Setting ${i}`,
					currentValue: "on",
					values: ["on", "off"],
				}));
				const list = new SettingsList(
					items,
					3,
					settingsTheme,
					() => {},
					() => {},
				);
				for (const ch of typed) list.handleInput(ch);
				expect(searchQuery(list.render(80))).toBe(typed);
				list.handleInput(BACKSPACE);
				expect(searchQuery(list.render(80))).toBe(expected);
			});
		}
	});
});
