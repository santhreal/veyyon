/**
 * The cursor / ghost-hint gap contract.
 *
 * Why this suite exists: on an empty composer the placeholder hint was
 * emitted DIRECTLY after the cursor cell, so the cursor visually sat on the
 * hint's first character — the shipped `▏` software cursor renders on the
 * left edge of its cell and merged with the "a" of "ask anything", and in
 * terminal-cursor mode the hardware block covered the character outright
 * (user defect #3, 2026-07-22 screenshots). Every hint-composition path now
 * inserts exactly ONE blank cell between the cursor cell and the hint, and
 * drops the hint (never the gap alone) when the width budget cannot fit any
 * hint text.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const CURSOR = defaultEditorTheme.symbols.inputCursor;

function contentLine(editor: Editor, width: number): string {
	// The cursor marker is an APC sequence; stripVTControlCharacters treats an
	// unterminated APC as running to end of line, so remove the marker FIRST.
	const lines = editor.render(width).map(l => stripVTControlCharacters(l.replaceAll(CURSOR_MARKER, "")));
	// Bordered editors put content on row 1; borderless on row 0.
	return (lines.length > 1 ? lines[1] : lines[0]) ?? "";
}

describe("editor placeholder cursor gap", () => {
	/** The exact regression: software cursor, empty input, placeholder set.
	 * The hint must start one blank cell after the cursor glyph, not flush
	 * against it. */
	it("renders one blank cell between the software cursor and the placeholder", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setPlaceholder("ask anything · / for commands");
		const line = contentLine(editor, 60);
		expect(line).toContain(`${CURSOR} ask anything · / for commands`);
		expect(line).not.toContain(`${CURSOR}ask`);
	});

	/** Terminal-cursor mode: the hardware cursor parks on the marker cell, so
	 * the gap must exist in the emitted text itself for the hint to clear it. */
	it("keeps the gap in terminal-cursor mode", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setUseTerminalCursor(true);
		editor.focused = true;
		editor.setPlaceholder("ask anything");
		const raw = editor.render(60)[0] ?? "";
		// The marker (where the hardware cursor lands) is followed by the
		// one-cell gap, then the styled hint — never the hint directly.
		expect(raw).toContain(`${CURSOR_MARKER} `);
		expect(stripVTControlCharacters(raw.replaceAll(CURSOR_MARKER, ""))).toContain(" ask anything");
		expect(raw).not.toContain(`${CURSOR_MARKER}\x1b[2mask`);
	});

	/** A cursorOverride glyph (e.g. the bash-mode `!`) gets the same gap. */
	it("keeps the gap with a cursor override glyph", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.cursorOverride = "!";
		editor.cursorOverrideWidth = 1;
		editor.setPlaceholder("run a command");
		const line = contentLine(editor, 60);
		expect(line).toContain("! run a command");
		expect(line).not.toContain("!run a command");
	});

	/** Boundary: when the width budget has no room for hint text after the
	 * gap, the hint AND the gap are both dropped — never a dangling trailing
	 * space that widens the row past the cursor. */
	it("drops the hint and the gap together when no width remains", () => {
		const editor = new Editor(defaultEditorTheme);
		// Borderless: the test-theme cursor `|` would collide with border glyphs.
		editor.setBorderVisible(false);
		editor.setPlaceholder("ask anything");
		const line = contentLine(editor, 2);
		expect(line).not.toContain("ask");
		expect(line.trimEnd().endsWith(CURSOR)).toBe(true);
	});

	/** The gap is exactly one cell — a double gap would recreate the uneven
	 * spacing family of defects the composer just shed. */
	it("uses exactly one cell of gap, not more", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setPlaceholder("ask anything");
		const line = contentLine(editor, 60);
		expect(line).not.toContain(`${CURSOR}  ask`);
	});
});
