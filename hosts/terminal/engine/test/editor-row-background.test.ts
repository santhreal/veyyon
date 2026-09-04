/**
 * Editor quiet card (DS-6 layer 0) — setRowBackground paints a tonal ground
 * under every input row in gutter mode. The card must be CONTINUOUS: the
 * reverse-video cursor emits a full SGR reset (\x1b[0m) mid-row, which would
 * punch a terminal-default hole in the card unless the ground is re-opened
 * right after it. Rows close with \x1b[49m (background-only reset) so the
 * card never leaks into surrounding chrome.
 *
 * Locks:
 *  1. Every input row opens with the ground and closes with \x1b[49m.
 *  2. Inner \x1b[0m resets are immediately followed by a ground re-open.
 *  3. Clearing (undefined or "") restores byte-identical pre-feature output.
 *  4. The framed (borderVisible) editor never paints the card.
 */
import { describe, expect, it } from "bun:test";
import { Editor } from "../src/components/editor";
import { defaultEditorTheme } from "./test-themes";

const GROUND = "\x1b[48;2;12;14;18m";

function makeEditor(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setPromptGutter("  > ");
	editor.setText("hello card");
	return editor;
}

describe("Editor.setRowBackground — the quiet card", () => {
	it("opens every input row with the ground and closes with a bg-only reset", () => {
		const editor = makeEditor();
		editor.setRowBackground(GROUND);
		const rows = editor.render(40);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.startsWith(GROUND)).toBe(true);
			expect(row.endsWith("\x1b[49m")).toBe(true);
		}
	});

	it("re-opens the ground after every inner full reset (a reset can't punch a hole)", () => {
		const editor = makeEditor();
		// decorateText is the public path that injects styled spans; reverse
		// video + full reset is exactly what the block cursor emits.
		editor.decorateText = t => t.replace("card", "\x1b[7mcard\x1b[0m");
		editor.setRowBackground(GROUND);
		const rows = editor.render(40).join("\n");
		const resets = [...rows.matchAll(/\x1b\[0m/g)];
		expect(resets.length).toBeGreaterThan(0);
		for (const m of resets) {
			const after = rows.slice(m.index! + m[0].length, m.index! + m[0].length + GROUND.length);
			expect(after).toBe(GROUND);
		}
	});

	it("renders byte-identically to the pre-feature output when cleared", () => {
		const plain = makeEditor().render(40);
		const cleared = makeEditor();
		cleared.setRowBackground(GROUND);
		cleared.setRowBackground(undefined);
		expect(cleared.render(40)).toEqual(plain);
		const emptied = makeEditor();
		emptied.setRowBackground("");
		expect(emptied.render(40)).toEqual(plain);
	});

	it("never paints the framed (borderVisible) editor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(true);
		editor.setText("framed");
		const before = editor.render(40);
		editor.setRowBackground(GROUND);
		expect(editor.render(40)).toEqual(before);
	});
});
