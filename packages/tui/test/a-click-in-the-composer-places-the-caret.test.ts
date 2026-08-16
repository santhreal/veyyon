/**
 * A click in the composer text places the caret there.
 *
 * WHY: the editor answered exactly one pointer gesture — a click on a
 * suggestion row — and ignored a click on its own text, so the caret could only
 * be moved with arrow keys and word jumps. Clicking into a draft is what a click
 * in a text field means everywhere else, and a composer that paints a caret and
 * cannot be pointed at is the same class of defect as a row you can see and
 * cannot click.
 *
 * The class this closes: a rendered column that maps to no caret position. The
 * mapping is taken from the LAST paint (row start, row count, the column text
 * begins at, the scroll offset in force) rather than recomputed, so a prompt
 * gutter, a wrapped line, a framed variant, and a scrolled input all resolve
 * through one path; each of those geometries is a case below, because each is a
 * different offset that a single-geometry fix would leave broken.
 *
 * Not caught: which visual row a wrap boundary falls on belongs to the wrap
 * layout and is proven where that lives; these cases read the painted rows and
 * follow it. Drag-selection is out of scope — the composer sits in the pinned
 * footer, which reports presses and releases and no motion at all, so there is
 * no gesture to build a selection from. Nor is the `return` after a suggestion
 * is accepted: deleting it lets the accept path fall through into the caret
 * move, and every case here still passes, because a popup row is painted below
 * the text rows and the fall-through lands on a row the bounds check rejects.
 * That `return` is structural, not load-bearing, and pinning it would mean
 * asserting a geometry (popup above the input) that the layout does not have.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@veyyon/tui/autocomplete";
import { Editor } from "@veyyon/tui/components/editor";
import { type Component, Container, TUI } from "@veyyon/tui/tui";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const COLS = 60;
const ROWS = 24;
const GUTTER = "  > ";

/** SGR left-button press at 0-based (row, col). */
function clickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** Transcript filler: taller than the screen, which is what arms wheel tracking. */
class Filler implements Component {
	constructor(private readonly rows: number) {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `filler-${i}`);
	}
}

/** The composer as production mounts it: gutter mode, no box, inside a Container. */
function makeComposer(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setPromptGutter(GUTTER);
	editor.setText(text);
	return editor;
}

/** Route a press straight at the editor, exactly as the Container does. */
function pressAt(editor: Editor, line: number, col: number): void {
	const event = { button: 0, col, row: line, release: false, wheel: null, motion: false, leftClick: true };
	editor.routeMouse(event, line, col);
}

describe("a click on the composer text", () => {
	it("puts the caret on the character under the pointer", () => {
		const editor = makeComposer("hello world");
		editor.render(COLS);

		// Column 4 of the gutter row is `o` in `hello`: gutter is 4 cells wide.
		pressAt(editor, 0, GUTTER.length + 4);

		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
		editor.handleInput("X");
		expect(editor.getText()).toBe("hellXo world");
	});

	it("lands at the end of the row when the click is past the last character", () => {
		const editor = makeComposer("hi");
		editor.render(COLS);

		pressAt(editor, 0, GUTTER.length + 40);

		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("subtracts the prompt gutter, so the same column means a different character without one", () => {
		const withGutter = makeComposer("abcdef");
		withGutter.render(COLS);
		const bare = new Editor(defaultEditorTheme);
		bare.setBorderVisible(false);
		bare.setText("abcdef");
		bare.render(COLS);

		pressAt(withGutter, 0, GUTTER.length + 2);
		pressAt(bare, 0, 2);

		expect(withGutter.getCursor()).toEqual({ line: 0, col: 2 });
		expect(bare.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("resolves the second logical line of a multiline draft", () => {
		const editor = makeComposer("first\nsecond\nthird");
		editor.render(COLS);

		pressAt(editor, 1, GUTTER.length + 3);

		expect(editor.getCursor()).toEqual({ line: 1, col: 3 });
		editor.handleInput("-");
		expect(editor.getText()).toBe("first\nsec-ond\nthird");
	});

	it("maps a click on the continuation row of a wrapped line back into that line", () => {
		// One logical line, wider than the content area, so it paints as two rows.
		const first = "aaaa bbbb cccc dddd eeee";
		const second = "ffff gggg";
		const editor = makeComposer(`${first} ${second}`);
		editor.setPromptGutterContinuation(GUTTER);
		const rows = editor.render(30).map(row => Bun.stripANSI(row));
		expect(rows.length).toBeGreaterThan(1);
		expect(rows[1]).toContain("ffff");

		// Column of `gggg` on the continuation row, read from the paint itself.
		const col = Bun.stripANSI(rows[1] ?? "").indexOf("gggg");
		pressAt(editor, 1, col);

		expect(editor.getCursor()).toEqual({ line: 0, col: `${first} `.length + "ffff ".length });
	});

	it("counts through the scroll offset when the draft is taller than the box", () => {
		const editor = makeComposer("one\ntwo\nthree\nfour\nfive");
		editor.setMaxHeight(2);
		// The caret is on the last line, so the paint is scrolled to the tail.
		const rows = editor.render(COLS).map(row => Bun.stripANSI(row));
		expect(rows.some(row => row.includes("one"))).toBe(false);
		const fourRow = rows.findIndex(row => row.includes("four"));
		expect(fourRow).toBeGreaterThanOrEqual(0);

		pressAt(editor, fourRow, GUTTER.length + 1);

		expect(editor.getCursor()).toEqual({ line: 3, col: 1 });
	});

	it("skips the top rule and the left border in the framed variant", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("framed text");
		const rows = editor.render(COLS).map(row => Bun.stripANSI(row));
		const textRow = rows.findIndex(row => row.includes("framed"));
		expect(textRow).toBe(1);

		// Border cell plus the theme's two padding cells, then two characters in.
		pressAt(editor, textRow, 3 + 2);

		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("ignores a press on a row the text does not occupy", () => {
		const editor = makeComposer("only line");
		editor.render(COLS);
		editor.handleInput("\x01"); // ctrl+a → start of line
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

		pressAt(editor, 4, GUTTER.length + 3);

		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("ignores a press on a line that exists but this paint did not show", () => {
		// The dangerous half of the row bound: with the draft scrolled to the top,
		// row 3 of the FRAME is not painted, but visual line 3 is a real line, so a
		// route that only checked "is there a line here" would put the caret on a
		// line the pointer never touched.
		const editor = makeComposer("one\ntwo\nthree\nfour\nfive");
		editor.setMaxHeight(2);
		editor.moveToMessageStart();
		const rows = editor.render(COLS).map(row => Bun.stripANSI(row));
		expect(rows.length).toBe(2);
		expect(rows.some(row => row.includes("four"))).toBe(false);

		pressAt(editor, 3, GUTTER.length + 1);

		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("ignores motion, release, and wheel reports", () => {
		const editor = makeComposer("hello world");
		editor.render(COLS);
		const col = GUTTER.length + 4;

		for (const event of [
			{ button: 35, col, row: 0, release: false, wheel: null, motion: true, leftClick: false },
			{ button: 0, col, row: 0, release: true, wheel: null, motion: false, leftClick: false },
			{ button: 65, col, row: 0, release: false, wheel: 1 as const, motion: false, leftClick: false },
		]) {
			editor.routeMouse(event, 0, col);
			expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
		}
	});

	it("dismisses an open suggestion popup when the click lands on the text instead", async () => {
		const editor = makeComposer("");
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch model" }], "/tmp"),
		);
		editor.handleInput("/m");
		await Bun.sleep(120);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.render(COLS);

		// Row 0 is the input row; the popup owns the rows below it.
		pressAt(editor, 0, GUTTER.length + 1);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	});

	describe("through the production route", () => {
		let stop: (() => void) | undefined;
		afterEach(() => {
			stop?.();
			stop = undefined;
		});

		it("moves the caret from a terminal byte, through the engine and the container", async () => {
			const term = new VirtualTerminal(COLS, ROWS, 1000);
			const tui = new TUI(term, true);
			const editor = makeComposer("point at me");
			const container = new Container();
			container.addChild(editor);
			tui.addChild(new Filler(ROWS + 5));
			tui.addChild(container);
			tui.setPinnedFooterChildCount(1);
			tui.setScrollIsolation(true);
			tui.setFocus(editor);
			tui.start();
			stop = () => tui.stop();
			await term.waitForRender();

			const viewport = term.getViewport();
			const row = viewport.findIndex(line => line.includes("point at me"));
			expect(row).toBeGreaterThanOrEqual(0);
			const col = (viewport[row] ?? "").indexOf("at");

			term.sendInput(clickAt(row, col));
			await term.waitForRender();

			expect(editor.getCursor()).toEqual({ line: 0, col: "point ".length });
		});
	});
});
