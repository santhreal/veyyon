/**
 * A composer prediction is ghost text over the empty composer. The user sends it only by
 * pressing Tab to insert it and then Enter: Enter alone never submits it, typing dismisses it
 * for good, and it never shows over text the user wrote. Its accept hint shows after it, gives
 * way to the suggestion only on a row too narrow for both, and leaves with it.
 *
 * Not covered: when a prediction is requested or cleared, which the terminal mode controls.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { visibleWidth } from "@veyyon/utils/width";
import { defaultEditorTheme } from "./test-themes";

const PREDICTION = "run the failing test again";

const ACCEPT = "· tab to accept";

function contentLine(editor: Editor, width = 80): string {
	const lines = editor.render(width).map(l => stripVTControlCharacters(l.replaceAll(CURSOR_MARKER, "")));
	return (lines.length > 1 ? lines[1] : lines[0]) ?? "";
}

function predictingEditor(acceptHint?: string): { editor: Editor; submitted: string[] } {
	const editor = new Editor(defaultEditorTheme);
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text);
	};
	editor.setPlaceholder("ask anything");
	editor.setPrediction(PREDICTION, acceptHint);
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

	describe("accept hint", () => {
		it("follows the suggestion one cell after it", () => {
			const { editor } = predictingEditor(ACCEPT);
			expect(contentLine(editor)).toContain(`${PREDICTION} ${ACCEPT}`);
		});

		it("follows a suggestion shorter than itself when the row holds both", () => {
			const { editor } = predictingEditor(ACCEPT);
			editor.setPrediction("run it", ACCEPT);
			expect(contentLine(editor)).toContain(`run it ${ACCEPT}`);
		});

		it("follows a short suggestion on a row narrower than the hint needs for truncation", () => {
			const { editor } = predictingEditor(ACCEPT);
			editor.setPrediction("run it", ACCEPT);
			// 24 content cells: cursor, gap, "run it", gap, hint. Both fit whole, while the room
			// left for the suggestion beside the hint is less than the hint's own width.
			const width = 24 + (80 - editor.getTopBorderAvailableWidth(80));
			const line = contentLine(editor, width);
			expect(line).toContain(`run it ${ACCEPT}`);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});

		it("is absent when none is given", () => {
			const { editor } = predictingEditor();
			expect(contentLine(editor)).not.toContain("accept");
		});

		it("leaves with the suggestion when the user types, and does not return on erase", () => {
			const { editor } = predictingEditor(ACCEPT);
			editor.handleInput("x");
			expect(contentLine(editor)).not.toContain(ACCEPT);
			editor.handleInput("\x7f");
			expect(contentLine(editor)).not.toContain(ACCEPT);
			expect(contentLine(editor)).toContain("ask anything");
		});

		it("leaves when Tab inserts the suggestion", () => {
			const { editor } = predictingEditor(ACCEPT);
			editor.handleInput("\t");
			expect(editor.getText()).toBe(PREDICTION);
			expect(contentLine(editor)).not.toContain(ACCEPT);
		});

		it("is cleared by a later prediction that gives none", () => {
			const { editor } = predictingEditor(ACCEPT);
			editor.setPrediction("run lint");
			expect(contentLine(editor)).toContain("run lint");
			expect(contentLine(editor)).not.toContain("accept");
		});

		it("stays whole on a narrow row while the suggestion is truncated", () => {
			const { editor } = predictingEditor(ACCEPT);
			const line = contentLine(editor, 40);
			expect(line).toContain(ACCEPT);
			expect(line).not.toContain(PREDICTION);
			expect(line).toContain("run the");
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		});

		it("is dropped when keeping it would leave the suggestion fewer cells than itself", () => {
			const { editor } = predictingEditor(ACCEPT);
			const line = contentLine(editor, 30);
			expect(line).not.toContain("accept");
			expect(line).toContain("run the");
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		});
	});
});
