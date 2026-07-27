/**
 * What a bare line feed does in each interactive component, in both keyboard-protocol modes.
 *
 * WHY THIS SUITE EXISTS. `src/keys.ts` decides what a lone 0x0A means as a KEY: Shift+Enter when the
 * Kitty keyboard protocol is active, plain Enter without it (see `line-feed-shift-enter.test.ts`). What
 * a component then DOES with that byte is its own policy, and the policies disagree on purpose: the
 * editor inserts a newline in both modes, because terminals that map Shift+Enter to a line feed without
 * negotiating Kitty exist and their users expect a newline; a single-line input submits in both modes,
 * because it has nothing to insert; the settings list confirms. So the same keypress means "newline"
 * four lines away from where it means "submit", and that is correct rather than a bug.
 *
 * It was encoded as seven raw `data === "\n"` comparisons across three files, four of them in one file
 * with two meaning newline and two meaning submit, and nothing anywhere naming the distinction. They now
 * all call `isLoneLineFeed`, which carries the reason. This suite is what made that safe to do and is
 * what keeps it safe: every assertion is a statement of what ships, per component, per mode, so a change
 * to any component's answer shows up as a failure here rather than as a user noticing their message
 * submitted when they meant to add a line.
 *
 * Read a failure here as "this component's answer to Enter/Shift+Enter changed", not as "the test is
 * stale". If the change is intended, the intent belongs in the assertion, with the reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Editor } from "@veyyon/tui/components/editor";
import { Input } from "@veyyon/tui/components/input";
import { SettingsList, type SettingsListTheme } from "@veyyon/tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@veyyon/tui/keybindings";
import { isKittyProtocolActive, setKittyProtocolActive } from "@veyyon/tui/keys";
import { defaultEditorTheme } from "./test-themes";

const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";
const kittyBefore = isKittyProtocolActive();

const listTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

beforeEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	setKittyProtocolActive(kittyBefore);
});

/** An input that records every submit, so "did it submit" is a value and not an inference. */
function inputWithSubmitLog(value: string): { input: Input; submits: string[] } {
	const submits: string[] = [];
	const input = new Input();
	input.focused = true;
	input.setValue(value);
	input.onSubmit = submitted => submits.push(submitted);
	return { input, submits };
}

/** An editor that records every submit; its text is read back to see whether a newline landed. */
function editorWithSubmitLog(text: string): { editor: Editor; submits: string[] } {
	const submits: string[] = [];
	const editor = new Editor(defaultEditorTheme);
	editor.setText(text);
	editor.onSubmit = submitted => {
		submits.push(submitted);
	};
	return { editor, submits };
}

describe("Input, whose submit branch compares the raw byte", () => {
	/** Both modes submit, because the byte comparison at input.ts sits beside the binding check. */
	it("submits on a line feed with the protocol inactive", () => {
		setKittyProtocolActive(false);
		const { input, submits } = inputWithSubmitLog("hello");

		input.handleInput(LINE_FEED);

		expect(submits).toEqual(["hello"]);
	});

	/**
	 * The disagreement, recorded as it ships: the parser calls this Shift+Enter, and a single-line input
	 * submits on it anyway. Plausibly intended (a one-line field has nothing to insert), which is exactly
	 * why it has to be stated rather than discovered during a refactor.
	 */
	it("submits on a line feed with the protocol active, even though that is Shift+Enter", () => {
		setKittyProtocolActive(true);
		const { input, submits } = inputWithSubmitLog("hello");

		input.handleInput(LINE_FEED);

		expect(submits).toEqual(["hello"]);
	});

	/** The unambiguous byte, for contrast: CR is plain Enter in both modes and submits in both. */
	it("submits on a carriage return in both modes", () => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const { input, submits } = inputWithSubmitLog("hello");

			input.handleInput(CARRIAGE_RETURN);

			expect(submits).toEqual(["hello"]);
		}
	});
});

describe("Editor, where the newline branch runs before the submit branch", () => {
	/**
	 * With the protocol active the parser and the component agree: LF is Shift+Enter, which inserts a
	 * newline. This is the case that kept working while the native parser was answering `enter`, and it
	 * worked only because of the component's own byte check.
	 */
	it("inserts a newline on a line feed with the protocol active", () => {
		setKittyProtocolActive(true);
		const { editor, submits } = editorWithSubmitLog("one");

		editor.handleInput(LINE_FEED);

		expect(editor.getText()).toBe("one\n");
		expect(submits).toEqual([]);
	});

	/**
	 * And with the protocol INACTIVE it still inserts a newline, which is where the component and the
	 * parser part ways: the parser calls a bare LF plain Enter there, and plain Enter submits. The raw
	 * byte check wins because it is tested before the submit branch. Anyone routing these through the
	 * keybinding layer has to decide this case deliberately.
	 */
	it("also inserts a newline with the protocol inactive, where the parser says plain Enter", () => {
		setKittyProtocolActive(false);
		const { editor, submits } = editorWithSubmitLog("one");

		editor.handleInput(LINE_FEED);

		expect(editor.getText()).toBe("one\n");
		expect(submits).toEqual([]);
	});

	/** CR submits in both modes, which is the behaviour the LF branch is diverging from. */
	it("submits on a carriage return in both modes", () => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const { editor, submits } = editorWithSubmitLog("one");

			editor.handleInput(CARRIAGE_RETURN);

			expect(submits).toEqual(["one"]);
			expect(editor.getText()).toBe("");
		}
	});
});

describe("SettingsList, whose confirm branch compares the raw byte", () => {
	/** Confirming with LF cycles the value, and the mode does not change that today. */
	it("activates the selected setting on a line feed in both modes", () => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const changes: Array<[string, string]> = [];
			const list = new SettingsList(
				[{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] }],
				5,
				listTheme,
				(id, value) => changes.push([id, value]),
				() => {
					throw new Error("cancel must not fire on a line feed");
				},
			);

			list.handleInput(LINE_FEED);

			expect(changes).toEqual([["mode", "on"]]);
		}
	});
});
