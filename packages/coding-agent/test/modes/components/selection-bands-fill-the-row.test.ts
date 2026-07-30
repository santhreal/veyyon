/**
 * Every selection band in the app fills its row, at the byte level.
 *
 * WHY THIS SUITE EXISTS. `theme.bg("selectedBg", line)` wrapped around a row's
 * TEXT tints only as far as that row happens to reach, so the band stops
 * mid-row and changes shape as the cursor moves; the eye reads a ragged right
 * edge as a rendering fault rather than as "you are here". The Agent Control
 * Center shipped that version and it was caught by LOOKING at a render proof,
 * not by a test, because with colour off the fill is not there either way. Ten
 * other selectors had the same call shape, and two of them, the session tree and
 * the extension list, did not pad at all.
 *
 * `agent-dashboard-selection-fill.test.ts` pins the roster. This suite pins the
 * shared helper every other surface now goes through, plus the two selectors
 * whose rows are built by a callback the view hands its own width to. Colour is
 * forced ON: the defect is invisible without it, since `theme.bg` returns its
 * argument unchanged when colour is off.
 *
 * The width rule is the other half and it is the more dangerous one. A caller
 * that computes the scrollbar reserve itself gets it wrong by one column,
 * `ScrollView` truncates the overlong row on the way out, and a cut inside a
 * fill drops the escape that CLOSES it, so the bar and every cell after it come
 * out painted in the selection colour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectionBand } from "@veyyon/coding-agent/modes/components/selector-helpers";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, ScrollView, setAnsiPolicy, visibleWidth } from "@veyyon/tui";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BG_OPEN = /\x1b\[(?:4[0-7]|10[0-7]|48;(?:2;\d+;\d+;\d+|5;\d+))m/;
const BG_CLOSE = "\x1b[49m";

let policy: AnsiPolicy;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterEach(() => {
	setAnsiPolicy(policy);
});

/** The row with every escape removed, which is what the eye sees as cells. */
function cells(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

describe("selectionBand", () => {
	/**
	 * The whole rule in one assertion. A row a third the width of the pane is
	 * still a band the full width of the pane.
	 */
	test("pads a short row out to the full width before tinting", () => {
		const band = selectionBand("  short", 40);

		expect(cells(band)).toBe(`  short${" ".repeat(33)}`);
		expect(visibleWidth(band)).toBe(40);
	});

	/** The tint opens before the first cell and closes after the last one. */
	test("opens the background before the text and closes it after the padding", () => {
		const band = selectionBand("  short", 40);

		expect(band).toMatch(BG_OPEN);
		expect(band.endsWith(BG_CLOSE)).toBeTrue();
		// Nothing may follow the close: a cell painted after it is a cell the
		// terminal draws in the selection colour outside the band.
		expect(band.indexOf(BG_CLOSE)).toBe(band.length - BG_CLOSE.length);
	});

	/**
	 * An overlong row is cut to the width rather than allowed to overrun it. An
	 * overrun is what puts the closing escape past the truncation point, and the
	 * fill then runs on through the gutter and the scrollbar.
	 */
	test("truncates a row that is longer than the width", () => {
		const long = `  ${"x".repeat(80)}`;
		const band = selectionBand(long, 30);

		expect(visibleWidth(band)).toBe(30);
		expect(band.endsWith(BG_CLOSE)).toBeTrue();
	});

	/** No ellipsis is added: a band is a highlight, not a truncation notice. */
	test("cuts without an ellipsis, since the row already shows it truncated", () => {
		const band = selectionBand(`  ${"x".repeat(80)}`, 30);

		expect(cells(band)).toBe(`  ${"x".repeat(28)}`);
	});

	/** A row already exactly the width is neither padded nor cut. */
	test("leaves a row that is exactly the width alone", () => {
		const exact = "x".repeat(20);
		const band = selectionBand(exact, 20);

		expect(cells(band)).toBe(exact);
	});

	/** Inner styling survives: the band is a background, not a repaint. */
	test("keeps the row's own foreground styling inside the band", () => {
		const styled = `\x1b[38;2;1;2;3mcoloured\x1b[39m`;
		const band = selectionBand(styled, 20);

		expect(band).toContain("\x1b[38;2;1;2;3m");
		expect(cells(band)).toBe(`coloured${" ".repeat(12)}`);
	});

	/** A zero width cannot produce a band with cells in it. */
	test("produces no cells at a width of zero", () => {
		expect(cells(selectionBand("  anything", 0))).toBe("");
	});
});

describe("A band inside a ScrollView", () => {
	/**
	 * The gutter rule, end to end. A band built at the view's content width and
	 * rendered through that view keeps its closing escape, and the scrollbar is
	 * drawn OUTSIDE the tinted span.
	 *
	 * The old helper reserved one column where the view reserves two, so the band
	 * was a column too wide, the view cut it, and the cut landed after the last
	 * cell but before the escape that closes the fill.
	 */
	test("closes the fill before the scrollbar when the list overflows", () => {
		const width = 60;
		const view = new ScrollView([], { height: 4, scrollbar: "auto", totalRows: 40 });
		const rowWidth = view.contentWidth(width);
		expect(rowWidth).toBe(width - 2);

		view.setLines([selectionBand("  selected", rowWidth), "  plain", "  plain", "  plain"]);
		const rendered = view.render(width);
		const banded = rendered[0] as string;

		// The bar is the last cell of the row and the fill has already closed.
		const closeAt = banded.indexOf(BG_CLOSE);
		expect(closeAt).toBeGreaterThan(-1);
		expect(cells(banded.slice(closeAt))).not.toContain("selected");
		expect(visibleWidth(cells(banded.slice(closeAt)))).toBe(2);
		expect(visibleWidth(banded)).toBe(width);
	});

	/**
	 * The adversarial twin: a band built at the FULL width, which is what a
	 * caller that guessed the reserve produces. The view truncates it and the
	 * closing escape is lost, so the row ends still painted. This asserts the
	 * failure mode explicitly so the reason `contentWidth` exists cannot be
	 * optimised away by someone who reads the call as redundant.
	 */
	test("loses the closing escape when the band is built at the full width", () => {
		const width = 60;
		const view = new ScrollView([], { height: 4, scrollbar: "auto", totalRows: 40 });

		view.setLines([selectionBand("  selected", width), "  plain", "  plain", "  plain"]);
		const banded = view.render(width)[0] as string;

		expect(banded).toMatch(BG_OPEN);
		expect(banded).not.toContain(BG_CLOSE);
	});

	/** With no overflow there is no bar, and the band may use every column. */
	test("uses the whole width when the list does not overflow", () => {
		const width = 60;
		const view = new ScrollView([], { height: 4, scrollbar: "auto", totalRows: 4 });

		expect(view.contentWidth(width)).toBe(width);
	});
});
