/**
 * `/history`'s selected result is banded across the whole row, gutter excluded.
 *
 * WHY THIS SUITE EXISTS. History search already padded its rows before tinting,
 * so the band looked right. It was sized wrong: the row width came from a helper
 * that reserved ONE column for the scrollbar while `ScrollView` reserves TWO, a
 * breathing gap plus the glyph. Every row was therefore built a column too wide
 * and cut on the way out, and a cut that lands inside a fill drops the escape
 * that CLOSES it, so the bar and every cell after it come out painted in the
 * selection colour. A hundred prompts is the ordinary case here, so the bar is
 * almost always drawn.
 *
 * The rows are now built by a callback the view hands its own content width to,
 * which is why the reserve cannot be restated. These tests pin the result at the
 * byte level, with colour forced ON: `theme.bg` returns its argument unchanged
 * when colour is off, so the default policy asserts against a row where the band
 * never existed either way.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HistorySearchComponent } from "@veyyon/coding-agent/modes/components/history-search";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { HistoryEntry, HistoryStorage } from "@veyyon/coding-agent/session/history-storage";
import { getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";
import { stubStdoutGeometry, type StubbedStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BG_OPEN = /\x1b\[48;2;\d+;\d+;\d+m/;
const BG_CLOSE = "\x1b[49m";
const WIDTH = 110;
const DOWN = "\x1b[B";

/** The scrollbar track and thumb glyphs `renderScrollableList` draws. */
const BAR_GLYPHS = /[│█]/;

let policy: ReturnType<typeof getAnsiPolicy>;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
});

const NOW = Math.floor(Date.parse("2026-07-27T12:00:00.000Z") / 1000);

/**
 * Prompts of very uneven length, which is what makes a mis-sized band visible.
 *
 * `count` above the ten visible rows is what puts the scrollbar on screen, and
 * the scrollbar is the whole reason the width has to come from the view.
 */
function storageWith(count: number): HistoryStorage {
	const prompts = ["x", "fix it", "why is the modal shorter", `${"a long prompt ".repeat(6)}end`];
	const entries: HistoryEntry[] = Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		prompt: prompts[index % prompts.length] as string,
		cwd: "/repo",
		sessionId: "s-1",
		created_at: NOW - index * 900,
	}));
	return { getRecent: () => entries, search: () => entries } as unknown as HistoryStorage;
}

function card(count: number, steps: number): string[] {
	const component = new HistorySearchComponent(
		storageWith(count),
		() => {},
		() => {},
	);
	for (let step = 0; step < steps; step++) component.handleInput(DOWN);
	return [...component.render(WIDTH)];
}

/** The one row carrying a background, or a failure saying how many did. */
function bandedRow(lines: readonly string[]): string {
	const banded = lines.filter(line => BG_OPEN.test(line));
	if (banded.length !== 1) throw new Error(`expected exactly one banded row, found ${banded.length}`);
	return banded[0] as string;
}

/** The row with every escape removed, which is what the eye sees as cells. */
function cells(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

/** The cells covered by the band. */
function bandCells(line: string): string {
	const open = line.search(BG_OPEN);
	const close = line.indexOf(BG_CLOSE);
	return cells(line.slice(open, close));
}

describe("A result list short enough to need no scrollbar", () => {
	/**
	 * The band runs the whole pane even when the prompt is one character. The
	 * exact width belongs to the card's sizing and is allowed to change; what
	 * may not come back is a band the width of the text, which for `x` was three
	 * cells including the cursor.
	 */
	test("fills the pane on the shortest prompt", () => {
		const banded = bandedRow(card(6, 0));

		expect(bandCells(banded)).toContain("x");
		expect(visibleWidth(bandCells(banded))).toBeGreaterThan(40);
	});

	/** And is the same width on the longest, which is the property the eye reads. */
	test("is the same width whichever result is selected", () => {
		const first = visibleWidth(bandCells(bandedRow(card(6, 0))));
		const fourth = visibleWidth(bandCells(bandedRow(card(6, 3))));

		expect(first).toBe(fourth);
	});
});

describe("A result list long enough to draw a scrollbar", () => {
	/**
	 * The exact regression. The bar is drawn, and the fill has already closed
	 * before it: an unclosed fill paints the bar and everything after it.
	 */
	test("closes the fill before the scrollbar", () => {
		const banded = bandedRow(card(100, 0));
		const close = banded.indexOf(BG_CLOSE);

		expect(close).toBeGreaterThan(-1);
		expect(banded.slice(close)).toMatch(BAR_GLYPHS);
	});

	/**
	 * The gutter is exactly what follows the band: one breathing column, then
	 * the bar. Card padding and the border come after those and belong to the
	 * shell, not to the list.
	 */
	test("leaves the gap and the bar outside the band", () => {
		const banded = bandedRow(card(100, 0));
		const after = cells(banded.slice(banded.indexOf(BG_CLOSE)));

		expect(after.slice(0, 1)).toBe(" ");
		expect(after.slice(1, 2)).toMatch(BAR_GLYPHS);
	});

	/**
	 * And the band gives up exactly those two columns, no more and no fewer. One
	 * column is the reserve the deleted helper used and is the bug; three would
	 * mean the rows are being cut somewhere else as well.
	 */
	test("is exactly two columns narrower than when no bar is drawn", () => {
		const withBar = visibleWidth(bandCells(bandedRow(card(100, 0))));
		const withoutBar = visibleWidth(bandCells(bandedRow(card(6, 0))));

		expect(withoutBar - withBar).toBe(2);
	});

	/** Scrolling does not change any of it: every selected row bands the same. */
	test("bands the same width after paging down through the list", () => {
		const widths = [0, 5, 12, 30].map(steps => visibleWidth(bandCells(bandedRow(card(100, steps)))));

		expect(new Set(widths).size).toBe(1);
	});
});
