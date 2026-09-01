/**
 * The `eval` card draws what main's renderer drew, for every cell state and every window.
 *
 * The code rows, the output rows, the collapsed helper-call tree, the document a cell displayed and
 * the widths each is cut to are compared as terminal bytes. THIRTEEN DIFFERENCES ARE PINNED AS
 * EXCEPTION CELLS rather than waived silently, and the first two are the shape change this conversion
 * makes:
 *
 *  - A CALL IS ONE CARD. Each cell is a labelled group inside it, where main drew every cell as a
 *    railed box of its own with a blank row between boxes. A view is one card; the rows inside the
 *    groups are the same bytes, which the cell below proves by dropping main's per-cell head rows.
 *  - The head row is titled. A settled untitled cell reads `Code`, where main drew the state glyph
 *    alone -- its title fell back to `Code` only when it had no glyph either -- and an unsettled cell
 *    reads its title where main wrote the WORD `pending` or `running` after the glyph. A card's title
 *    is required of a view, and a row of two glyphs names nothing to a reader.
 *  - The duration follows the title after a space, where the block put its own `·` between the header
 *    and its meta.
 *  - A spawned subagent is a group INSIDE the card, where main drew a tree below the box. The rows
 *    carry the same facts, each opening with its own state mark instead of a dim branch glyph.
 *  - A collapsed output window states what it dropped on TOP and spends a row of the window on the
 *    note, where main showed one more row of output and wrote `… N more lines` under it. The host cuts
 *    the window, so the note is the host's, and both arms keep the newest rows.
 *  - A window note names the gesture that uncaps it (`▸ Ctrl+O expand`) even on the expanded arm,
 *    where main appended the hint only while collapsed.
 *  - An expanded helper call is plain rows with its detail two columns in, where main drew a tree with
 *    a continuation prefix per row. A list states one line per item, and an expanded event is several.
 *  - What a call displayed is stated as rows carrying a kind mark, where main drew a nested block with
 *    a tree branch per node and wrapped the notice in `⟦…⟧`. Brackets and branches are host chrome.
 *  - A result with no cell is a headed block: its body sits two columns in and its status rows carry
 *    no tree, where main built one `Text` starting with a blank row in column zero.
 *  - A card that is still arriving carries the host's `… (streaming)` row, which main had nowhere: the
 *    host moves the animation off the head row so a live preview cannot pin the scrollback boundary.
 *  - The rail is quieted, as every converted panel's is: the host frames a card with a muted edge
 *    where main coloured the rail by the cell's state. Kept out of the row comparisons through
 *    `sameRailColour` and asserted on its own, so a real regression in the rows is not buried under a
 *    colour that was changed deliberately.
 *  - A cell whose output is a document keeps the document theme's own colours, where main toned every
 *    row the document left unstyled with the output colour. The rows carry the same words at the same
 *    width, and the heading main styled itself is the same bytes in both arms.
 *  - The row that opens a helper log is a section label in the tool-title colour, where main wrote a
 *    dim `Status` divider inside the output. It is the colour the host gives every section label,
 *    including the `Output` label main drew through the same block.
 *  - Output that rewrote its own row with a carriage return shows the row's last text, where main drew
 *    every draft of it as a row of its own.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never runs a kernel, so nothing here proves which backend a call
 * resolved to or what a cell printed; `test/an-eval-card-states-code-and-output.test.ts` owns what the
 * card claims and `eval.ts` owns what it ran. The dark preset draws no glyph for any of the four
 * backends, so the language badge is empty in both arms -- asserted below, rather than assumed, since
 * a preset that grows one would place it differently in each. `renderContext.timeout` reached main's
 * renderer from nowhere (only `bash` was given one), so the timeout row it could draw is not compared.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { EvalCellResult, EvalStatusEvent, EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { type EvalRenderArgs, evalToolView, type EvalViewResult } from "@veyyon/coding-agent/tools/shell/eval-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as evalOracle from "../oracles/eval-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

describe("eval tool differential", () => {
	const WIDE = 200;
	const WIDTHS = [WIDE, WIDTH, 40] as const;

	const cell = (overrides: Partial<EvalCellResult> = {}): EvalCellResult => ({
		index: 0,
		code: "print('hi')",
		language: "python",
		output: "hi",
		status: "complete",
		durationMs: 1200,
		...overrides,
	});

	const result = (details: EvalToolDetails | undefined, text = ""): EvalViewResult => ({
		content: [{ type: "text", text }],
		details,
	});

	function viewLines(
		value: EvalViewResult,
		context: ToolViewContext,
		width = WIDE,
		args?: EvalRenderArgs,
	): string[] {
		return renderCompLines(drawToolView(evalToolView.renderResult(value, context, args), theme, context.frame), width);
	}

	function oracleLines(
		value: EvalViewResult,
		options: RenderResultOptions,
		width = WIDE,
		args?: EvalRenderArgs,
	): string[] {
		return renderCompLines(
			evalOracle.evalToolRenderer.renderResult(
				value as { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails },
				options,
				theme,
				args,
			),
			width,
		);
	}

	function viewCallLines(args: EvalRenderArgs, context: ToolViewContext, width = WIDE): string[] {
		return renderCompLines(drawToolView(evalToolView.renderCall(args, context), theme, context.frame), width);
	}

	function oracleCallLines(args: EvalRenderArgs, options: RenderResultOptions, width = WIDE): string[] {
		return renderCompLines(evalOracle.evalToolRenderer.renderCall(args, options, theme), width);
	}

	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	/**
	 * A card with the block's own right-hand padding removed.
	 *
	 * The two arms' head rows differ in width by the title the view states, and the block pads every
	 * other row out to its longest one. The padding sits between the content and the background reset,
	 * so `trimEnd` never reaches it, and it is the host's layout rather than either renderer's bytes.
	 */
	function fitted(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +(\x1b\[49m)$/, "$1"));
	}

	/**
	 * Rows with the colour of the frame's rail dropped, so a comparison is about the card's content.
	 *
	 * The rail is the one thing a converted panel draws differently on purpose: every card the host
	 * frames from a view carries a muted rail, where main coloured it by the cell's state. Asserted on
	 * its own below rather than left in every row comparison.
	 */
	function sameRailColour(rows: readonly string[]): string[] {
		const rail = theme.symbol("block.rail");
		const pattern = new RegExp(`^(\\x1b\\[49m)?\\x1b\\[[0-9;:]*m${rail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
		return rows.map(row => row.replace(pattern, `$1${rail}`));
	}

	/** What a row says, with the frame's rail and every colour off it. */
	function saying(line: string): string {
		return stripVTControlCharacters(line).replaceAll(theme.symbol("block.rail"), "").trim();
	}

	/**
	 * Rows with a colour run that wraps no text at all dropped.
	 *
	 * Main's collapse helper closed a run it had opened for a marker it did not draw, which leaves
	 * `ESC[38;…mESC[39m` in front of the row that follows a condensed one. Nothing is drawn from it and
	 * no terminal shows it, so it is off both arms rather than pinned as a difference.
	 */
	function withoutEmptyRuns(rows: readonly string[]): string[] {
		return rows.map(row => row.replace(/\x1b\[[0-9;:]*m\x1b\[39m/g, ""));
	}

	/** The card past its head row, which is the one row every arm below differs on. */
	function body(lines: readonly string[]): string[] {
		return withoutEmptyRuns(sameRailColour(fitted(lines.slice(1))));
	}

	const COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const EXPANDED_CTX: ToolViewContext = { expanded: true, partial: false };
	const HOST_COLLAPSED_OPTS: RenderResultOptions = { expanded: false, isPartial: false };
	const HOST_EXPANDED_OPTS: RenderResultOptions = { expanded: true, isPartial: false };

	const HELPERS: EvalStatusEvent[] = [
		{ op: "read", chars: 120, path: "/repo/src/app.ts" },
		{ op: "git_status", clean: false, staged: 1, modified: 2, branch: "main" },
		{ op: "log", message: "phase two" },
	];

	/** Every arm whose body is drawn identically by both renderers. */
	const SETTLED: Array<{ label: string; details: EvalToolDetails; collapsedOnly?: boolean }> = [
		{ label: "a settled cell", details: { cells: [cell()] } },
		{ label: "a titled cell", details: { cells: [cell({ title: "imports" })] } },
		{ label: "a cell that failed", details: { cells: [cell({ status: "error", output: "Traceback: boom" })] } },
		{ label: "a cell with nothing to show", details: { cells: [cell({ output: "" })] } },
		{ label: "a pending cell", details: { cells: [cell({ status: "pending", output: "", durationMs: undefined })] } },
		// Expanded, main drew its helper log as a tree, which is its own exception cell below.
		{ label: "a cell whose helpers ran", details: { cells: [cell({ statusEvents: HELPERS })] }, collapsedOnly: true },
		{
			label: "a cell whose source carries tabs",
			details: { cells: [cell({ code: "if x:\n\tpass", output: "done" })] },
		},
		{
			label: "a cell whose progress lines condense",
			details: {
				cells: [
					cell({
						output: [
							...Array.from({ length: 12 }, (_unused, index) => `Compiling crate_${index} v0.1.0`),
							"warning: unused variable `x`",
						].join("\n"),
					}),
				],
			},
		},
	];

	it("draws every settled cell's body byte for byte, at every width and disclosure", () => {
		for (const arm of SETTLED) {
			for (const [context, options] of (
				[
					[COLLAPSED, HOST_COLLAPSED_OPTS],
					[EXPANDED_CTX, HOST_EXPANDED_OPTS],
				] as const
			).filter(([context]) => !(arm.collapsedOnly === true && context.expanded))) {
				for (const width of WIDTHS) {
					const drawn = body(viewLines(result(arm.details), context, width));
					const oracle = body(oracleLines(result(arm.details), options, width));
					// One row stands outside this comparison and is pinned in its own cell below: the row
					// that opens the helper log, which the host draws as a section label where main wrote a
					// dim divider inside the output. Every other row of both arms is compared byte for byte.
					const same = drawn.filter(line => saying(line) !== "Status");
					const mainRows = oracle.filter(line => saying(line) !== "Status");
					expect({ arm: arm.label, width, expanded: context.expanded, rows: same }).toEqual({
						arm: arm.label,
						width,
						expanded: context.expanded,
						rows: mainRows,
					});
				}
			}
		}
		// Anti-vacuity: the compared rows really are the source, the output and the helper tree.
		const rows = unstyled(viewLines(result({ cells: [cell({ statusEvents: HELPERS })] }), COLLAPSED));
		expect(rows[1]).toContain("print('hi')");
		expect(rows[3]).toContain("hi");
		expect(rows.join("\n")).toContain("├─");
		expect(rows.join("\n")).toContain("2 modified");
	});

	it("draws the pending preview's code rows byte for byte, at every width", () => {
		const args: EvalRenderArgs = { language: "py", code: "print('hi')\nprint('there')" };
		for (const width of WIDTHS) {
			for (const [context, options] of [
				[COLLAPSED, { expanded: false, isPartial: true } as RenderResultOptions],
				[EXPANDED_CTX, { expanded: true, isPartial: true } as RenderResultOptions],
			] as const) {
				expect(body(viewCallLines(args, context, width))).toEqual(body(oracleCallLines(args, options, width)));
			}
		}
	});

	it("draws the language badge neither arm's preset has, so the badge is not what the head rows differ on", () => {
		// Both arms ask the theme for the language's glyph, by different names. The dark preset has none
		// for any eval backend, so the two head rows differ in words and not in a lost badge -- and a
		// preset that grew one would fail the exception cell below rather than pass silently here.
		for (const language of ["python", "javascript", "ruby", "julia"]) {
			expect(theme.langBadge(language)).toBe("");
			expect(theme.getLangIconStyled(language)).toBe("");
		}
	});

	it("exception cell: the head row is titled, and its duration follows after a space", () => {
		const settled = result({ cells: [cell()] });
		const drawn = unstyled(viewLines(settled, COLLAPSED))[0] ?? "";
		const oracle = unstyled(oracleLines(settled, HOST_COLLAPSED_OPTS))[0] ?? "";
		// Main's row was the state glyph and the block's `·` separator before the duration: the title
		// fell back to `Code` only when the row had no glyph at all, which it always did have.
		expect(oracle).toContain("· (1.2s)");
		expect(oracle).not.toContain("Code");
		expect(drawn).toContain("Code (1.2s)");
		// Same glyph, same duration: the state and the fact are what a reader reads off the row.
		const glyph = oracle.slice(0, 3);
		expect(drawn.startsWith(glyph)).toBe(true);

		// A titled cell states the same title in both, and only the separator differs.
		const titled = result({ cells: [cell({ title: "imports" })] });
		expect(unstyled(oracleLines(titled, HOST_COLLAPSED_OPTS))[0]).toContain("imports · (1.2s)");
		expect(unstyled(viewLines(titled, COLLAPSED))[0]).toContain("imports (1.2s)");

		// An unsettled cell reads its title where main wrote the state as a word.
		const pending = result({ cells: [cell({ status: "pending", output: "", durationMs: undefined })] });
		expect(unstyled(oracleLines(pending, HOST_COLLAPSED_OPTS))[0]).toContain("pending");
		expect(unstyled(viewLines(pending, COLLAPSED))[0]).toContain("Code");
		expect(unstyled(viewLines(pending, COLLAPSED))[0]).not.toContain("pending");
	});

	it("exception cell: a call is one card whose cells are groups, and the rows inside them are main's", () => {
		const details: EvalToolDetails = {
			cells: [
				cell({ title: "imports" }),
				cell({ index: 1, title: "load", code: "cfg = load()", output: "ok" }),
			],
		};
		const drawn = unstyled(viewLines(result(details), COLLAPSED));
		const oracle = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		// One card: one head row naming how many cells ran, where main headed each box with the cell.
		expect(drawn[0]).toContain("2 cells");
		expect(drawn.filter(line => line.includes("(1.2s)"))).toHaveLength(0);
		expect(oracle.filter(line => line.includes("(1.2s)"))).toHaveLength(2);
		expect(oracle.filter(line => line === "")).toHaveLength(1);
		// Past the framing the rows are the same bytes in the same order: drop the view's head row and
		// its group labels, drop main's per-cell head rows and the blank row between boxes.
		const viewBody = drawn.slice(1).filter(line => !/\[\d\/2]/.test(line));
		const mainBody = oracle.filter(line => line !== "" && !line.includes("(1.2s)"));
		expect(viewBody).toEqual(mainBody);
		// The labels main drew in each box head are stated as the groups' own labels.
		expect(drawn.some(line => line.includes("[1/2] imports"))).toBe(true);
		expect(drawn.some(line => line.includes("[2/2] load"))).toBe(true);
	});

	it("exception cell: a subagent is a group inside the card, carrying the facts main drew below it", () => {
		const agent: EvalStatusEvent = {
			op: "agent",
			id: "AuthLoader",
			status: "running",
			currentTool: "read",
			lastIntent: "reading src/auth.ts",
			toolCount: 7,
			contextTokens: 47_000,
			contextWindow: 200_000,
			cost: 0.42,
		};
		const details: EvalToolDetails = { cells: [cell({ statusEvents: [agent] })] };
		const drawn = unstyled(viewLines(result(details), COLLAPSED));
		const oracle = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		// Main's agent rows hang below the box, in column zero and opened by a dim branch glyph.
		expect(oracle.some(line => line.startsWith("└─"))).toBe(true);
		expect(drawn.some(line => line.startsWith("└─"))).toBe(false);
		expect(drawn.some(line => line.includes("Agents"))).toBe(true);
		// Same facts either way, and the row still opens with the agent's own state mark.
		for (const fact of ["AuthLoader", "7", "47K/200K", "$0.42", "read: reading src/auth.ts"]) {
			expect(drawn.join("\n")).toContain(fact);
			expect(oracle.join("\n")).toContain(fact);
		}
	});

	it("exception cell: a collapsed output window states what it dropped on top, and spends a row on it", () => {
		const output = Array.from({ length: 30 }, (_unused, index) => `out ${index}`).join("\n");
		const details: EvalToolDetails = { cells: [cell({ output })] };
		const drawn = unstyled(viewLines(result(details), COLLAPSED));
		const oracle = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		// Both keep the newest rows and drop the front; the note's end of the window differs, and the
		// host's note costs one row of it.
		expect(drawn[3]).toContain("earlier lines");
		expect(drawn[3]).toContain("Ctrl+O expand");
		expect(drawn.at(-1)).toBe("▏  out 29");
		expect(oracle.at(-1)).toContain("more lines");
		expect(oracle.at(-2)).toBe("▏  out 29");
		expect(drawn.filter(line => /out \d+/.test(line))).toHaveLength(
			oracle.filter(line => /out \d+/.test(line)).length - 1,
		);
	});

	it("exception cell: a card's hidden note names the gesture that uncaps it, and costs a row of the window", () => {
		const details: EvalToolDetails = {
			cells: [cell({ code: Array.from({ length: 230 }, (_unused, i) => `x${i} = ${i}`).join("\n"), output: "" })],
		};
		const drawn = unstyled(viewLines(result(details), EXPANDED_CTX));
		const oracle = unstyled(oracleLines(result(details), HOST_EXPANDED_OPTS));
		expect(drawn.at(-1)).toContain("30 more lines");
		expect(drawn.at(-1)).toContain("Ctrl+O expand");
		expect(oracle.at(-1)).toContain("30 more lines");
		expect(oracle.at(-1)).not.toContain("Ctrl+O");

		// Collapsed, the source window is the same window on the same end of the file, and the host's
		// note is inside it: one source row fewer, ending on the row main ended on.
		const collapsed = unstyled(viewLines(result(details), COLLAPSED));
		const mainCollapsed = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		const sourceRows = (lines: readonly string[]): string[] => lines.filter(line => /x\d+ = \d+/.test(line));
		expect(sourceRows(collapsed).at(-1)).toBe(sourceRows(mainCollapsed).at(-1));
		expect(sourceRows(collapsed)).toHaveLength(sourceRows(mainCollapsed).length - 1);
		expect(sourceRows(collapsed)).toEqual(sourceRows(mainCollapsed).slice(1));
	});

	it("exception cell: an expanded helper call is plain rows where main drew a tree", () => {
		const details: EvalToolDetails = {
			cells: [
				cell({
					statusEvents: [
						{ op: "ls", count: 3, items: ["a.ts", "b.ts", "c.ts"] },
						{ op: "read", chars: 9, path: "/repo/a.ts", preview: "one\ntwo\nthree\nfour" },
					],
				}),
			],
		};
		const drawn = unstyled(viewLines(result(details), EXPANDED_CTX));
		const oracle = unstyled(oracleLines(result(details), HOST_EXPANDED_OPTS));
		expect(oracle.some(line => line.includes("├─"))).toBe(true);
		expect(oracle.some(line => line.includes("│"))).toBe(true);
		expect(drawn.some(line => line.includes("├─"))).toBe(false);
		// The same events, the same descriptions, the same detail rows and the same held-back count.
		for (const fact of ["ls 3 entries", "a.ts", "c.ts", "read 9 chars", "one", "three", "… 1 more line"]) {
			expect(drawn.join("\n")).toContain(fact);
			expect(oracle.join("\n")).toContain(fact);
		}
		// A COLLAPSED helper list is still main's tree, which the byte-for-byte cell above proves.
		expect(unstyled(viewLines(result({ cells: [cell({ statusEvents: HELPERS })] }), COLLAPSED)).join("\n")).toContain("├─");
		// The row that opens the log is a section label here, where main wrote a dim divider inside the
		// output. Same word, and the colour is the host's chrome rather than either renderer's choice.
		const collapsed = viewLines(result({ cells: [cell({ statusEvents: HELPERS })] }), COLLAPSED);
		const mainCollapsed = oracleLines(result({ cells: [cell({ statusEvents: HELPERS })] }), HOST_COLLAPSED_OPTS);
		const divider = (lines: readonly string[]): string | undefined =>
			sameRailColour(lines.filter(line => saying(line) === "Status"))[0];
		const label = (lines: readonly string[]): string | undefined =>
			sameRailColour(lines.filter(line => saying(line) === "Output"))[0];
		expect(divider(collapsed)).toBeDefined();
		expect(divider(mainCollapsed)).toContain(theme.getFgAnsi("dim"));
		expect(divider(collapsed)).not.toContain(theme.getFgAnsi("dim"));
		// It is the same colour the host gives every other section label, including main's own.
		expect(divider(collapsed)?.replace("Status", "Output")).toBe(label(collapsed));
		expect(label(collapsed)).toBe(label(mainCollapsed));
	});

	it("exception cell: output that rewrote its own row shows what a terminal would show", () => {
		const details: EvalToolDetails = { cells: [cell({ output: "10%\r50%\r100%" })] };
		const drawn = unstyled(viewLines(result(details), COLLAPSED));
		const oracle = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		// A carriage return rewrites the row it is on, so the card states the row's last text and main
		// stated every draft of it as a row of its own.
		expect(drawn.filter(line => /\d+%/.test(line)).map(saying)).toEqual(["100%"]);
		expect(oracle.filter(line => /\d+%/.test(line)).map(saying)).toEqual(["10%", "50%", "100%"]);
	});

	it("exception cell: what a call displayed is rows with a kind mark, and its notice is plain words", () => {
		const details: EvalToolDetails = {
			cells: [cell()],
			jsonOutputs: [{ ok: true }],
			notice: "python unavailable, ran on js",
		};
		const drawn = unstyled(viewLines(result(details), COLLAPSED));
		const oracle = unstyled(oracleLines(result(details), HOST_COLLAPSED_OPTS));
		// Main opened the display with a tree branch inside a second block and bracketed the notice.
		expect(oracle.some(line => line.includes("└─ ▤ ok: true"))).toBe(true);
		expect(oracle.some(line => line.includes("⟦python unavailable, ran on js⟧"))).toBe(true);
		expect(oracle.some(line => line === "")).toBe(true);
		// The view states the node with its kind mark and the notice as the words it is.
		expect(drawn.some(line => line.includes("▤ ok: true"))).toBe(true);
		expect(drawn.some(line => line.includes("└─"))).toBe(false);
		expect(drawn.some(line => line.endsWith("python unavailable, ran on js"))).toBe(true);
		expect(drawn.some(line => line.includes("⟦"))).toBe(false);
	});

	it("exception cell: a result with no cell is a headed block set two columns in", () => {
		const value = result({ statusEvents: [{ op: "log", message: "kernel down" }] }, "eval failed to start\nsecond line");
		const drawn = unstyled(viewLines(value, COLLAPSED));
		const oracle = unstyled(oracleLines(value, HOST_COLLAPSED_OPTS));
		// Main built one `Text` whose first row was blank and whose rows sat in column zero, and drew
		// the status events as a tree.
		expect(oracle[0]).toBe("");
		expect(oracle.some(line => line.startsWith("└─"))).toBe(true);
		expect(drawn[0]).toBe("  eval failed to start");
		expect(drawn.some(line => line.startsWith("└─"))).toBe(false);
		// Same words, in the same order, once the indent and the tree glyphs are set aside.
		const words = (lines: readonly string[]): string[] =>
			lines.map(line => line.replace(/^[\s│]*(?:[├└]─)?\s*/, "")).filter(line => line !== "");
		expect(words(drawn)).toEqual(words(oracle));
	});

	it("exception cell: a card that is still arriving carries the host's streaming row", () => {
		const details: EvalToolDetails = { cells: [cell({ status: "running", output: "partial", durationMs: undefined })] };
		const context: ToolViewContext = { expanded: false, partial: true, frame: 2 };
		const drawn = unstyled(viewLines(result(details), context));
		const oracle = unstyled(oracleLines(result(details), { expanded: false, isPartial: true, spinnerFrame: 2 }));
		expect(drawn.at(-1)).toContain("… (streaming)");
		expect(oracle.some(line => line.includes("(streaming)"))).toBe(false);
		// Everything before it is main's card, and both head rows still animate the same glyph.
		expect(body(viewLines(result(details), context)).slice(0, -1)).toEqual(
			body(oracleLines(result(details), { expanded: false, isPartial: true, spinnerFrame: 2 })),
		);
		expect(drawn[0]?.slice(0, 3)).toBe(oracle[0]?.slice(0, 3));
	});

	it("exception cell: a call with no code yet carries the pending mark before the prompt", () => {
		const drawn = unstyled(viewCallLines({}, COLLAPSED));
		const oracle = unstyled(oracleCallLines({}, { expanded: false, isPartial: true }));
		expect(oracle[0]).toBe(">>> …");
		expect(drawn[0]).toContain(">>> …");
		expect(drawn[0]).not.toBe(">>> …");
	});

	it("exception cell: the card's rail is quiet unless the run failed, where main's tracked every state", () => {
		const rail = theme.symbol("block.rail");
		const railColour = (lines: readonly string[]): string | undefined =>
			lines
				.slice(1)
				.map(line => new RegExp(`(\\x1b\\[[0-9;:]*m)${rail}`).exec(line)?.[1])
				.find(colour => colour !== undefined);
		const arm = (status: EvalCellResult["status"]): EvalViewResult =>
			result({ cells: [cell({ status, ...(status === "complete" ? {} : { output: "", durationMs: undefined }) })] });
		const context: ToolViewContext = { expanded: false, partial: false, frame: 1 };
		const options: RenderResultOptions = { expanded: false, isPartial: false, spinnerFrame: 1 };

		// Settled, waiting and arriving are one edge for the host, and each was its own colour for main.
		const quiet = ["complete", "pending", "running"].map(status =>
			railColour(viewLines(arm(status as EvalCellResult["status"]), context)),
		);
		expect(quiet[0]).toBeDefined();
		expect(new Set(quiet).size).toBe(1);
		const mainRails = ["complete", "pending", "running"].map(status =>
			railColour(oracleLines(arm(status as EvalCellResult["status"]), options)),
		);
		expect(mainRails.every(colour => colour !== undefined && colour !== quiet[0])).toBe(true);
		expect(new Set(mainRails).size).toBe(2);

		// A failure is the one outcome the edge still carries, and there both arms agree.
		const failed = result({ cells: [cell({ status: "error", output: "Traceback: boom" })] });
		expect(railColour(viewLines(failed, context))).toBe(railColour(oracleLines(failed, options)));
	});

	it("exception cell: a document keeps its own colours where main toned every unstyled row", () => {
		const details: EvalToolDetails = { cells: [cell({ output: "# Title\n\nbody text", hasMarkdown: true })] };
		const drawn = viewLines(result(details), COLLAPSED);
		const oracle = oracleLines(result(details), HOST_COLLAPSED_OPTS);
		// Same document, laid out identically: the words and their order are the card's, past the head row.
		expect(unstyled(drawn.slice(1))).toEqual(unstyled(oracle.slice(1)));
		// The heading is the one row the document styles itself, and it is the same bytes in both arms
		// once the block's own right-hand padding is set aside.
		const row = (lines: readonly string[], word: string): string | undefined =>
			sameRailColour(fitted(lines.filter(line => line.includes(word))))[0];
		expect(row(drawn, "Title")).toBe(row(oracle, "Title"));
		// Main coloured the rows the document left unstyled, so its body row carries an output colour the
		// view's does not. The heading is why the view leaves the document alone: a ground under the
		// document's own styling wins over it, and main's own heading colour would be the row that lost.
		const bodyRow = (lines: readonly string[]): string | undefined => lines.find(line => line.includes("body text"));
		expect(unstyled([bodyRow(oracle) ?? ""])).toEqual(unstyled([bodyRow(drawn) ?? ""]));
		expect(bodyRow(oracle)).toContain(theme.getFgAnsi("toolOutput"));
		expect(bodyRow(drawn)).not.toContain(theme.getFgAnsi("toolOutput"));
	});
});
