/**
 * The `bash` card draws what main's renderer drew, for the command, the output and every notice.
 *
 * NINE DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived silently:
 *
 *  - EVERY COMPARISON CLOSES UP EMPTY STYLING RUNS. Main coloured each collapsed output line, joined
 *    the lot into one string and split it again inside the window it measured, so every row it
 *    produced that way opens and closes a colour with no glyph in it. `sameRows` strips a run with an
 *    empty body and nothing else, and one cell below pins that the residue is the whole difference.
 *  - THE COLLAPSED OUTPUT WINDOW states what it dropped in the host's own sentence, `… N earlier
 *    lines ▸ Ctrl+O expand`, where main wrote `… (N earlier lines, showing X of Y)` for output alone
 *    — main's own command window already used the host's sentence. The host cuts the window, because
 *    how many rows a stream occupies is known only after it wraps, so the note is the host's.
 *  - THE NOTE IS ONE OF THE ROWS THE WINDOW MAY SPEND, so the view keeps one output row fewer than
 *    main, which pushed its note above a window it had already measured and drew eleven rows of a
 *    ten-row bound. Both arms keep the same newest rows.
 *  - THE WINDOW IS MEASURED IN WRAPPED ROWS. Main counted the tool's lines, so a command whose lines
 *    are wider than the card overran the window it exists to fit.
 *  - A CARD THAT IS STILL ARRIVING carries the host's `… (streaming)` row, which main had nowhere: the
 *    host moves the animation off the head row so a live preview cannot pin the scrollback boundary.
 *  - THE PROMPT IS AN ASIDE. `$ cd services && FOO=1 ` is the section's lead, which the host draws in
 *    the aside colour and never sends to a highlighter; main built the same bytes by hand. Identical
 *    unless the highlighter would have coloured the prompt itself.
 *  - A RESULT WITH NO ARGUMENTS states no command rows. Main drew the section empty, which is the same
 *    rows, and both are the rebuilt-transcript case rather than anything a run produces.
 *  - THE LIVE EDGE is compared without truecolor. Both arms paint the newest row with the same
 *    follow trail, whose sheen is positioned from the wall clock, so a byte comparison of two arms
 *    rendered microseconds apart would be a clock race. `test/tools/bash-live-tail.test.ts` owns that
 *    the trail is painted at all, and the cell below proves the rows are identical without it.
 *  - A NOTICE IS STRIPPED ONLY WHERE THE TOOL APPENDED IT, at the end. Main deleted the last
 *    occurrence anywhere in the payload, so a program whose own output printed the same sentence
 *    lost that line. The fact is on the card's own row either way.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Execution: nothing here runs a command. What the card CLAIMS is
 * `test/a-bash-card-states-what-the-shell-printed.test.ts`; this file proves the bytes did not move.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatOutputNotice,
	formatTruncationMetaNotice,
	type OutputMeta,
	type TruncationMeta,
} from "@veyyon/coding-agent/tools/core/output-meta";
import { previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";
import { BASH_DEFAULT_PREVIEW_LINES, type BashToolDetails } from "@veyyon/coding-agent/tools/shell/bash";
import { type BashViewArgs, type BashViewResult, bashToolView } from "@veyyon/coding-agent/tools/shell/bash-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { ImageProtocol, TERMINAL } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import type { ToolViewContext } from "@veyyon/view";
import * as bashOracle from "../oracles/bash-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

// `imageProtocol` is nullable on the real terminal info, and a cell that turns the protocol on has
// to be able to put the absence back.
type MutableTerminal = { trueColor: boolean; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminal;

describe("bash tool differential", () => {
	const COMMAND = "cargo test -p keyhog-scanner";

	/**
	 * The render context the terminal host builds for bash, which is the only shape the oracle ever
	 * saw in production: `tool-execution.ts` passes the sanitized text blocks as `output`, the
	 * disclosure state, the tool's own preview bound and the call's clamped timeout.
	 */
	function hostContext(
		result: BashViewResult,
		args: BashViewArgs,
		expanded: boolean,
	): { output: string; expanded: boolean; previewLines: number; timeout?: number } {
		const output = (result.content ?? [])
			.filter(block => block.type === "text")
			.map(block => sanitizeText(block.text ?? ""))
			.join("\n")
			.trimEnd();
		const timeout = typeof args.timeout === "number" ? Math.min(Math.max(args.timeout, 1), 3600) : undefined;
		return {
			output,
			expanded,
			previewLines: BASH_DEFAULT_PREVIEW_LINES,
			...(timeout === undefined ? {} : { timeout }),
		};
	}

	// Main's renderer reads its arguments as an open record, since a shell renderer is shared by
	// several tools; the view names the four fields a bash card reads. Both arms are handed the same
	// values under the shape each one declares.
	const oracleArgs = (args: BashViewArgs): bashOracle.BashRenderArgs => ({ ...args });

	function oracleResult(
		result: BashViewResult,
		args: BashViewArgs,
		{ expanded = false, partial = false }: { expanded?: boolean; partial?: boolean } = {},
		width = WIDTH,
	): string[] {
		const options: RenderResultOptions & { renderContext?: bashOracle.BashRenderContext } = {
			expanded,
			isPartial: partial,
			renderContext: hostContext(result, args, expanded),
		};
		return renderCompLines(bashOracle.bashMainRenderer.renderResult(result, options, theme, oracleArgs(args)), width);
	}

	function viewResult(
		result: BashViewResult,
		args: BashViewArgs,
		{ expanded = false, partial = false }: { expanded?: boolean; partial?: boolean } = {},
		width = WIDTH,
	): string[] {
		const context: ToolViewContext = { expanded, partial };
		return renderCompLines(drawToolView(bashToolView.renderResult(result, context, args), theme), width);
	}

	function oracleCall(args: BashViewArgs, expanded = false, width = WIDTH): string[] {
		return renderCompLines(
			bashOracle.bashMainRenderer.renderCall(oracleArgs(args), { expanded, isPartial: true }, theme),
			width,
		);
	}

	function viewCall(args: BashViewArgs, expanded = false, width = WIDTH): string[] {
		return renderCompLines(drawToolView(bashToolView.renderCall(args, { expanded }), theme), width);
	}

	const result = (text: string, details: BashToolDetails = {}, isError = false): BashViewResult => ({
		content: [{ type: "text", text }],
		details,
		isError,
	});

	const plain = (lines: readonly string[]): string[] => lines.map(line => stripVTControlCharacters(line));

	/**
	 * A run of styling that opens and closes with no glyph between it.
	 *
	 * Main built its collapsed output by colouring each line, joining the lot into one string and
	 * splitting it again inside the window it measured, which left an opened-and-closed colour at the
	 * start of every row the split produced. The host colours each row once, so the rows differ by
	 * those zero-width runs and by nothing a terminal draws. Stripping only a run with an empty body
	 * keeps every real difference: a tone that moved, a style that was dropped and a colour that
	 * changed all sit around glyphs.
	 */
	const EMPTY_COLOUR_RUN = /\u001b\[(?:38;2;\d+;\d+;\d+|3[0-7]|9[0-7])m\u001b\[39m/g;

	const withoutEmptyRuns = (lines: readonly string[]): string[] =>
		lines.map(line => {
			let out = line;
			for (let next = out.replace(EMPTY_COLOUR_RUN, ""); next !== out; next = out.replace(EMPTY_COLOUR_RUN, "")) {
				out = next;
			}
			return out;
		});

	/** The two arms compared with main's empty colour runs closed up, and nothing else moved. */
	const sameRows = (view: readonly string[], oracle: readonly string[], label?: string): void => {
		expect(withoutEmptyRuns(view), label).toEqual(withoutEmptyRuns(oracle));
	};

	describe("a pending call", () => {
		it("draws the command under its prompt, byte for byte, at every width", () => {
			for (const width of [200, WIDTH, 40]) {
				const args: BashViewArgs = { command: COMMAND };
				expect(viewCall(args, false, width)).toEqual(oracleCall(args, false, width));
			}
		});

		it("draws a working directory and env assignments as the same prompt", () => {
			const args: BashViewArgs = { command: "printf '%s' \"$A\"", cwd: "/repo/services", env: { A: "one two" } };
			expect(viewCall(args)).toEqual(oracleCall(args));
			expect(viewCall(args, true)).toEqual(oracleCall(args, true));
		});

		it("draws a command that has not arrived yet as the bare prompt", () => {
			expect(viewCall({})).toEqual(oracleCall({}));
		});

		it("quotes every env value the shell would take differently, in the order main sorted them", () => {
			// One value per escape the preview writes: a backslash, a dollar, a backtick, a double
			// quote, a newline and a tab. The names arrive reversed, so the row also proves the order
			// both arms sort them into rather than the order the object was built in.
			const args: BashViewArgs = {
				command: "./run",
				env: {
					ZULU: 'say "hi"',
					MIKE: "cost $HOME `id` 100%",
					ALPHA: "C:\\repo\\src\tone\ntwo",
				},
			};
			expect(viewCall(args)).toEqual(oracleCall(args));
			expect(viewCall(args, true)).toEqual(oracleCall(args, true));
		});

		it("draws a command carrying a tab as the same spaces main drew", () => {
			const args: BashViewArgs = { command: "printf\t'%s'\tone" };
			expect(viewCall(args)).toEqual(oracleCall(args));
		});

		it("draws an empty command as the same placeholder", () => {
			const args: BashViewArgs = { command: "" };
			expect(viewCall(args)).toEqual(oracleCall(args));
		});
	});

	describe("a settled result", () => {
		it("draws the command, the output and the stats row at every width", () => {
			const settled = result("running 6 tests\ntest scans_a_wav ... ok", { timeoutSeconds: 300, wallTimeMs: 1230 });
			for (const width of [200, WIDTH, 40]) {
				sameRows(
					viewResult(settled, { command: COMMAND }, {}, width),
					oracleResult(settled, { command: COMMAND }, {}, width),
				);
			}
		});

		it("draws every line of a multi-line command with its own styling run", () => {
			const args: BashViewArgs = { command: 'for f in a b; do\n\techo "$f"\ndone' };
			const settled = result("a\nb");
			sameRows(viewResult(settled, args), oracleResult(settled, args));
			sameRows(viewResult(settled, args, { expanded: true }), oracleResult(settled, args, { expanded: true }));
		});

		it("folds the wall-time, exit, background and artifact notices into the same row", () => {
			const cells: { name: string; result: BashViewResult }[] = [
				{ name: "wall time", result: result("hello\n\nWall time: 1.23 seconds", { wallTimeMs: 1230 }) },
				{
					name: "exit code",
					result: result("boom\n\nCommand exited with code 1", { exitCode: 1, wallTimeMs: 20 }, true),
				},
				{
					name: "signal",
					result: result("killed\n\nCommand exited with code 137 (SIGKILL)", { exitCode: 137, signal: 9 }, true),
				},
				{
					name: "backgrounded",
					result: result("started\n\nBackgrounded as job bash-42; result will be delivered automatically.", {
						async: { state: "running", jobId: "bash-42", type: "bash" },
					}),
				},
				{
					name: "raw artifact",
					result: result("filtered\n[raw output: artifact://13]\n\nWall time: 0.08 seconds", { wallTimeMs: 80 }),
				},
			];
			for (const cell of cells) {
				sameRows(
					viewResult(cell.result, { command: COMMAND }),
					oracleResult(cell.result, { command: COMMAND }),
					cell.name,
				);
			}
		});

		it("draws the timeout the tool used, clamped or disabled, as the same row", () => {
			const cells: { result: BashViewResult; args: BashViewArgs }[] = [
				{ result: result("ok", { timeoutSeconds: 120 }), args: { command: COMMAND, timeout: 1200 } },
				{
					result: result("ok", { timeoutSeconds: 3600, requestedTimeoutSeconds: 99_999 }),
					args: { command: COMMAND, timeout: 99_999 },
				},
				{ result: result("ok", { timeoutDisabled: true }), args: { command: COMMAND, timeout: 0 } },
				{ result: result("ok"), args: { command: COMMAND, timeout: 45 } },
			];
			for (const cell of cells) {
				expect(viewResult(cell.result, cell.args)).toEqual(oracleResult(cell.result, cell.args));
			}
		});

		it("draws a command that printed nothing as the command alone", () => {
			const empty = result("", { timeoutSeconds: 300 });
			expect(viewResult(empty, { command: COMMAND })).toEqual(oracleResult(empty, { command: COMMAND }));
			const blank = result("   \n\n", { timeoutSeconds: 300 });
			expect(viewResult(blank, { command: COMMAND })).toEqual(oracleResult(blank, { command: COMMAND }));
		});

		it("clamps the bound a call asked for the way main clamped it, with no details to read", () => {
			// Nothing in the details states a timeout here, so the row is composed from the call's own
			// argument — which is where the ceiling and the floor live.
			const settled = result("ok", { wallTimeMs: 10 });
			for (const timeout of [99_999, 0.2, 3600, 1]) {
				const args: BashViewArgs = { command: COMMAND, timeout };
				sameRows(viewResult(settled, args), oracleResult(settled, args), `timeout ${timeout}`);
			}
		});

		it("states no exit row for a command that succeeded with a code in its details", () => {
			const settled = result("ok", { exitCode: 0, wallTimeMs: 30 });
			sameRows(viewResult(settled, { command: "true" }), oracleResult(settled, { command: "true" }));
			expect(plain(viewResult(settled, { command: "true" })).join("\n")).not.toContain("Exit:");
		});

		it("keeps a notice the program itself printed above its own output", () => {
			// The same sentence the tool appends, printed by the program in the middle of its output:
			// only the trailing one is the tool's, and both arms strip only that one.
			const settled = result("Wall time: 9.99 seconds\nstill running\n\nWall time: 1.23 seconds", {
				wallTimeMs: 1230,
			});
			sameRows(viewResult(settled, { command: COMMAND }), oracleResult(settled, { command: COMMAND }));
			const rendered = plain(viewResult(settled, { command: COMMAND })).join("\n");
			expect(rendered).toContain("Wall time: 9.99 seconds");
			expect(rendered).toContain("Wall: 1.23s");
		});

		it("keeps a line the program printed that main deleted, which is the ninth pinned difference", () => {
			// THE EXCEPTION: the tool appends its sentence at the END, and the view strips it only
			// there. Main took the LAST occurrence anywhere (`lastIndexOf`), so a program whose own
			// output ended in the same words lost that line and kept the tool's. Here the program
			// printed the sentence and then kept going, so there is nothing appended to strip at all.
			const settled = result("Wall time: 1.23 seconds\ndone", { wallTimeMs: 1230 });
			const view = plain(viewResult(settled, { command: COMMAND })).join("\n");
			const oracle = plain(oracleResult(settled, { command: COMMAND })).join("\n");
			expect(view).toContain("Wall time: 1.23 seconds");
			expect(view).toContain("done");
			expect(oracle).not.toContain("Wall time: 1.23 seconds");
			// The fact itself is on the card's own row in both arms, which is why deleting the
			// program's line cost main a line of output and no information.
			expect(view).toContain("Wall: 1.23s");
			expect(oracle).toContain("Wall: 1.23s");
		});

		it("takes the notice the tool appended for the model back off the card", () => {
			const truncation: TruncationMeta = {
				direction: "tail",
				truncatedBy: "lines",
				totalLines: 900,
				totalBytes: 90_000,
				outputLines: 2,
				outputBytes: 18,
				shownRange: { start: 1, end: 2 },
			};
			const meta: OutputMeta = { truncation };
			const notice = formatOutputNotice(meta);
			const sentence = formatTruncationMetaNotice(truncation);
			expect(notice).toContain(sentence);
			const settled = result(`kept one\nkept two\n\n${notice}`, { wallTimeMs: 10, meta });
			sameRows(viewResult(settled, { command: COMMAND }), oracleResult(settled, { command: COMMAND }));
			const rendered = plain(viewResult(settled, { command: COMMAND })).join("\n");
			expect(rendered).toContain("kept two");
			// The card states the truncation on its own row, so the sentence written for the model is
			// stated once rather than echoed above it as output too.
			const occurrences = rendered.split(sentence).length - 1;
			expect(occurrences).toBe(1);
		});

		it("draws output carrying tabs as the same spaces main drew", () => {
			const settled = result("name\tvalue\nalpha\tone", { wallTimeMs: 10 });
			sameRows(viewResult(settled, { command: "column -t" }), oracleResult(settled, { command: "column -t" }));
			expect(plain(viewResult(settled, { command: "column -t" })).join("\n")).not.toContain("\t");
		});

		it("states the truncation the tool reported as the same sentence", () => {
			const settled = result("kept one\nkept two", {
				wallTimeMs: 10,
				meta: {
					truncation: {
						direction: "tail",
						truncatedBy: "lines",
						totalLines: 900,
						totalBytes: 90_000,
						outputLines: 2,
						outputBytes: 18,
						shownRange: { start: 1, end: 2 },
					},
				},
			});
			sameRows(viewResult(settled, { command: COMMAND }), oracleResult(settled, { command: COMMAND }));
			expect(plain(viewResult(settled, { command: COMMAND })).join("\n")).toContain("900");
		});

		it("counts a progress wall away to the same rows in a collapsed card", () => {
			const wall = [
				"warning: unused variable: `parsed`",
				...Array.from({ length: 8 }, (_, i) => `   Compiling c-${i}`),
			];
			const settled = result(wall.join("\n"), { wallTimeMs: 4100 });
			sameRows(viewResult(settled, { command: COMMAND }), oracleResult(settled, { command: COMMAND }));
		});

		it("draws every line of the same output when the card is expanded", () => {
			const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
			const settled = result(long, { wallTimeMs: 2000 });
			expect(viewResult(settled, { command: COMMAND }, { expanded: true })).toEqual(
				oracleResult(settled, { command: COMMAND }, { expanded: true }),
			);
		});

		it("draws an output carrying an image payload the way main drew it", () => {
			const sixel = "\x1bPqabc\x1b\\";
			const settled = result(`line one\n${sixel}\nline two`);
			// Both arms key their passthrough off the terminal's protocol, so it is on for both. Whether
			// the payload BYTES reach the screen is the ANSI policy's answer and this comparison runs
			// under the policy that strips them; `test/a-bash-card-states-what-the-shell-printed.test.ts`
			// owns that a real terminal gets the image. What is proved here is that the rows around it,
			// and the window the card does not ask for, are main's.
			const originalProtocol = TERMINAL.imageProtocol;
			terminal.imageProtocol = ImageProtocol.Sixel;
			try {
				sameRows(viewResult(settled, { command: "sixelplot" }), oracleResult(settled, { command: "sixelplot" }));
			} finally {
				terminal.imageProtocol = originalProtocol;
			}
		});
	});

	describe("a failed result", () => {
		it("is headed by the word main headed it with", () => {
			const failed = result("boom", { exitCode: 1, wallTimeMs: 20 }, true);
			expect(viewResult(failed, { command: "false" })).toEqual(oracleResult(failed, { command: "false" }));
		});

		it("keeps the word with every escape stripped, which is the reason it exists", () => {
			const failed = result("boom", { exitCode: 1 }, true);
			expect(plain(viewResult(failed, { command: "false" })).join("\n")).toContain("failed");
		});
	});

	describe("a card that is still arriving", () => {
		it("draws the same rows as main once the clock is out of the comparison", () => {
			const originalTrueColor = TERMINAL.trueColor;
			terminal.trueColor = false;
			try {
				const streaming = result("first\nsecond\nthird");
				const view = viewResult(streaming, { command: COMMAND }, { partial: true });
				const oracle = oracleResult(streaming, { command: COMMAND }, { partial: true });
				sameRows(view, oracle);
			} finally {
				terminal.trueColor = originalTrueColor;
			}
		});
	});

	describe("the windows both arms measure", () => {
		it("cuts a long command to the same rows and the same note", () => {
			const total = previewWindowRows() + 5;
			const command = Array.from({ length: total }, (_, i) => `echo step_${i}`).join("\n");
			const settled = result("done");
			const view = viewResult(settled, { command });
			const oracle = oracleResult(settled, { command });
			expect(view).toEqual(oracle);
			const rendered = plain(view).join("\n");
			expect(rendered).toContain(`echo step_${total - 1}`);
			expect(rendered).not.toContain("echo step_0");
			expect(rendered).toContain(`… ${total - previewWindowRows() + 1} earlier lines`);
		});

		it("keeps the newest output rows main kept, one fewer for the note in the window", () => {
			const total = BASH_DEFAULT_PREVIEW_LINES + 6;
			const output = Array.from({ length: total }, (_, i) => `row ${i}`).join("\n");
			const settled = result(output, { wallTimeMs: 100 });
			// The rows each arm kept, read back rather than recomputed: the window is measured in
			// wrapped rows, so a count derived here would assert the arithmetic twice instead of
			// asserting what the two arms drew.
			const kept = (rendered: readonly string[]): number[] =>
				rendered.flatMap(line => {
					const match = /\brow (\d+)\b/.exec(line);
					return match === null ? [] : [Number(match[1])];
				});
			const view = plain(viewResult(settled, { command: COMMAND }));
			const oracle = plain(oracleResult(settled, { command: COMMAND }));
			const shown = kept(view);
			const mainShown = kept(oracle);
			expect(shown.length).toBeGreaterThan(0);
			expect(shown[shown.length - 1]).toBe(total - 1);
			// THE EXCEPTION: the host's note is one of the rows the window may spend, so the view keeps
			// one row fewer and keeps the newest of the rows main kept. Main pushed its note above the
			// window it had already measured, which is how a card with a ten-row bound drew eleven.
			expect(mainShown.length).toBe(shown.length + 1);
			expect(shown).toEqual(mainShown.slice(1));
			expect(view.join("\n")).toContain(`… ${total - shown.length} earlier lines`);
			expect(oracle.join("\n")).toContain(`… (${total - mainShown.length} earlier lines, showing`);
		});

		it("differs from main by empty styling runs alone, which is what the comparison closes up", () => {
			const settled = result("alpha\nbeta", { wallTimeMs: 100 });
			const view = viewResult(settled, { command: COMMAND });
			const oracle = oracleResult(settled, { command: COMMAND });
			// The residue is real and is the reason `sameRows` exists: main opened and closed a colour
			// with no glyph in it on a windowed row, and the host does not. Byte equality fails, and
			// equality with the empty runs closed up holds.
			expect(view).not.toEqual(oracle);
			expect(oracle.some(line => /\u001b\[38;2;\d+;\d+;\d+m\u001b\[39m/.test(line))).toBe(true);
			expect(view.some(line => /\u001b\[38;2;\d+;\d+;\d+m\u001b\[39m/.test(line))).toBe(false);
			sameRows(view, oracle);
		});

		it("spends no more rows on output than the tool's bound", () => {
			const long = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
			const settled = result(long, { wallTimeMs: 100 });
			const rows = plain(viewResult(settled, { command: COMMAND })).filter(line => line.includes("row "));
			expect(rows.length).toBeLessThanOrEqual(Math.min(BASH_DEFAULT_PREVIEW_LINES, previewWindowRows()));
			expect(rows[rows.length - 1]).toContain("row 39");
		});
	});
});
