import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "@veyyon/tui/components/editor";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@veyyon/tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

/**
 * Editor adversarial input: multi-byte, paste-like bursts, clear, and
 * independent history. Drives the shipped Editor component API.
 */

describe("Editor adversarial input", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("accepts unicode graphemes and reports them via getText", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("日本語🎉");
		expect(editor.getText()).toBe("日本語🎉");
	});

	it("handles a long single paste without losing the head or tail", () => {
		const editor = new Editor(defaultEditorTheme);
		const body = "A".repeat(500) + "MID" + "Z".repeat(500);
		editor.handleInput(body);
		expect(editor.getText().startsWith("AAA")).toBe(true);
		expect(editor.getText().endsWith("ZZZ")).toBe(true);
		expect(editor.getText()).toContain("MID");
		expect(editor.getText().length).toBe(body.length);
	});

	it("setText replaces prior content exactly", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("old");
		editor.setText("new-content");
		expect(editor.getText()).toBe("new-content");
		const rendered = stripVTControlCharacters(editor.render(40).join("\n"));
		expect(rendered).toContain("new-content");
		expect(rendered.includes("old")).toBe(false);
	});

	it("history up after two entries lands on the most recent", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.addToHistory("first");
		editor.addToHistory("second");
		editor.handleInput("\x1b[A"); // up
		expect(editor.getText()).toBe("second");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("first");
	});

	it("empty editor render differs from non-empty under the same width", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setPlaceholder("hint");
		const empty = stripVTControlCharacters(editor.render(30).join("\n"));
		editor.handleInput("typed");
		const filled = stripVTControlCharacters(editor.render(30).join("\n"));
		expect(filled).not.toBe(empty);
		expect(filled).toContain("typed");
	});
});
