/**
 * Discarding a draft is an edit, so undo brings it back.
 *
 * WHY THIS SUITE EXISTS. The composer gained a two-Escape gesture that throws away
 * whatever is typed. Two keystrokes that destroy a long prompt with no way back is a
 * worse defect than the missing gesture was, and the obvious implementation —
 * `setText("")` — is exactly that: `setText` loads text from somewhere else (shell
 * history, a resumed session) and drops the undo history along with it, because the
 * history describes text the buffer no longer holds.
 *
 * The class this closes is a buffer-clearing path that is unrecoverable. The members
 * are the two ways the stack is lost: clearing it (what `setText` does) and never
 * recording the state that is about to be destroyed. Both are asserted below, on the
 * real `Editor` rather than a fake, since the undo stack is the thing under test.
 *
 * WHAT IT DOES NOT CATCH: which keys reach `discardDraft`. The Esc-Esc gesture that
 * calls it is pinned in
 * `packages/coding-agent/test/input-controller-escape.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { Editor } from "@veyyon/tui";
import { defaultEditorTheme } from "./test-themes";

/** `ctrl+_`, one of the two default `tui.editor.undo` keys. */
const UNDO_KEY = "\x1f";

function editorWith(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	// Typed, not loaded: `setText` clears the undo stack, so a draft that arrived that
	// way could never prove anything about undo.
	editor.insertText(text);
	return editor;
}

describe("discardDraft", () => {
	it("clears the composer", () => {
		const editor = editorWith("a prompt worth abandoning");
		editor.discardDraft();
		expect(editor.getText()).toBe("");
	});

	it("leaves the discarded draft on the undo stack", () => {
		const editor = editorWith("a prompt worth abandoning");
		editor.discardDraft();
		editor.handleInput(UNDO_KEY);
		expect(editor.getText()).toBe("a prompt worth abandoning");
	});

	/**
	 * A multi-line draft comes back whole. The buffer is an array of lines, so a
	 * restore that kept only the cursor's line would still pass the single-line case.
	 */
	it("restores every line of a multi-line draft", () => {
		const editor = editorWith("first line\nsecond line\nthird line");
		editor.discardDraft();
		expect(editor.getText()).toBe("");
		editor.handleInput(UNDO_KEY);
		expect(editor.getText()).toBe("first line\nsecond line\nthird line");
	});

	/**
	 * NON-VACUITY, and the contrast that names the defect: `setText("")` clears the
	 * same buffer and is NOT undoable. If this ever starts restoring, the two paths
	 * have been collapsed into one and the comment above is wrong.
	 */
	it("is what makes the clear undoable, which setText is not", () => {
		const editor = editorWith("a prompt worth abandoning");
		editor.setText("");
		editor.handleInput(UNDO_KEY);
		expect(editor.getText()).toBe("");
	});

	/**
	 * Discarding nothing records nothing, so undo does not walk back past an empty
	 * composer into a draft the operator already discarded on purpose.
	 */
	it("records no undo state when there is nothing to discard", () => {
		const editor = editorWith("a prompt worth abandoning");
		editor.discardDraft();
		editor.discardDraft();
		editor.discardDraft();
		editor.handleInput(UNDO_KEY);
		expect(editor.getText()).toBe("a prompt worth abandoning");
	});
});
