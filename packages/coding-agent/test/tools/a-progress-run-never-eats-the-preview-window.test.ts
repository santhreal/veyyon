/**
 * WHY: a tool card's collapsed output section is a viewport-sized TAIL window.
 * A build spends that whole window on `Compiling …` rows, so by the time the run
 * ends the one line worth reading (a warning, a failing assertion, a summary)
 * has already scrolled out of the card, and the reader has to press ctrl+o or
 * open the artifact to find out what happened. The per-tool shell minimizer in
 * `crates/veyyon-shell/src/minimizer/` cannot help here: its filters rebuild
 * whole buffers and only ever run on a SEALED capture, while this window is
 * painted from the live stream.
 *
 * The class closed: a run of consecutive same-shape lines is counted away before
 * the window is measured, for every renderer that measures one. The suite
 * asserts the shape rule itself (so a new progress format is a key question, not
 * a new call site), the two cards that own such a window, and the negative
 * control that the uncollapsed tail really did hide the anomaly.
 *
 * What it does NOT catch: the ssh card's fixed five-line fallback preview
 * (`tools/ssh.ts`, no tail window at all), the interactive `!command` execution
 * block (`modes/components/execution-shared.ts:createCollapsedPreview`, which is
 * handed pre-styled text and so cannot key on a leading token), a markdown eval
 * cell (rendered by `Markdown` before the tail is taken), and the Rust
 * minimizer's per-tool filters, which have their own tests in the crate.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { truncateToVisualLines } from "@veyyon/coding-agent/modes/components/visual-truncate";
import { theme as activeTheme, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@veyyon/coding-agent/tools/bash";
import { evalToolRenderer } from "@veyyon/coding-agent/tools/eval-render";
import {
	collapseProgressRuns,
	PROGRESS_RUN_MIN_LINES,
	previewWindowRows,
} from "@veyyon/coding-agent/tools/render-utils";
import { resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function compiling(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `   Compiling crate-${i} v0.1.${i}`);
}

/** Anomaly first, then the wall: the layout a tail window loses. */
const WARNING = "warning: unused variable: `parsed`";
const CARGO_CAPTURE = ["$ cargo test -p keyhog-scanner", WARNING, ...compiling(40)];

describe("collapseProgressRuns", () => {
	test("counts a run away down to its newest line", () => {
		expect(collapseProgressRuns(["Compiling a", "Compiling b", "Compiling c", "Compiling d"])).toEqual([
			{ text: "Compiling d", hidden: 3 },
		]);
	});

	test("keeps a run shorter than the threshold verbatim", () => {
		const lines = compiling(PROGRESS_RUN_MIN_LINES - 1);
		expect(collapseProgressRuns(lines)).toEqual(lines.map(text => ({ text, hidden: 0 })));
	});

	test("collapses only the run, leaving the lines around it in order", () => {
		expect(collapseProgressRuns(["header", ...compiling(5), "test result: ok. 12 passed"])).toEqual([
			{ text: "header", hidden: 0 },
			{ text: "   Compiling crate-4 v0.1.4", hidden: 4 },
			{ text: "test result: ok. 12 passed", hidden: 0 },
		]);
	});

	test("shares one key across a counter's digits", () => {
		expect(
			collapseProgressRuns(["[1/47] Building x", "[2/47] Building y", "[3/47] Building z", "[4/47] Building w"]),
		).toEqual([{ text: "[4/47] Building w", hidden: 3 }]);
	});

	test("keys past the SGR escapes a real build writes", () => {
		// What cargo actually emits, bold-green verb and all. Keyed on raw bytes the
		// first token is the escape sequence, which is no shape at all, so a colored
		// build collapsed nothing while the plain fixture above passed.
		const colored = Array.from(
			{ length: 5 },
			(_, i) => `\u001b[0m\u001b[1m\u001b[32m   Compiling\u001b[0m crate-${i} v0.1.${i}`,
		);
		expect(collapseProgressRuns(colored)).toEqual([{ text: colored[4], hidden: 4 }]);
	});

	test("never counts distinct diagnostics away", () => {
		const warnings = ["warning: unused a", "warning: unused b", "warning: unused c", "warning: unused d"];
		expect(collapseProgressRuns(warnings)).toEqual(warnings.map(text => ({ text, hidden: 0 })));
	});

	test("still collapses byte-identical neighbours, diagnostic or not", () => {
		// Repeating one line eight times says nothing the count does not.
		expect(collapseProgressRuns(Array.from({ length: 8 }, () => "error: linker not found"))).toEqual([
			{ text: "error: linker not found", hidden: 7 },
		]);
	});

	test("never counts a directory listing away", () => {
		// One run of five rows sharing a leading token, which is what any
		// `ls -l` of same-mode files is. Only the shape rule keeps these: drop it
		// and a listing of five files reads as one file plus `+4 earlier`.
		const listing = [
			"-rw-r--r-- 1 user user  120 Aug  7 10:00 Cargo.toml",
			"-rw-r--r-- 1 user user 4096 Aug  7 10:00 README.md",
			"-rw-r--r-- 1 user user   77 Aug  7 10:00 build.rs",
			"-rw-r--r-- 1 user user  512 Aug  7 10:00 rustfmt.toml",
			"-rw-r--r-- 1 user user  918 Aug  7 10:00 clippy.toml",
		];
		expect(collapseProgressRuns(listing)).toEqual(listing.map(text => ({ text, hidden: 0 })));
	});

	test("never anchors a run on blank lines", () => {
		const blanks = ["", "", "", "", ""];
		expect(collapseProgressRuns(blanks)).toEqual(blanks.map(text => ({ text, hidden: 0 })));
	});
});

describe("the collapsed card window", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		// A 30-row terminal leaves a 10-visual-row tail window, which is smaller
		// than the wall of progress lines below.
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 30 });
	});
	afterEach(() => {
		resetKeybindingsForTests();
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("the uncollapsed tail of the same capture hides the anomaly", () => {
		// The negative control: without the collapse, the window this card is
		// allowed is spent entirely on `Compiling` rows.
		const window = truncateToVisualLines(CARGO_CAPTURE.join("\n"), previewWindowRows(), 80);
		expect(window.skippedCount).toBeGreaterThan(0);
		expect(window.visualLines.join("\n")).not.toContain(WARNING);
	});

	test("bash keeps the warning and names what it counted away", () => {
		const rendered = plain(
			bashToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: CARGO_CAPTURE.join("\n") }] },
					{ expanded: false, isPartial: false },
					activeTheme,
				)
				.render(80),
		);
		expect(rendered.join("\n")).toContain(WARNING);
		expect(rendered.join("\n")).toContain("+39 earlier");
		expect(rendered.filter(line => line.includes("Compiling"))).toHaveLength(1);
	});

	test("ctrl+o still shows every progress line bash counted away", () => {
		const rendered = plain(
			bashToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: CARGO_CAPTURE.join("\n") }] },
					{ expanded: true, isPartial: false },
					activeTheme,
				)
				.render(80),
		);
		expect(rendered.filter(line => line.includes("Compiling"))).toHaveLength(40);
		expect(rendered.join("\n")).not.toContain("+39 earlier");
	});

	test("eval keeps the warning and names what it counted away", () => {
		const rendered = plain(
			evalToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: CARGO_CAPTURE.join("\n") }] },
					{ expanded: false, isPartial: false },
					activeTheme,
				)
				.render(80),
		);
		expect(rendered.join("\n")).toContain(WARNING);
		expect(rendered.join("\n")).toContain("+39 earlier");
		expect(rendered.filter(line => line.includes("Compiling"))).toHaveLength(1);
	});

	test("an eval cell keeps the warning and names what it counted away", () => {
		const rendered = plain(
			evalToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: {
							cells: [
								{
									index: 0,
									code: "await run()",
									language: "js" as const,
									output: CARGO_CAPTURE.join("\n"),
									status: "complete" as const,
								},
							],
						},
					},
					{ expanded: false, isPartial: false },
					activeTheme,
				)
				.render(80),
		);
		expect(rendered.join("\n")).toContain(WARNING);
		expect(rendered.join("\n")).toContain("+39 earlier");
		expect(rendered.filter(line => line.includes("Compiling"))).toHaveLength(1);
	});
});
