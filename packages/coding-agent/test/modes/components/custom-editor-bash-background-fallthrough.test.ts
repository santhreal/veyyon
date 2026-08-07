/**
 * Ctrl+B is two keys at once, and the editor decides which one fired.
 *
 * WHY THIS SUITE EXISTS. `app.bash.background` defaults to ctrl+b, which is also
 * the readline cursor-left binding (`tui.editor.cursorLeft` ships as
 * `["left", "ctrl+b"]`). The composer therefore consumes the key CONDITIONALLY:
 * `onBashBackground()` reports whether a foreground command actually took it, and
 * only a `true` swallows the keystroke. Every other action in that dispatch chain
 * returns unconditionally, so this one branch is easy to "simplify" into a plain
 * `return` and nobody notices until ctrl+b stops moving the cursor while typing.
 *
 * The registry suite already proves the request side reports `false` with nothing
 * waiting. What was untested is that the editor OBEYS that `false`: the reported
 * symptom was a dead key, and a key that swallows the keystroke and does nothing
 * is the same dead key from the other direction.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@veyyon/coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const CTRL_B = "\x02";

describe("ctrl+b in the composer", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function editorWithText(text: string): CustomEditor {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.bash.background", ["ctrl+b"]);
		editor.setText(text);
		return editor;
	}

	it("falls through to readline cursor-left when no foreground command is waiting", () => {
		const editor = editorWithText("abcd");
		const onBashBackground = vi.fn(() => false);
		editor.onBashBackground = onBashBackground;
		const before = editor.getCursor();

		editor.handleInput(CTRL_B);

		expect(onBashBackground).toHaveBeenCalledTimes(1);
		expect(editor.getCursor()).toEqual({ line: before.line, col: before.col - 1 });
		expect(editor.getText()).toBe("abcd");
	});

	it("consumes the key and leaves the cursor alone when a foreground command takes it", () => {
		const editor = editorWithText("abcd");
		const onBashBackground = vi.fn(() => true);
		editor.onBashBackground = onBashBackground;
		const before = editor.getCursor();

		editor.handleInput(CTRL_B);

		expect(onBashBackground).toHaveBeenCalledTimes(1);
		expect(editor.getCursor()).toEqual(before);
		expect(editor.getText()).toBe("abcd");
	});

	/** No handler wired at all is the pre-feature composer: still cursor-left. */
	it("still moves the cursor when no background handler is wired", () => {
		const editor = editorWithText("abcd");
		const before = editor.getCursor();

		editor.handleInput(CTRL_B);

		expect(editor.getCursor()).toEqual({ line: before.line, col: before.col - 1 });
	});

	/** Remapping the action off ctrl+b must hand the key back to readline whole. */
	it("leaves ctrl+b as pure cursor-left once the action is remapped elsewhere", () => {
		const editor = editorWithText("abcd");
		editor.setActionKeys("app.bash.background", ["ctrl+alt+b"]);
		const onBashBackground = vi.fn(() => true);
		editor.onBashBackground = onBashBackground;
		const before = editor.getCursor();

		editor.handleInput(CTRL_B);

		expect(onBashBackground).not.toHaveBeenCalled();
		expect(editor.getCursor()).toEqual({ line: before.line, col: before.col - 1 });
	});
});
