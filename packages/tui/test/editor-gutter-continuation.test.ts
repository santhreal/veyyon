/**
 * Editor multiline continuation whisper (DS-6) — setPromptGutterContinuation
 * puts a styled glyph (the composer's dim `┆`) in the gutter of wrapped and
 * subsequent input rows, so a multi-line draft reads as one body with a quiet
 * spine. The continuation must occupy EXACTLY the prompt gutter's width
 * (space-padded) or every wrapped row's content shifts out of column.
 *
 * Locks:
 *  1. Row 1 keeps the prompt gutter; rows 2+ carry the continuation glyph.
 *  2. Continuation rows align: visible width of the continuation equals the
 *     prompt gutter's width.
 *  3. Clearing restores the blank-padding continuation byte-identically.
 *  4. Single-row input never shows the whisper.
 */
import { describe, expect, it } from "bun:test";
import { Editor } from "../src/components/editor";
import { visibleWidth } from "../src/utils";
import { defaultEditorTheme } from "./test-themes";

const GUTTER = "  > ";
const WHISPER = "  \x1b[2m┆\x1b[22m ";

function makeEditor(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setPromptGutter(GUTTER);
	editor.setText(text);
	return editor;
}

describe("Editor.setPromptGutterContinuation — the multiline whisper", () => {
	it("shows the whisper on rows 2+ and the prompt on row 1", () => {
		const editor = makeEditor("first line\nsecond line\nthird line");
		editor.setPromptGutterContinuation(WHISPER);
		const rows = editor.render(40).map(r => Bun.stripANSI(r));
		expect(rows[0]).toStartWith("  > first line");
		expect(rows[1]).toStartWith("  ┆ second line");
		expect(rows[2]).toStartWith("  ┆ third line");
	});

	it("keeps continuation rows in column with the prompt row", () => {
		const editor = makeEditor("first\nsecond");
		editor.setPromptGutterContinuation(WHISPER);
		const rows = editor.render(40);
		const gutterWidth = visibleWidth(GUTTER);
		const contentCol = (row: string) => Bun.stripANSI(row).slice(gutterWidth);
		expect(contentCol(rows[0]!).trimEnd().length).toBeGreaterThan(0);
		expect(Bun.stripANSI(rows[1]!).indexOf("second")).toBe(gutterWidth);
	});

	it("restores blank alignment padding byte-identically when cleared", () => {
		const plain = makeEditor("first\nsecond").render(40);
		const cleared = makeEditor("first\nsecond");
		cleared.setPromptGutterContinuation(WHISPER);
		cleared.setPromptGutterContinuation(undefined);
		expect(cleared.render(40)).toEqual(plain);
		expect(Bun.stripANSI(plain[1]!)).toStartWith("    second");
	});

	it("never shows the whisper on a single-row input", () => {
		const editor = makeEditor("just one line");
		editor.setPromptGutterContinuation(WHISPER);
		const rendered = editor
			.render(40)
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(rendered).not.toContain("┆");
	});
});
