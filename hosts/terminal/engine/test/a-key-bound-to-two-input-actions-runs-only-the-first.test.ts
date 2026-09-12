/**
 * WHY: the single-line Input answered `tui.editor.cursorRight` and then kept matching the same
 * bytes against every later binding, so a key a user bound to both cursorRight and a later action
 * ran both: the caret stepped right and then jumped to the line start. The defect is one dropped
 * `return` in a chain of fifteen; the class is any editing binding that falls through to a later
 * one. The sweep below binds one key to every ordered pair of table actions, so no member of the
 * table can fall through without a red run, and a binding added to the table is covered on arrival.
 *
 * Not caught: a precedence change that reorders the table on purpose (the test reads the order
 * the component states), and the multi-line Editor, which has its own chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Input } from "@veyyon/tui/components/input";
import {
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@veyyon/utils/keybindings";

const KEY = "ctrl+g";
const BYTES = "\x07";

/** The editing actions Input answers from its table, in the order the component states. */
const TABLE_ACTIONS: readonly Keybinding[] = [
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.yank",
	"tui.editor.yankPop",
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
];

function bind(...actions: readonly Keybinding[]): void {
	const config: KeybindingsConfig = {};
	for (const action of actions) config[action] = KEY;
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, config));
}

/** An input holding `ab cd` with the caret between `b` and the space, placed under default keys. */
function field(): Input {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const input = new Input();
	input.focused = true;
	input.setValue("ab cd");
	input.handleInput("\x01"); // ctrl+a: line start
	input.handleInput("\x1b[C"); // right
	input.handleInput("\x1b[C");
	return input;
}

function state(input: Input): string {
	input.handleInput("|");
	return input.getValue();
}

describe("a key bound to two Input actions runs only the first", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	it("steps right once when the key also means line start", () => {
		const input = field();
		bind("tui.editor.cursorRight", "tui.editor.cursorLineStart");
		input.handleInput(BYTES);
		expect(state(input)).toBe("ab |cd");
	});

	it("covers every ordered pair of table actions", () => {
		for (const [index, first] of TABLE_ACTIONS.entries()) {
			for (const second of TABLE_ACTIONS.slice(index + 1)) {
				const alone = field();
				bind(first);
				alone.handleInput(BYTES);
				const expected = state(alone);

				const paired = field();
				bind(first, second);
				paired.handleInput(BYTES);
				expect(state(paired)).toBe(expected);
			}
		}
	});

	it("names every table action the component answers, so a new binding is added here on arrival", () => {
		const outsideTable = Object.keys(TUI_KEYBINDINGS)
			.filter(id => id.startsWith("tui.editor.") && !TABLE_ACTIONS.includes(id as Keybinding))
			.sort();
		expect(outsideTable).toEqual([
			"tui.editor.cursorDown",
			"tui.editor.cursorUp",
			"tui.editor.jumpBackward",
			"tui.editor.jumpForward",
			"tui.editor.pageDown",
			"tui.editor.pageUp",
			"tui.editor.undo",
		]);
	});
});
