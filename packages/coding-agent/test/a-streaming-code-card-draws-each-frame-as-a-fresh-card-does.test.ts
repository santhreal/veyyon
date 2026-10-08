/**
 * WHY: a card that streams a code section reuses what it drew for the frame before. The highlighter
 * continues from the lines it settled, the code section keeps the row of every line whose highlighted
 * text and gutter cell are unchanged, and each tail window keeps the rows of every line it wrapped
 * last at the same width, wherever the line moved to. The defect class is a reused row that differs
 * from a fresh draw: a gutter that widened at line 1000, a line numbered per row whose number moved,
 * a lead on the first row, a line that wraps at the new width, a theme switch, a card drawn without a
 * window, a headed block whose output streams under a window of its own, and a shell card whose
 * output arrives through a tail buffer that cuts its front, under a second window holding the
 * command. Every frame is compared with the same view drawn after an unrelated card replaced each of
 * those memos, which draws it with nothing reused.
 *
 * The tail window's cost is asserted too: no line the window drew in the frame before is wrapped
 * again, which fails when a sibling window replaces the memo the output window reads, when lines
 * moved up by a cut front are not found, and when a search aligns the window on another copy of a
 * repeated line. Not caught: the code section's cost. A code memo that is never hit draws the same
 * bytes and passes here; that bound is measured by the streaming-card bench.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { CachedOutputBlock, type OutputBlockOptions } from "@veyyon/coding-agent/modes/terminal/draw/output-block";
import { getThemeByName, type Theme } from "@veyyon/coding-agent/theme/theme";
import * as wrapModule from "@veyyon/utils/wrap";
import type { ToolView, ViewCodeLines, ViewLine, ViewTailWindow } from "@veyyon/view";

/** A source long enough to cross the gutter's widening at line 1000, with lines that wrap at 40 columns. */
const SOURCE = Array.from({ length: 1012 }, (_, index) =>
	index % 9 === 4
		? `\t// a comment long enough to wrap in a narrow card, line ${index} of the file`
		: `const value${index} = compute(${index}, "item ${index}");`,
).join("\n");

/** The frames a stream delivers: uneven chunks, so a frame ends mid-line as often as at a line end. */
function frames(source: string): string[] {
	const out: string[] = [];
	for (let end = 1, step = 1; end < source.length; end += step, step = 1 + ((step * 7 + 3) % 700)) {
		out.push(source.slice(0, end));
	}
	out.push(source);
	return out;
}

/** The lines a test runner prints around each result, the same around every one. */
const STATUS = ["ok", "running", "", "ok", "FAILED", ""];

/**
 * Shell output where six of every seven lines repeat, with lines that wrap at 40 columns: a blank, an
 * "ok" and a blank followed by "ok" occur at many offsets, which is what a moved window is found by.
 */
const LOG = Array.from({ length: 600 }, (_, index) =>
	index % 7 < STATUS.length
		? STATUS[index % 7]!
		: index % 13 === 8
			? `warning: a diagnostic long enough to wrap in a narrow card, number ${index}`
			: `test ${index} passed in ${index % 17}ms`,
).join("\n");

/** The characters of output a streamed shell card keeps, as its tail buffer keeps its last bytes. */
const TAIL_CHARS = 2000;

/** Where each frame a tail buffer delivers starts and ends: the last `TAIL_CHARS` of uneven growth, cut mid-line at both ends. */
function tailRanges(length: number): Array<readonly [start: number, end: number]> {
	const out: Array<readonly [number, number]> = [];
	for (let end = 1, step = 1; end < length; end += step, step = 1 + ((step * 7 + 3) % 300)) {
		out.push([Math.max(0, end - TAIL_CHARS), end]);
	}
	out.push([length - TAIL_CHARS, length]);
	return out;
}

const toLines = (source: string): ViewLine[] => source.split("\n").map(text => [{ text }]);

/** Every way a code section states its gutter, which is what decides whether a row can be reused. */
const GUTTERS: ReadonlyArray<{ name: string; code: (lineCount: number) => ViewCodeLines }> = [
	{ name: "numbered from its first line", code: count => ({ language: "ts", firstLineNumber: 1, totalLines: count }) },
	{
		name: "numbered per line",
		code: count => ({
			language: "ts",
			lineNumbers: Array.from({ length: count }, (_, index) => (index % 11 === 5 ? null : index + 7)),
		}),
	},
	{ name: "under a lead", code: () => ({ language: "bash", lead: "$ cd /repo && " }) },
];

const WINDOWS: ReadonlyArray<{ name: string; tail: ViewTailWindow | undefined }> = [
	{ name: "in a window", tail: { max: 12 } },
	{ name: "without a window", tail: undefined },
];

function codeCard(
	source: string,
	code: (lineCount: number) => ViewCodeLines,
	tail: ViewTailWindow | undefined,
): ToolView {
	const lines = toLines(source);
	return {
		kind: "framedBlock",
		state: "running",
		sections: [{ lines, code: code(lines.length), ...(tail === undefined ? {} : { tail }) }],
	};
}

function outputCard(source: string): ToolView {
	return { kind: "headedBlock", lines: toLines(source), tail: { max: 12 } };
}

const COMMAND = "$ make test";

/** A shell card: its command and its output each in a window, the way the bash view states them. */
function shellCard(output: string): ToolView {
	return {
		kind: "framedBlock",
		state: "running",
		sections: [
			{ lines: toLines(COMMAND), tail: { max: 3 } },
			{ lines: toLines(output), tail: { max: 12 } },
		],
	};
}

async function loadTheme(name: string): Promise<Theme> {
	const theme = await getThemeByName(name);
	if (theme === undefined) throw new Error(`theme ${name} is not bundled`);
	return theme;
}

/**
 * Stream `cardAt` frame by frame, switching width a third of the way in and theme two thirds of the
 * way in, and require each frame to draw as a card drawn with nothing to reuse draws it.
 */
async function assertStreamsLikeFreshDraws(
	label: string,
	cardAt: (source: string) => ToolView,
	all: readonly string[] = frames(SOURCE),
): Promise<void> {
	const dark = await loadTheme("dark");
	const light = await loadTheme("light");
	for (const [index, frame] of all.entries()) {
		const width = index < all.length / 3 ? 100 : 40;
		const theme = index < (2 * all.length) / 3 ? dark : light;
		const streamed = drawToolView(cardAt(frame), theme, 0).render(width);
		// An unrelated card of the same kind at the same width replaces every memo the stream left.
		drawToolView(cardAt("let unrelated = true;\nlet other = false;"), theme, 0).render(width);
		const fresh = drawToolView(cardAt(frame), theme, 0).render(width);
		expect({ label, index, width, rows: streamed }).toEqual({ label, index, width, rows: fresh });
	}
}

describe("a streaming code card", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const gutter of GUTTERS) {
		for (const window of WINDOWS) {
			it(`draws each frame as a fresh card does, ${gutter.name}, ${window.name}`, async () => {
				await assertStreamsLikeFreshDraws(`${gutter.name}, ${window.name}`, source =>
					codeCard(source, gutter.code, window.tail),
				);
			});
		}
	}

	it("draws each frame of streamed output under a window as a fresh block does", async () => {
		await assertStreamsLikeFreshDraws("headed block", outputCard);
	});

	it("draws each frame of a shell card's tail-cut output as a fresh card does", async () => {
		await assertStreamsLikeFreshDraws(
			"shell card",
			shellCard,
			tailRanges(LOG.length).map(([start, end]) => LOG.slice(start, end)),
		);
	});

	it("wraps no line of a streamed shell card that the frame before drew", async () => {
		const theme = await loadTheme("dark");
		const wrapped: string[] = [];
		// The block breaks each row it is handed once more, and those rows are the window's own output,
		// so a wrap made while the block draws is the block's and only the window's wraps are counted.
		let framing = false;
		const frame = CachedOutputBlock.prototype.render;
		spyOn(CachedOutputBlock.prototype, "render").mockImplementation(function (
			this: CachedOutputBlock,
			options: OutputBlockOptions,
			blockTheme: Theme,
		) {
			framing = true;
			try {
				return frame.call(this, options, blockTheme);
			} finally {
				framing = false;
			}
		});
		const wrap = wrapModule.wrapTextWithAnsi;
		spyOn(wrapModule, "wrapTextWithAnsi").mockImplementation((text, width) => {
			if (!framing) wrapped.push(text);
			return wrap(text, width);
		});
		// A width no other case draws at, so the first frame finds nothing to reuse.
		const width = 73;
		// Each line of a frame by the offset it starts at in the log, so a later line with the same text, a
		// blank or a repeated "ok", is a line the frame before did not hold. A line is kept by its bytes: one
		// that grew by a space is a new line, though it wraps to the same rows.
		const linesAt = ([start, end]: readonly [number, number]): Map<number, string> => {
			const lines = new Map<number, string>();
			let at = start;
			for (const line of LOG.slice(start, end).split("\n")) {
				lines.set(at, line);
				at += line.length + 1;
			}
			return lines;
		};
		let before = new Map<number, string>();
		for (const [index, range] of tailRanges(LOG.length).entries()) {
			const now = linesAt(range);
			wrapped.length = 0;
			drawToolView(shellCard(LOG.slice(...range)), theme, 0).render(width);
			const fresh = [...now].filter(([at, line]) => before.get(at) !== line).map(([, line]) => line.trimEnd());
			if (index === 0) {
				expect(wrapped).toEqual([COMMAND, ...fresh]);
			} else {
				// The wraps are fresh lines in the order they stand. A fresh line equal to one the window
				// already holds may take that line's rows, so the wraps are a subsequence of the fresh lines.
				let next = 0;
				const rewrapped = wrapped.filter(line => {
					const found = fresh.indexOf(line, next);
					if (found < 0) return true;
					next = found + 1;
					return false;
				});
				expect({ index, rewrapped }).toEqual({ index, rewrapped: [] });
			}
			before = now;
		}
	});

	it("draws its own line numbers after a card with the same text numbered elsewhere", async () => {
		// Two windows onto repeated text, such as the same block read at two places in one file: every
		// highlighted row matches the card drawn before, and only the numbers differ.
		const theme = await loadTheme("dark");
		const source = SOURCE.split("\n").slice(0, 40).join("\n");
		const numbered = (first: number) =>
			codeCard(
				source,
				count => ({ language: "ts", lineNumbers: Array.from({ length: count }, (_, index) => first + index) }),
				undefined,
			);
		for (const first of [10, 500]) {
			drawToolView(numbered(first === 10 ? 500 : 10), theme, 0).render(100);
			const drawn = drawToolView(numbered(first), theme, 0).render(100);
			drawToolView(outputCard("unrelated"), theme, 0).render(100);
			drawToolView(codeCard("let unrelated = true;", GUTTERS[1].code, undefined), theme, 0).render(100);
			expect({ first, rows: drawn }).toEqual({ first, rows: drawToolView(numbered(first), theme, 0).render(100) });
		}
	});
});
