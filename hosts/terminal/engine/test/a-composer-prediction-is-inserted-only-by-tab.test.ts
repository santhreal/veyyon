/**
 * A composer prediction is ghost text over the empty composer. The user sends it only by
 * pressing Tab to insert it and then Enter: Enter alone never submits it, typing dismisses it
 * for good, and it never shows over text the user wrote.
 *
 * Not covered: when a prediction is requested or cleared, which the terminal mode controls.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const PREDICTION = "run the failing test again";

function contentLine(editor: Editor): string {
	const lines = editor.render(80).map(l => stripVTControlCharacters(l.replaceAll(CURSOR_MARKER, "")));
	return (lines.length > 1 ? lines[1] : lines[0]) ?? "";
}

function predictingEditor(): { editor: Editor; submitted: string[] } {
	const editor = new Editor(defaultEditorTheme);
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text);
	};
	editor.setPlaceholder("ask anything");
	editor.setPrediction(PREDICTION);
	return { editor, submitted };
}

describe("composer prediction", () => {
	it("shows in place of the placeholder over an empty composer", () => {
		const { editor } = predictingEditor();
		const line = contentLine(editor);
		expect(line).toContain(PREDICTION);
		expect(line).not.toContain("ask anything");
	});

	it("is inserted by Tab and submitted only by the Enter after it", () => {
		const { editor, submitted } = predictingEditor();
		editor.handleInput("\t");
		expect(editor.getText()).toBe(PREDICTION);
		expect(submitted).toEqual([]);
		editor.handleInput("\r");
		expect(submitted).toEqual([PREDICTION]);
	});

	it("is not submitted by Enter over the empty composer", () => {
		const { editor, submitted } = predictingEditor();
		editor.handleInput("\r");
		expect(submitted).not.toContain(PREDICTION);
		expect(editor.getText()).toBe("");
	});

	it("is dismissed by typing and does not return when the text is erased", () => {
		const { editor } = predictingEditor();
		editor.handleInput("x");
		expect(contentLine(editor)).not.toContain(PREDICTION);
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("");
		expect(editor.prediction).toBeUndefined();
		expect(contentLine(editor)).toContain("ask anything");
		editor.handleInput("\t");
		expect(editor.getText()).not.toBe(PREDICTION);
	});

	it("is not inserted by Tab over text the composer already holds", () => {
		const { editor } = predictingEditor();
		editor.setText("draft");
		editor.handleInput("\t");
		expect(editor.getText()).not.toContain(PREDICTION);
	});

	it("treats an empty prediction as none", () => {
		const { editor } = predictingEditor();
		editor.setPrediction("");
		expect(editor.prediction).toBeUndefined();
		expect(contentLine(editor)).toContain("ask anything");
	});
});
