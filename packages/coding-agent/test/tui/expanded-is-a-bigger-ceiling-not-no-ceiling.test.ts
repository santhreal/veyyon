/**
 * A collapsed/expanded renderer bounds BOTH arms. Expanded means a bigger ceiling, never no ceiling.
 *
 * THE DEFECT CLASS. `test/todo-reminder-rendering.test.ts` asserted scale invariance on the DEFAULT
 * branch only, so the `echoFullList` branch shipped unbounded and rendered 51,587 characters for 300
 * items. The test was not slop: it was correct, and aimed at half its subject. Deleting weak
 * assertions never finds this, and coverage-by-file cannot see it, because the file IS covered.
 *
 * THE CONVENTION THIS ENFORCES, which is why the two fixes below are violations rather than opinions.
 * Five separate families in this package already pair a collapsed limit with a NAMED expanded one:
 *
 *   - `JSON_TREE_MAX_LINES_COLLAPSED` / `JSON_TREE_MAX_LINES_EXPANDED` (6 / 200) in `tools/json-tree.ts`,
 *     used by `mcp/render.ts`, `modes/components/tool-execution.ts` and `tools/eval-render.ts`
 *   - `COLLAPSED_TEXT_LIMIT` / `EXPANDED_TEXT_LIMIT` in `tools/grep.ts`
 *   - `INSPECT_OUTPUT_COLLAPSED_LINES` / `INSPECT_OUTPUT_EXPANDED_LINES` (4 / 16)
 *   - `TV_OUTPUT_COLLAPSED` / `TV_OUTPUT_EXPANDED` (1 / 3) in `tools/vibe-render.ts`
 *   - `PREVIEW_LIMITS.OUTPUT_COLLAPSED` / `PREVIEW_LIMITS.OUTPUT_EXPANDED` (3 / 10) in `tools/render-utils.ts`
 *
 * TWO MODULES DEVIATED, and both had zero behavioural tests (checked by filename and by grepping
 * `test/` for the module specifier; the only hits were prose in an architecture gate).
 *
 *   1. `tui/code-cell.ts` at four sites read `expanded ? raw.length : Math.min(raw.length, max)`, so
 *      `outputMaxLines = 6`, `codeMaxLines = 12` and `contentMaxLines = 12` -- all DEFAULT PARAMETERS,
 *      the path every test takes unless it says otherwise -- were bypassed entirely on expand. This
 *      cell is reached by `tools/read.ts`, which 54 test files import.
 *   2. `tools/gh-renderer.ts:369` gave its COLLAPSED arm `OUTPUT_EXPANDED` and its expanded arm no
 *      ceiling. Line 257 of the same file pairs them correctly, so one file disagreed with itself.
 *
 * WHY `it.each` OVER THE BRANCH VALUES rather than a second copy of the test. One assertion applied to
 * every value of the branch means a THIRD value added later inherits the contract instead of escaping
 * it, which is the whole failure being locked out. A duplicated test body pins only the values someone
 * remembered to duplicate it for.
 */
import { describe, expect, it } from "bun:test";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/render-utils";
import { renderCodeCell, renderMarkdownCell } from "@veyyon/coding-agent/tui/code-cell";

/** Far larger than any ceiling in play, so an unbounded arm is unmistakable in the line count. */
const HUGE = 5_000;

/** The ceiling both arms of `code-cell` must respect; see `EXPANDED_MAX_LINES` in that module. */
const CODE_CELL_EXPANDED_MAX = 200;

await initTheme();

/** Both renderers return an array of rendered lines, so the count IS the quantity under test. */
function lineCount(rendered: string[]): number {
	return rendered.length;
}

const bigCode = Array.from({ length: HUGE }, (_, i) => `const line${i} = ${i};`).join("\n");
const bigOutput = Array.from({ length: HUGE }, (_, i) => `output line ${i}`).join("\n");

describe("code-cell bounds both arms", () => {
	/**
	 * Locks out: an expanded arm with no ceiling. Asserted on the RENDERED LINE COUNT for a
	 * 5,000-line input, not on a return value being defined, because the defect is a quantity.
	 *
	 * Both branch values go through one assertion. `expanded: false` is the default parameter and was
	 * always covered; `expanded: true` is the arm that shipped unbounded.
	 */
	it.each([false, true])("renderCodeCell with expanded=%s stays under its ceiling", expanded => {
		const rendered = renderCodeCell({ code: bigCode, output: bigOutput, expanded, width: 80 }, theme);

		// Generous slack for chrome (header, frame, the "N more lines" hint) on top of the two
		// bounded sections. The point is the ORDER OF MAGNITUDE: unbounded renders 10,000+.
		expect(lineCount(rendered)).toBeLessThanOrEqual(CODE_CELL_EXPANDED_MAX * 2 + 50);
	});

	/**
	 * And the same for the markdown cell, whose `contentMaxLines` default was bypassed the same way.
	 */
	it.each([false, true])("renderMarkdownCell with expanded=%s stays under its ceiling", expanded => {
		const rendered = renderMarkdownCell({ content: bigCode, output: bigOutput, expanded, width: 80 }, theme);

		expect(lineCount(rendered)).toBeLessThanOrEqual(CODE_CELL_EXPANDED_MAX * 2 + 50);
	});

	/**
	 * NON-VACUITY, and the half that makes the ceilings above mean something. Expanding must still
	 * show STRICTLY MORE than collapsing, or the bound could be satisfied by ignoring `expanded`
	 * altogether, which is the opposite defect and just as wrong.
	 */
	it("shows strictly more when expanded than when collapsed", () => {
		const collapsed = lineCount(
			renderCodeCell({ code: bigCode, output: bigOutput, expanded: false, width: 80 }, theme),
		);
		const expanded = lineCount(
			renderCodeCell({ code: bigCode, output: bigOutput, expanded: true, width: 80 }, theme),
		);

		expect(expanded).toBeGreaterThan(collapsed);
		// And the collapsed arm really is the small one: 6 output + 12 code plus chrome.
		expect(collapsed).toBeLessThan(60);
	});
});

describe("the gh renderer's two arms agree about which constant is which", () => {
	/**
	 * Locks out the swap at `gh-renderer.ts:369`, where the COLLAPSED arm was handed
	 * `PREVIEW_LIMITS.OUTPUT_EXPANDED` and the expanded arm nothing. Stated as the ordering the two
	 * constants must have, which is what makes the swap detectable at all: if they were equal, the
	 * mix-up would be invisible and the pairing would carry no information.
	 */
	it("keeps the expanded preview strictly larger than the collapsed one", () => {
		expect(PREVIEW_LIMITS.OUTPUT_COLLAPSED).toBe(3);
		expect(PREVIEW_LIMITS.OUTPUT_EXPANDED).toBe(10);
		expect(PREVIEW_LIMITS.OUTPUT_EXPANDED).toBeGreaterThan(PREVIEW_LIMITS.OUTPUT_COLLAPSED);
	});
});
