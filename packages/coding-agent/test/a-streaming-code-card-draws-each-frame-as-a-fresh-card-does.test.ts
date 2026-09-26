/**
 * WHY: a card that streams a code section reuses what it drew for the frame before. The highlighter
 * continues from the lines it settled, the code section keeps the row of every line whose highlighted
 * text and gutter cell are unchanged, and the tail window keeps the rows of every line it wrapped
 * last at the same width. The defect class is a reused row that differs from a fresh draw: a gutter
 * that widened at line 1000, a line numbered per row whose number moved, a lead on the first row, a
 * line that wraps at the new width, a theme switch, a card drawn without a window, and a headed block
 * whose output streams under a window of its own. Every frame is compared with the same view drawn
 * after an unrelated card replaced each of those memos, which draws it with nothing reused.
 *
 * Not caught: the cost. A memo that is never hit draws the same bytes and passes here; the bound is
 * measured by the streaming-card bench.
 */
import { describe, expect, it } from "bun:test";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, type Theme } from "@veyyon/coding-agent/theme/theme";
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

async function loadTheme(name: string): Promise<Theme> {
	const theme = await getThemeByName(name);
	if (theme === undefined) throw new Error(`theme ${name} is not bundled`);
	return theme;
}

/**
 * Stream `cardAt` frame by frame, switching width a third of the way in and theme two thirds of the
 * way in, and require each frame to draw as a card drawn with nothing to reuse draws it.
 */
async function assertStreamsLikeFreshDraws(label: string, cardAt: (source: string) => ToolView): Promise<void> {
	const dark = await loadTheme("dark");
	const light = await loadTheme("light");
	const all = frames(SOURCE);
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
