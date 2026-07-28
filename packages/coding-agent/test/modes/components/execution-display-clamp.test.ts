/**
 * The bash and eval execution blocks clamp a long output line the same way, and that way is column-correct.
 *
 * Why this suite exists: both components declared `MAX_DISPLAY_LINE_CHARS = 4000` and both had a private
 * `#clampDisplayLine`, but the two implementations measured different things. Bash measured `visibleWidth`, the
 * terminal columns a line occupies, and truncated with `truncateToWidth`. Eval measured `line.length`, JavaScript
 * code units, and truncated with `line.slice`. One named limit, one value, two meanings, and two different notes
 * printed to the user ("visible columns omitted" against "chars omitted").
 *
 * The eval half was wrong in three separate ways, all of them invisible in a screenshot of short output:
 *
 *   - `line.length` counts ANSI escape bytes, and eval output is syntax-highlighted, so a styled line was
 *     charged for colour codes the user cannot see and truncated while it still displayed far short of 4000
 *     columns.
 *   - `line.length` counts a wide character as one. Two thousand CJK characters occupy 4000 columns, measured
 *     2000, and passed through untouched, so the block overflowed exactly where the check was meant to help.
 *   - `line.slice(0, 4000)` cuts wherever 4000 code units land, which can be the middle of an escape sequence or
 *     of a surrogate pair. The fragment reaches the terminal and the styling of everything after it is
 *     undefined.
 *
 * These cases pin the surviving behaviour against real strings, and lock both components onto the one helper.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import {
	buildStatusFooter,
	capExecutionOutputLines,
	clampExecutionDisplayLine,
	EXECUTION_MAX_DISPLAY_COLUMNS,
	EXECUTION_PREVIEW_LINES,
	EXECUTION_STREAMING_LINE_CAP,
} from "@veyyon/coding-agent/modes/components/execution-shared";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { resetKeybindingsForTests, setKeybindings, visibleWidth } from "@veyyon/tui";

const COMPONENTS = path.resolve(import.meta.dir, "../../../src/modes/components");
const CONSUMERS = ["bash-execution.ts", "eval-execution.ts"];

describe("the execution display budgets", () => {
	/**
	 * Twenty rows, which is a screenful rather than a summary. Deliberately not `PREVIEW_LIMITS.OUTPUT_COLLAPSED`
	 * (3) or `DEFAULT_TERMINAL_PREVIEW_LINES` (10): those describe how a finished tool result is summarised in the
	 * transcript, and this is a live block a user is watching run, where the whole point is seeing output scroll.
	 */
	it("shows twenty output rows before expansion", () => {
		expect(EXECUTION_PREVIEW_LINES).toBe(20);
	});

	/** Four thousand columns, and the name says columns because the measurement does. */
	it("caps a display line at four thousand columns", () => {
		expect(EXECUTION_MAX_DISPLAY_COLUMNS).toBe(4_000);
	});

	/** Both are positive integers, since one slices an array and the other is a width. */
	it("holds positive integers", () => {
		for (const value of [EXECUTION_PREVIEW_LINES, EXECUTION_MAX_DISPLAY_COLUMNS]) {
			expect(Number.isInteger(value)).toBeTrue();
			expect(value).toBeGreaterThan(0);
		}
	});
});

describe("clamping one output line", () => {
	/** A line inside the budget is returned byte for byte, with no note appended. */
	it("returns a short line untouched", () => {
		const line = "make: entering directory '/home/user/project'";
		expect(clampExecutionDisplayLine(line)).toBe(line);
	});

	/** A line exactly at the budget is still untouched, since the check is inclusive. */
	it("returns a line exactly at the budget untouched", () => {
		const line = "x".repeat(EXECUTION_MAX_DISPLAY_COLUMNS);
		expect(clampExecutionDisplayLine(line)).toBe(line);
	});

	/**
	 * One column over, and the note reports one column dropped. The count is columns because the measurement was
	 * columns, so a user comparing it against their wrapped terminal sees a number that corresponds to what they
	 * are looking at.
	 */
	it("reports the exact number of columns dropped", () => {
		const clamped = clampExecutionDisplayLine("x".repeat(EXECUTION_MAX_DISPLAY_COLUMNS + 1));
		expect(clamped).toContain("… [1 visible columns omitted]");
		const clampedMore = clampExecutionDisplayLine("x".repeat(EXECUTION_MAX_DISPLAY_COLUMNS + 250));
		expect(clampedMore).toContain("… [250 visible columns omitted]");
	});

	/** The kept prefix is the head of the line, truncated to the budget, not a sample from elsewhere in it. */
	it("keeps the head of the line", () => {
		const line = `START${"x".repeat(EXECUTION_MAX_DISPLAY_COLUMNS)}END`;
		const clamped = clampExecutionDisplayLine(line);
		expect(clamped.startsWith("START")).toBeTrue();
		expect(clamped).not.toContain("END");
	});

	/**
	 * The regression that motivated the unification. A syntax-highlighted line whose CODE-UNIT length is well
	 * over the budget, but whose visible width is far under it, must pass through untouched. The old eval
	 * implementation truncated this, so a coloured eval result was cut while displaying about forty columns.
	 */
	it("does not charge a styled line for its invisible escape bytes", () => {
		const coloured = Array.from({ length: 400 }, (_, index) => `\x1b[32mtoken${index}\x1b[0m`).join("");
		expect(coloured.length).toBeGreaterThan(EXECUTION_MAX_DISPLAY_COLUMNS);
		expect(visibleWidth(coloured)).toBeLessThan(EXECUTION_MAX_DISPLAY_COLUMNS);
		expect(clampExecutionDisplayLine(coloured)).toBe(coloured);
	});

	/**
	 * The other half of the same regression. Wide characters occupy two columns each, so a line of them overflows
	 * at half the code-unit count. The old eval implementation measured 2100 and let a 4200-column line through.
	 */
	it("clamps a wide-character line that a code-unit count would have let through", () => {
		const wide = "漢".repeat(EXECUTION_MAX_DISPLAY_COLUMNS / 2 + 100);
		expect(wide.length).toBeLessThan(EXECUTION_MAX_DISPLAY_COLUMNS);
		expect(visibleWidth(wide)).toBeGreaterThan(EXECUTION_MAX_DISPLAY_COLUMNS);
		const clamped = clampExecutionDisplayLine(wide);
		expect(clamped).not.toBe(wide);
		expect(clamped).toContain("visible columns omitted");
		expect(visibleWidth(clamped.slice(0, clamped.indexOf("…")))).toBeLessThanOrEqual(EXECUTION_MAX_DISPLAY_COLUMNS);
	});

	/**
	 * And the third: the cut must not land inside an escape sequence. A `slice` at a code-unit offset can split
	 * `\x1b[32m` and emit the fragment, after which the terminal's interpretation of everything following is
	 * undefined. Checked by requiring that no `\x1b` in the result is left without its terminating letter.
	 */
	it("never cuts in the middle of an escape sequence", () => {
		// One visible cell per element, so the count has to exceed the column budget for a cut to happen at all.
		const styled = Array.from(
			{ length: EXECUTION_MAX_DISPLAY_COLUMNS + 500 },
			(_, index) => `\x1b[3${index % 8}mW\x1b[0m`,
		).join("");
		const clamped = clampExecutionDisplayLine(styled);
		expect(visibleWidth(styled)).toBeGreaterThan(EXECUTION_MAX_DISPLAY_COLUMNS);
		expect(clamped).not.toBe(styled);
		for (const match of clamped.matchAll(/\x1b\[[0-9;]*/g)) {
			const after = clamped[match.index + match[0].length];
			expect(after, `escape at ${match.index} was cut short`).toMatch(/[A-Za-z]/);
		}
	});

	/** An empty line stays empty rather than picking up a note about nothing. */
	it("leaves an empty line empty", () => {
		expect(clampExecutionDisplayLine("")).toBe("");
	});
});

describe("bounding the retained output", () => {
	// Footer cases render themed text and read the live expand binding.
	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		resetKeybindingsForTests();
	});

	/**
	 * Five screenfuls, so expanding a block that is still running shows more than the collapsed view had. Bash had
	 * this bound and eval had none, so a long-running eval cell grew its retained lines without limit.
	 */
	it("retains five screenfuls of output while streaming", () => {
		expect(EXECUTION_STREAMING_LINE_CAP).toBe(EXECUTION_PREVIEW_LINES * 5);
		expect(EXECUTION_STREAMING_LINE_CAP).toBe(100);
	});

	/** A buffer inside the bound is left exactly as it was, and nothing is reported dropped. */
	it("leaves a buffer inside the bound untouched", () => {
		const lines = Array.from({ length: EXECUTION_STREAMING_LINE_CAP }, (_, index) => `line ${index}`);
		const before = [...lines];
		expect(capExecutionOutputLines(lines)).toBe(0);
		expect(lines).toEqual(before);
	});

	/**
	 * Over the bound, the OLDEST lines go and the newest are kept, because a user watching a build wants the tail.
	 * Asserted on identifiable content rather than on length alone, so a helper that trimmed the wrong end would
	 * fail here instead of passing a length check.
	 */
	it("drops the oldest lines and keeps the newest", () => {
		const total = EXECUTION_STREAMING_LINE_CAP + 37;
		const lines = Array.from({ length: total }, (_, index) => `line ${index}`);
		expect(capExecutionOutputLines(lines)).toBe(37);
		expect(lines.length).toBe(EXECUTION_STREAMING_LINE_CAP);
		expect(lines[0]).toBe("line 37");
		expect(lines.at(-1)).toBe(`line ${total - 1}`);
	});

	/**
	 * The dropped count is the whole reason this returns a number. The previous inline version dropped lines and
	 * then computed its "… N more lines" hint from the ALREADY-TRIMMED buffer, so a five-thousand-line run
	 * reported eighty hidden lines and expanding revealed a hundred. The caller now has the real figure.
	 */
	it("reports the true number dropped for a very long run", () => {
		const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index}`);
		expect(capExecutionOutputLines(lines)).toBe(5_000 - EXECUTION_STREAMING_LINE_CAP);
		expect(lines.length).toBe(EXECUTION_STREAMING_LINE_CAP);
	});

	/** Repeated calls accumulate correctly, which is how a streaming component actually uses it. */
	it("stays correct across repeated appends", () => {
		const lines: string[] = [];
		let dropped = 0;
		for (let batch = 0; batch < 30; batch++) {
			for (let index = 0; index < 10; index++) lines.push(`batch ${batch} line ${index}`);
			dropped += capExecutionOutputLines(lines);
			expect(lines.length).toBeLessThanOrEqual(EXECUTION_STREAMING_LINE_CAP);
		}
		expect(dropped).toBe(300 - EXECUTION_STREAMING_LINE_CAP);
		expect(lines.at(-1)).toBe("batch 29 line 9");
	});

	/** An empty buffer is a no-op rather than an error. */
	it("handles an empty buffer", () => {
		const lines: string[] = [];
		expect(capExecutionOutputLines(lines)).toBe(0);
		expect(lines).toEqual([]);
	});

	/**
	 * Dropped lines are reported in their OWN note, not folded into the hidden-line hint. The hint says
	 * "ctrl+o to expand", which for a dropped line would promise something that cannot happen: hidden lines are
	 * still held, dropped lines are gone.
	 */
	it("reports dropped lines separately from hidden lines", () => {
		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 80,
			droppedLineCount: 4_900,
		});
		const text = footer?.getText() ?? "";
		expect(text).toContain("4900 earlier lines dropped while streaming");
		expect(text).toContain("80 more lines (ctrl+o to expand)");
		// The dropped note comes first, because it describes the older content.
		expect(text.indexOf("dropped")).toBeLessThan(text.indexOf("more lines"));
	});

	/** With nothing dropped, the note is absent entirely rather than showing a zero. */
	it("says nothing about dropped lines when none were dropped", () => {
		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 5,
			droppedLineCount: 0,
		});
		expect(footer?.getText() ?? "").not.toContain("dropped");
	});

	/** The field is optional, so an existing caller that omits it behaves exactly as before. */
	it("omits the note when the caller does not pass a count", () => {
		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 5,
		});
		expect(footer?.getText() ?? "").not.toContain("dropped");
		expect(footer?.getText() ?? "").toContain("5 more lines");
	});
});

describe("both execution blocks use the one clamp", () => {
	/**
	 * The ratchet. Neither component may declare its own cap or its own clamp again, which is what the divergence
	 * grew out of: two private methods with one name, and nothing comparing them.
	 */
	it("declares no private cap or clamp in either component", async () => {
		const offenders: string[] = [];
		for (const file of CONSUMERS) {
			const text = await Bun.file(path.join(COMPONENTS, file)).text();
			for (const pattern of [
				/^\s*const MAX_DISPLAY_LINE_CHARS\b/m,
				/^\s*const PREVIEW_LINES\b/m,
				/^\s*const STREAMING_LINE_CAP\b/m,
				/#clampDisplayLine/,
			]) {
				if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** The positive half: both call the shared helper and take both budgets from the shared module. */
	it("has both components importing the shared clamp", async () => {
		for (const file of CONSUMERS) {
			const text = await Bun.file(path.join(COMPONENTS, file)).text();
			expect(text, file).toContain("clampExecutionDisplayLine");
			expect(text, file).toContain("EXECUTION_PREVIEW_LINES");
			expect(text, file).toMatch(/from "\.\/execution-shared";/);
			// Both bound their retained output and both report what they dropped. Eval had neither.
			expect(text, file).toContain("capExecutionOutputLines(this.#outputLines)");
			expect(text, file).toContain("droppedLineCount: this.#droppedLineCount");
		}
	});

	/**
	 * The non-vacuity twin: prove the two files being read really are the execution components, so a rename
	 * cannot leave the ratchet passing over unrelated content.
	 */
	it("reads the two execution components it claims to", async () => {
		const bash = await Bun.file(path.join(COMPONENTS, "bash-execution.ts")).text();
		const evalBlock = await Bun.file(path.join(COMPONENTS, "eval-execution.ts")).text();
		expect(bash).toContain("class BashExecutionComponent");
		expect(evalBlock).toContain("class EvalExecutionComponent");
	});

	/**
	 * The clamp lives beside the other helpers both components share, whose module doc already says it holds
	 * "a piece of structure both components share verbatim". The line clamp was such a piece and was not there,
	 * which is how the two copies drifted apart in the first place.
	 */
	it("keeps the clamp in the module both components already share", async () => {
		const shared = await Bun.file(path.join(COMPONENTS, "execution-shared.ts")).text();
		expect(shared).toContain("export function clampExecutionDisplayLine");
		expect(shared).toContain("export const EXECUTION_MAX_DISPLAY_COLUMNS");
		expect(shared).toContain("export const EXECUTION_PREVIEW_LINES");
	});
});
