import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { editToolRenderer } from "@veyyon/coding-agent/edit/renderer";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";

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

		const component = editToolRenderer.renderCall(
			{ file_path: "/tmp/table.md", previewDiff: tallWrappedDiff },
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = component.render(WIDTH);
		// Budget is 12 visual rows. Each table row takes 6 visual rows, so exactly 2 table rows fit (12 visual rows).
		// Plus 1 header line ("✎ Edit: /tmp/table.md"), 1 marker line ("… (8 more lines above)"), 1 label line ("(preview)").
		// Total visual rows emitted = 15 rows.
		const stripped = rendered.map(l => Bun.stripANSI(l));
		expect(stripped.some(l => l.includes("col1_10_payload_a"))).toBe(true);
		expect(stripped.some(l => l.includes("col1_9_payload_a"))).toBe(true);
		expect(stripped.some(l => l.includes("col1_8_payload_a"))).toBe(true);
		expect(stripped.some(l => l.includes("col1_1_payload_a"))).toBe(false);
		expect(stripped.some(l => l.includes("7 more lines above"))).toBe(true);
	});

	it("shares a single visual window across multi-file streaming diffs rather than multiplying per file", async () => {
		const uiTheme = await getUiTheme();
		// 2 files, each with 20 diff lines.
		const diffA = Array.from({ length: 20 }, (_, i) => `+line_a_${i + 1}`).join("\n");
		const diffB = Array.from({ length: 20 }, (_, i) => `+line_b_${i + 1}`).join("\n");

		const component = editToolRenderer.renderCall(
			{ file_path: "/tmp/file_a.ts" },
			{
				expanded: false,
				isPartial: true,
				spinnerFrame: 0,
				renderContext: {
					editMode: "replace",
					perFileDiffPreview: [
						{ path: "/tmp/file_a.ts", diff: diffA },
						{ path: "/tmp/file_b.ts", diff: diffB },
					],
				},
			},
			uiTheme,
		);
		const rendered = component.render(WIDTH);
		const stripped = rendered.map(l => Bun.stripANSI(l));
		// One budget of 12 visual diff rows is split across the two files, six each.
		// Pre-fix each file got the whole 12, so the block emitted 24 diff rows and
		// overflowed the preview window it has to fit inside. The count of diff rows
		// is the budget; the surrounding chrome (subheaders, separators, markers,
		// labels) is not pinned here because its row count answers to display
		// settings this contract does not own.
		expect(stripped.filter(l => l.includes("+line_a_")).length).toBe(6);
		expect(stripped.filter(l => l.includes("+line_b_")).length).toBe(6);
		expect(rendered.length).toBeLessThanOrEqual(previewWindowRows());

		// Both files are present and elided within their shared budget.
		expect(stripped.some(l => l.includes("file_a.ts"))).toBe(true);
		expect(stripped.some(l => l.includes("file_b.ts"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_a_20"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_a_15"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_b_20"))).toBe(true);
		expect(stripped.some(l => l.includes("+line_b_15"))).toBe(true);
		expect(stripped.some(l => /\+line_a_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.some(l => /\+line_b_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.some(l => l.includes("14 more lines above"))).toBe(true);
	});

	it("expanded preview reserves headroom from the viewport preview window for the final render", async () => {
		const uiTheme = await getUiTheme();
		// Viewport rows = 50 -> previewWindowRows() = 30.
		const windowRows = previewWindowRows();
		expect(windowRows).toBe(30);

		// Diff with 40 lines (exceeds preview window).
		const tallDiff = Array.from({ length: 40 }, (_, i) => `+tail_row_${i + 1}`).join("\n");

		const component = editToolRenderer.renderCall(
			{ file_path: "/tmp/expanded.ts", previewDiff: tallDiff },
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = component.render(WIDTH);
		// Expanded budget is previewWindowRows() - EDIT_STREAMING_HEADROOM (30 - 4 = 26 visual diff rows).
		// Plus 1 block header ("✎ Edit: /tmp/expanded.ts"), 1 marker ("… (14 more lines above)"), 1 spinner line.
		// Total visual rows emitted = 29 rows.
		// Pre-fix (budget = 30), total visual rows emitted = 33 rows (blowing past the 30-row preview window).
		expect(rendered.length).toBe(29);
		expect(rendered.length).toBeLessThanOrEqual(windowRows);

		const stripped = rendered.map(l => Bun.stripANSI(l));
		expect(stripped.some(l => l.includes("+tail_row_40"))).toBe(true);
		expect(stripped.some(l => l.includes("+tail_row_15"))).toBe(true);
		expect(stripped.some(l => /\+tail_row_1$/.test(l.trimEnd()))).toBe(false);
		expect(stripped.some(l => l.includes("14 more lines above"))).toBe(true);
	});
});
