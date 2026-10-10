import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { editToolView } from "@veyyon/coding-agent/edit/edit-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";

/**
 * WHY: a collapsed settled edit card is cut to `PREVIEW_LIMITS.DIFF_COLLAPSED_LINES` diff rows and
 * states how many it held back. When the change lines alone overflowed that budget, the cut was
 * checked only after a whole run of `+`/`-` lines was copied, so one long replacement drew every
 * row: a 600-line change filled 603 rows of the transcript, and a run of about a million lines
 * overflowed the call stack while the card was built.
 *
 * Closes the class for every diff shape that reaches the overflow: one run longer than the budget,
 * a run that crosses the budget after earlier hunks, and runs a line either side of the budget.
 * Each card must draw at most the budget, hold back exactly the rest, and keep the head of the
 * change; the expanded card must draw every row.
 *
 * Does not catch: the streaming card, which is not cut here and asks the host for a tail window
 * instead (`edit-streaming-preview-window-bounds.test.ts`).
 */

const BUDGET = PREVIEW_LIMITS.DIFF_COLLAPSED_LINES;
/** A diff row as drawn: an optional marker, the line number, the gutter bar. */
const DIFF_ROW = /^▏\s*[+\- ]?\s*\d+│/;

let uiTheme: Theme;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	uiTheme = theme!;
});

function drawCard(diff: string, expanded: boolean): string[] {
	const view = editToolView.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff, op: "update", path: "src/a.ts" }, isError: false },
		{ expanded, partial: false },
		{ file_path: "src/a.ts" },
	);
	return stripVTControlCharacters(drawToolView(view, uiTheme).render(160).join("\n")).split("\n");
}

/** `hunks` replacements of `run` lines each, every one framed by a context line. */
function replacementDiff(hunks: number, run: number): string[] {
	const rows: string[] = [];
	let line = 1;
	for (let h = 0; h < hunks; h++) {
		rows.push(` ${line++}|context ${h}`);
		for (let i = 0; i < run; i++) rows.push(`-${line + i}|old ${h}.${i}`);
		for (let i = 0; i < run; i++) rows.push(`+${line + i}|new ${h}.${i}`);
		line += run;
	}
	rows.push(` ${line}|context end`);
	return rows;
}

const SHAPES: Array<{ name: string; rows: string[] }> = [
	{ name: "one run two lines over the budget", rows: replacementDiff(1, BUDGET / 2 + 1) },
	{ name: "one run of twice the budget", rows: replacementDiff(1, BUDGET) },
	{ name: "one run of 300 lines", rows: replacementDiff(1, 300) },
	{ name: "a run that crosses the budget after earlier hunks", rows: replacementDiff(3, 10) },
	{ name: "change lines one over the budget", rows: replacementDiff(1, BUDGET / 2 + 1).slice(0, BUDGET + 2) },
];

describe("a collapsed edit card holds at most the collapsed line budget", () => {
	for (const { name, rows } of SHAPES) {
		it(`cuts ${name} to the budget and holds back the rest`, () => {
			const changeLines = rows.filter(row => row.startsWith("+") || row.startsWith("-")).length;
			expect(changeLines).toBeGreaterThan(BUDGET);

			const collapsed = drawCard(rows.join("\n"), false);
			const drawn = collapsed.filter(row => DIFF_ROW.test(row));
			expect(drawn).toHaveLength(BUDGET);
			// The head of the change is what a collapsed card keeps.
			expect(drawn[0]).toContain(rows[0].slice(rows[0].indexOf("|") + 1));
			expect(drawn.at(-1)).toContain(rows[BUDGET - 1].slice(rows[BUDGET - 1].indexOf("|") + 1));
			expect(collapsed.some(row => row.includes(`${rows.length - BUDGET} more lines`))).toBe(true);

			const expanded = drawCard(rows.join("\n"), true);
			expect(expanded.filter(row => DIFF_ROW.test(row))).toHaveLength(rows.length);
		});
	}

	it("builds the collapsed card of a million-line replacement without overflowing the stack", () => {
		const rows = Array.from({ length: 1_000_000 }, (_, i) => `+${i + 1}|new ${i}`);
		const collapsed = drawCard(rows.join("\n"), false);
		expect(collapsed.filter(row => DIFF_ROW.test(row))).toHaveLength(BUDGET);
		expect(collapsed.some(row => row.includes(`${rows.length - BUDGET} more lines`))).toBe(true);
	});
});
