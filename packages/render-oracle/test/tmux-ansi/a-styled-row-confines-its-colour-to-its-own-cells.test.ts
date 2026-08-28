/**
 * A styled row colours its own cells and nothing else.
 *
 * WHY THIS SUITE EXISTS:
 * Every row the renderer emits ends with an SGR reset, written in one place — `#terminalLine`.
 * Drop it and nothing looks wrong in the frame text, because the characters are identical: what
 * changes is the cell attributes. The colour survives the newline into the next row, and erase
 * sequences then fill the cells they clear with the *current* background (back-colour-erase), so
 * one unreset row repaints whole phantom-coloured bands. Inside a multiplexer the same leak
 * reaches the pane border and the status line, which the application never drew at all.
 *
 * WHAT THIS SUITE PROVES:
 * 1. A background-coloured row leaves every other row of the frame at the default background,
 *    with the styled row identified by its own content rather than by a row index.
 * 2. The cells past the end of a styled row's text stay default, so the erase that clears the
 *    rest of the line does not inherit the colour.
 * 3. Foreground and underline are confined the same way, so the guarantee is about attribute
 *    state and not about one attribute someone remembered.
 * 4. Repainting a single row of a styled frame leaves its neighbours' attributes untouched.
 * 5. All of it holds identically with `TMUX` set, which is where the leak also corrupts chrome
 *    the application does not own.
 *
 * Each check is a differential against the same frame rendered unstyled, so nothing here depends
 * on a colour index, a column count or a row number written into the test.
 *
 * WHAT IT DOES NOT CATCH:
 * Attributes inside a row: a run that turns colour on and never off before the row's own end
 * still ends at the row terminator, and reading the cells cannot say which of the two spellings
 * the component intended. Nor does it cover an image row, which is emitted verbatim.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { CSI } from "@veyyon/tui/ansi";
import { type Component, TUI } from "@veyyon/tui/tui";

/** Rows a test paints, mutable so a repaint can change one of them. */
class MutableRowsComponent implements Component {
	constructor(public rows: readonly string[]) {}

	render(_width: number): readonly string[] {
		return this.rows;
	}
}

const RED_BG = `${CSI}41m`;
const GREEN_FG = `${CSI}32m`;
const UNDERLINE = `${CSI}4m`;

const PLAIN_ABOVE = "row above the styled one";
const STYLED_TEXT = "the styled row";
const PLAIN_BELOW = "row below the styled one";

/** Which attribute a case turns on, and how the painted cells are read back. */
interface AttributeCase {
	name: string;
	open: string;
	columnsOf: (term: VirtualTerminal, row: number) => number[];
}

const ATTRIBUTES: readonly AttributeCase[] = [
	{ name: "background", open: RED_BG, columnsOf: (t, r) => t.getViewportRowBackgroundColumns(r) },
	{ name: "foreground", open: GREEN_FG, columnsOf: (t, r) => t.getViewportRowForegroundColumns(r) },
	{ name: "underline", open: UNDERLINE, columnsOf: (t, r) => t.getViewportRowUnderlineColumns(r) },
];

const originalTmux = process.env.TMUX;

afterEach(() => {
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
});

/** A settled frame of three rows, the middle one styled or plain according to `open`. */
async function paintThreeRows(open: string): Promise<{ term: VirtualTerminal; tui: TUI; body: MutableRowsComponent }> {
	const term = new VirtualTerminal(80, 24);
	const tui = new TUI(term);
	// Deliberately left open. A component that closes its own attribute proves nothing about the
	// renderer: the row terminator is what has to end it, and this is the row that needs it.
	const styled = `${open}${STYLED_TEXT}`;
	const body = new MutableRowsComponent([PLAIN_ABOVE, styled, PLAIN_BELOW]);
	tui.addChild(body);
	tui.start();
	await settleFrames(term, tui);
	return { term, tui, body };
}

/** Row index of the frame row whose text carries `marker`. */
function rowOf(term: VirtualTerminal, marker: string): number {
	const index = term.getViewport().findIndex(row => row.includes(marker));
	if (index === -1) throw new Error(`no row of the frame carries ${JSON.stringify(marker)}`);
	return index;
}

/** Every viewport row that carries the attribute, and the columns it carries it on. */
function attributedRows(term: VirtualTerminal, attribute: AttributeCase): Map<number, number[]> {
	const found = new Map<number, number[]>();
	for (let row = 0; row < term.getViewport().length; row++) {
		const columns = attribute.columnsOf(term, row);
		if (columns.length > 0) found.set(row, columns);
	}
	return found;
}

describe("a styled row confines its colour to its own cells", () => {
	for (const attribute of ATTRIBUTES) {
		it(`paints ${attribute.name} on the styled row and on no other row`, async () => {
			const { term } = await paintThreeRows(attribute.open);

			const styledRow = rowOf(term, STYLED_TEXT);
			expect([...attributedRows(term, attribute).keys()]).toEqual([styledRow]);
		});

		it(`leaves the cells past the styled text free of ${attribute.name}`, async () => {
			const { term } = await paintThreeRows(attribute.open);

			const styledRow = rowOf(term, STYLED_TEXT);
			const columns = attribute.columnsOf(term, styledRow);
			// The text starts at the first column of the row it owns, so the attributed columns are
			// exactly its characters; anything beyond is the erased tail inheriting the attribute.
			expect(columns).toEqual([...STYLED_TEXT].map((_, index) => index));
		});

		it(`carries no ${attribute.name} anywhere when the same frame is painted unstyled`, async () => {
			const { term } = await paintThreeRows("");

			expect([...attributedRows(term, attribute).keys()]).toEqual([]);
		});

		it(`keeps ${attribute.name} off its neighbours when one row of the frame is repainted`, async () => {
			const { term, tui, body } = await paintThreeRows(attribute.open);
			const before = attributedRows(term, attribute);

			body.rows = [`${PLAIN_ABOVE} (edited)`, body.rows[1] ?? "", PLAIN_BELOW];
			tui.requestRender();
			await settleFrames(term, tui);

			const styledRow = rowOf(term, STYLED_TEXT);
			const after = attributedRows(term, attribute);
			expect([...after.keys()]).toEqual([styledRow]);
			expect(after.get(styledRow)).toEqual(before.get(rowOf(term, STYLED_TEXT)));
		});

		it(`confines ${attribute.name} to the styled row inside a multiplexer pane`, async () => {
			process.env.TMUX = "/run/tmux/default,4242,0";
			const { term } = await paintThreeRows(attribute.open);

			const styledRow = rowOf(term, STYLED_TEXT);
			expect([...attributedRows(term, attribute).keys()]).toEqual([styledRow]);
		});
	}

	it("gives a styled frame and an unstyled one the same text, so only attributes differ", async () => {
		const styled = await paintThreeRows(RED_BG);
		const plain = await paintThreeRows("");

		expect(styled.term.getViewport()).toEqual(plain.term.getViewport());
	});

	it("confines colour on a row of wide characters, which takes the erase-first rewrite path", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const wide = "スタイル付きの行";
		const body = new MutableRowsComponent([PLAIN_ABOVE, `${RED_BG}${wide}`, PLAIN_BELOW]);
		tui.addChild(body);
		tui.start();
		await settleFrames(term, tui);
		const styledRow = rowOf(term, wide);
		const before = term.getViewportRowBackgroundColumns(styledRow);
		expect(before.length).toBeGreaterThan(0);

		// A neighbour changing forces the row to be rewritten in place. The native width measure
		// declines to size this row, so it is erased before it is redrawn — the one path where the
		// erase runs before the row's own bytes rather than after them.
		body.rows = [`${PLAIN_ABOVE} (edited)`, body.rows[1] ?? "", PLAIN_BELOW];
		tui.requestRender();
		await settleFrames(term, tui);

		const attributed = new Map<number, number[]>();
		for (let row = 0; row < term.getViewport().length; row++) {
			const columns = term.getViewportRowBackgroundColumns(row);
			if (columns.length > 0) attributed.set(row, columns);
		}
		expect([...attributed.keys()]).toEqual([rowOf(term, wide)]);
		expect(attributed.get(rowOf(term, wide))).toEqual(before);
	});
});
