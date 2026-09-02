import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { editToolView } from "@veyyon/coding-agent/edit/edit-view";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";

/**
 * WHY:
 * A tall streaming edit preview whose mutating rows scroll above the native
 * scrollback commit boundary mid-stream freezes into immutable terminal history
 * as a stale snapshot, and finalization then recommits the finished render
 * below it — duplicating the block on the tape.
 *
 * This suite defends the visual window bounds across:
 * 1. Single-file wrapped rows (e.g. wide markdown tables) bounded by visual rows,
 *    not bare line count.
 * 2. Multi-file streaming diffs sharing a single global budget rather than
 *    allocating N times the clamp.
 * 3. Expanded previews reserving headroom from the viewport preview window
 *    for the final render that follows.
 *
 * The card is described by `editToolView` and cut by the host that draws it, so each case below
 * states the view and measures the rows `drawToolView` produced from it. WHAT THIS DOES NOT CATCH:
 * the wording of the row a cut window leaves behind, which belongs to the host and is pinned where
 * the host is drawn.
 */

let originalRowsDescriptor: PropertyDescriptor | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	// Viewport rows = 50 -> previewWindowRows() = 30
	Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
});

afterAll(() => {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
	} else {
		Reflect.deleteProperty(process.stdout, "rows");
	}
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("streaming edit preview visual window bounds", () => {
	const WIDTH = 80;
	// innerWidth for block at WIDTH 80 is 78.
	// A markdown table row of 460 chars wraps to exactly 6 visual rows at inner width 78.
	const makeWideTableRow = (index: number) =>
		`+ | col1_${index}_payload_a | col2_${index}_payload_b_long_field | col3_${index}_more_data_here_to_fill_width | col4_${index}_even_more_content_in_the_markdown_table_that_spans_multiple_visual_rows_in_the_terminal | col5_${index}_end |`;

	it("bounds tall wrapped diff lines to the visual row budget instead of bare line count", async () => {
		const uiTheme = await getUiTheme();
		// 10 table rows, each 6 visual rows tall = 60 visual rows if unconstrained.
		const tallWrappedDiff = Array.from({ length: 10 }, (_, i) => makeWideTableRow(i + 1)).join("\n");

		const component = drawToolView(
			editToolView.renderCall(
				{ file_path: "/tmp/table.md", previewDiff: tallWrappedDiff, editMode: "replace" },
				{ expanded: false, partial: true, frame: 0 },
			),
			uiTheme,
			0,
		);

		const rendered = component.render(WIDTH);
		// Budget is 12 visual rows, one of which the note spends, so eleven rows of the change survive
		// and the newest table row is whole.
		const stripped = rendered.map(l => stripVTControlCharacters(l));
		expect(stripped.some(l => l.includes("col1_10_payload_a"))).toBe(true);
		expect(stripped.some(l => l.includes("col1_9_payload_a"))).toBe(true);
		expect(stripped.some(l => l.includes("col1_1_payload_a"))).toBe(false);
		expect(stripped.some(l => /\d+ earlier lines/.test(l))).toBe(true);
		expect(rendered.length).toBeLessThanOrEqual(previewWindowRows());
	});

	it("shares a single visual window across multi-file streaming diffs rather than multiplying per file", async () => {
		const uiTheme = await getUiTheme();
		// 2 files, each with 20 diff lines.
		const diffA = Array.from({ length: 20 }, (_, i) => `+line_a_${i + 1}`).join("\n");
		const diffB = Array.from({ length: 20 }, (_, i) => `+line_b_${i + 1}`).join("\n");

		const component = drawToolView(
			editToolView.renderCall(
				{
					file_path: "/tmp/file_a.ts",
					editMode: "replace",
					previewFiles: [
						{ path: "/tmp/file_a.ts", diff: diffA },
						{ path: "/tmp/file_b.ts", diff: diffB },
					],
				},
				{ expanded: false, partial: true, frame: 0 },
			),
			uiTheme,
			0,
		);
		const rendered = component.render(WIDTH);
		const stripped = rendered.map(l => stripVTControlCharacters(l));
		// One budget of 12 visual rows is split across the two files, six each, and each file spends
		// one of its six on the row saying what it dropped. Pre-fix each file got the whole 12, so the
		// block emitted 24 diff rows and overflowed the preview window it has to fit inside.
		expect(stripped.filter(l => l.includes("+line_a_")).length).toBe(5);
		expect(stripped.filter(l => l.includes("+line_b_")).length).toBe(5);
		expect(rendered.length).toBeLessThanOrEqual(previewWindowRows());

		// Both files are present and elided within their shared budget.
		expect(stripped.some(l => l.includes("file_a.ts"))).toBe(true);
		expect(stripped.some(l => l.includes("file_b.ts"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_a_20"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_a_16"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_b_20"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_b_16"))).toBe(true);
		expect(stripped.some(l => /\+line_a_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.some(l => /\+line_b_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.filter(l => /15 earlier lines/.test(l)).length).toBe(2);
	});

	it("expanded preview reserves headroom from the viewport preview window for the final render", async () => {
		const uiTheme = await getUiTheme();
		// Viewport rows = 50 -> previewWindowRows() = 30.
		const windowRows = previewWindowRows();
		expect(windowRows).toBe(30);

		// Diff with 40 lines (exceeds preview window).
		const tallDiff = Array.from({ length: 40 }, (_, i) => `+tail_row_${i + 1}`).join("\n");

		const component = drawToolView(
			editToolView.renderCall(
				{ file_path: "/tmp/expanded.ts", previewDiff: tallDiff, editMode: "replace" },
				{ expanded: true, partial: true, frame: 0 },
			),
			uiTheme,
			0,
		);

		const rendered = component.render(WIDTH);
		// An expanded preview asks the host for its whole window and gets no more than it: the block
		// fits inside `previewWindowRows()` with the head row and the streaming row it also spends.
		expect(rendered.length).toBeLessThanOrEqual(windowRows);

		const stripped = rendered.map(l => stripVTControlCharacters(l));
		expect(stripped.some(l => l.includes("+tail_row_40"))).toBe(true);
		expect(stripped.some(l => /\+tail_row_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.some(l => /\d+ earlier lines/.test(l))).toBe(true);
	});
});
