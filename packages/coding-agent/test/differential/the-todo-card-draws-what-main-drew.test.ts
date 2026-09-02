/**
 * The `todo` card draws what main's renderer drew, over the whole strike-through animation.
 *
 * THREE DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. A task row, whose mark and words are two spans a
 * host draws from its own tables, so the terminal restates the same colour on each where main painted
 * the row in one run. The collapsed row's separators, written into the run beside them rather than
 * each into a run of its own. And an empty board, which opens no zero-width colour run for a title
 * and an emblem it does not draw.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	TODO_STRIKE_HOLD_FRAMES,
	TODO_STRIKE_TOTAL_FRAMES,
	type TodoPhase,
	type TodoRenderArgs,
} from "@veyyon/coding-agent/tools/agent/todo";
import { type TodoViewResult, todoToolView } from "@veyyon/coding-agent/tools/agent/todo-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import { TODO_STATUSES } from "@veyyon/wire";
import * as todoOracle from "../oracles/todo-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

describe("todo tool differential", () => {
	const board: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [
				{
					name: "Foundation",
					tasks: [
						{ content: "scaffold the crate", status: "completed" },
						{ content: "wire the workspace", status: "in_progress" },
					],
				},
				{
					name: "Auth",
					tasks: [
						{ content: "port the credential store", status: "pending" },
						{ content: "drop the old flow", status: "abandoned" },
					],
				},
			],
			completedTasks: [{ phase: "Foundation", content: "scaffold the crate" }],
		},
	};
	const singlePhase: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [{ name: "Work", tasks: [{ content: "one task", status: "pending" }] }],
		},
	};
	const finished: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [{ name: "Work", tasks: [{ content: "one task", status: "completed" }] }],
		},
	};
	const emptyBoard: TodoViewResult = {
		content: [{ type: "text", text: "No todos" }],
		details: { storage: "session", phases: [] },
	};
	const failed: TodoViewResult = { content: [{ type: "text", text: "todo: unknown op" }], isError: true };

	/** Every board the card can be handed, named so a failing cell says which one broke. */
	const BOARDS: ReadonlyArray<readonly [string, TodoViewResult]> = [
		["four tasks over two phases", board],
		["one phase, which is not named", singlePhase],
		["a board with nothing open", finished],
		["a board with no tasks at all", emptyBoard],
		["a write that failed", failed],
	];

	function oracleLines(result: TodoViewResult, options: RenderResultOptions, width = WIDTH): string[] {
		// Main's renderer declared `content` required and a view declares it optional, which is the
		// tool's own shape: the board comes from `details`, and the text is only the failure message.
		const forOracle = { ...result, content: result.content ?? [] };
		return renderCompLines(todoOracle.todoToolRenderer.renderResult(forOracle, options, theme), width);
	}

	function viewLines(result: TodoViewResult, context: ToolViewContext, width = WIDTH): string[] {
		return renderCompLines(drawToolView(todoToolView.renderResult(result, context), theme, context.frame), width);
	}

	/** The rows with every escape stripped, which leaves the run boundaries out of the comparison. */
	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	/**
	 * Every attribute the card is painted with, once each.
	 *
	 * The arms differ in where a run starts and stops and nowhere else, so the SET of attributes the
	 * card carries is the part of the styling that is still a claim: a task drawn in the wrong colour,
	 * or with the strike dropped, changes it, while restating a colour on a second span does not.
	 *
	 * Read over the card rather than row by row, because which row a separator's dim run lands on is
	 * one of the run-boundary differences: at twelve columns the collapsed row wraps, and main's
	 * separator run wraps with it while the host's separator travels inside the run beside it.
	 */
	function attributes(lines: readonly string[]): string[] {
		return [...new Set(lines.flatMap(line => line.match(/\x1b\[[\d;]*m/gu) ?? []))].sort();
	}

	/** How many characters of a row the strike covers, read off the SGR 9 runs the row carries. */
	function struckChars(line: string): number {
		let total = 0;
		for (const run of line.matchAll(/\x1b\[9m(.*?)\x1b\[29m/gu)) {
			total += [...stripVTControlCharacters(run[1] ?? "")].length;
		}
		return total;
	}

	it("draws the pending call row the renderer drew, byte for byte, at every width", () => {
		const calls: TodoRenderArgs[] = [
			{} as TodoRenderArgs,
			{ op: "init", items: ["a", "b"] } as TodoRenderArgs,
			{ op: "done", task: "scaffold the crate" } as TodoRenderArgs,
			{ op: "append", phase: "Auth", items: ["x"] } as TodoRenderArgs,
			// The two malformed deltas of #2005: a non-string op, and a legacy batch cut mid-JSON.
			{ op: 1 } as unknown as TodoRenderArgs,
			{ ops: '[{"op":"init"' } as unknown as TodoRenderArgs,
		];
		for (const args of calls) {
			for (const frame of [undefined, 3]) {
				for (const width of [WIDTH, 40]) {
					const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: frame };
					const drawn = renderCompLines(
						drawToolView(todoToolView.renderCall(args, { expanded: false, partial: true, frame }), theme, frame),
						width,
					);
					expect(drawn).toEqual(
						renderCompLines(todoOracle.todoToolRenderer.renderCall(args, options, theme), width),
					);
				}
			}
		}
		// Anti-vacuity: the row names the tool and the operation it is carrying.
		const row = unstyled(
			renderCompLines(
				drawToolView(
					todoToolView.renderCall({ op: "done", task: "scaffold the crate" } as TodoRenderArgs, {
						expanded: false,
						partial: true,
					}),
					theme,
				),
			),
		).join("\n");
		expect(row).toContain("Todo");
		expect(row).toContain("done");
		expect(row).toContain("scaffold the crate");
	});

	it("draws every board the renderer drew, at every width, disclosure and frame", () => {
		for (const [name, result] of BOARDS) {
			for (const expanded of [false, true]) {
				for (const partial of [false, true]) {
					for (const frame of [undefined, 1, 4, TODO_STRIKE_TOTAL_FRAMES + 8]) {
						for (const width of [WIDTH, 40, 12]) {
							const context: ToolViewContext = { expanded, partial, frame };
							const options: RenderResultOptions = { expanded, isPartial: partial, spinnerFrame: frame };
							const drawn = viewLines(result, context, width);
							const oracle = oracleLines(result, options, width);
							expect({ name, rows: unstyled(drawn) }).toEqual({ name, rows: unstyled(oracle) });
							expect({ name, paint: attributes(drawn) }).toEqual({ name, paint: attributes(oracle) });
						}
					}
				}
			}
		}
		// Anti-vacuity: an opened board is the phases, their tasks and the state marks, not an empty frame.
		const opened = unstyled(viewLines(board, { expanded: true, partial: false })).join("\n");
		expect(opened).toContain("Foundation");
		expect(opened).toContain("Auth");
		expect(opened).toContain("scaffold the crate");
		expect(opened).toContain("drop the old flow");
		expect(opened).toContain(theme.checkbox.progress);
	});

	it("draws the failed write byte for byte, plate and all", () => {
		for (const width of [WIDTH, 40, 12]) {
			expect(viewLines(failed, { expanded: false, partial: false }, width)).toEqual(
				oracleLines(failed, HOST_COLLAPSED, width),
			);
		}
		expect(unstyled(viewLines(failed, { expanded: false, partial: false })).join("\n")).toContain("todo: unknown op");
	});

	it("sweeps the completion strike the renderer swept, and settles where it settled", () => {
		const taskRow = (rows: readonly string[]): string => rows.find(row => row.includes("scaffold the crate")) ?? "";
		const covered = (frame: number | undefined): { view: number; oracle: number } => ({
			view: struckChars(taskRow(viewLines(board, { expanded: true, partial: false, frame }))),
			oracle: struckChars(taskRow(oracleLines(board, { expanded: true, isPartial: false, spinnerFrame: frame }))),
		});
		const full = [..."scaffold the crate"].length;
		// The hold: the sweep has not started, so the words are struck nowhere yet.
		expect(covered(TODO_STRIKE_HOLD_FRAMES)).toEqual({ view: 0, oracle: 0 });
		// The sweep advances one arm exactly as far as the other, frame by frame.
		let previous = 0;
		for (let frame = TODO_STRIKE_HOLD_FRAMES + 1; frame <= TODO_STRIKE_TOTAL_FRAMES; frame++) {
			const { view, oracle } = covered(frame);
			expect(view).toBe(oracle);
			expect(view).toBeGreaterThanOrEqual(previous);
			previous = view;
		}
		// It terminates: the last frame of the window is the whole task, and a surface that keeps
		// counting past the window stays there rather than wrapping back to the start of the sweep.
		expect(previous).toBe(full);
		expect(covered(TODO_STRIKE_TOTAL_FRAMES + 40)).toEqual({ view: full, oracle: full });
		// A task closed before this card was drawn carries no frame and is struck end to end.
		expect(covered(undefined)).toEqual({ view: full, oracle: full });
		// A task this write did not close is never swept, whatever frame the surface is on.
		const abandoned = (frame: number): number =>
			struckChars(
				viewLines(board, { expanded: true, partial: false, frame }).find(row =>
					row.includes("drop the old flow"),
				) ?? "",
			);
		expect(abandoned(TODO_STRIKE_HOLD_FRAMES + 1)).toBe([..."drop the old flow"].length);
	});

	it("marks every status in the vocabulary the way the renderer marked it, and an unknown one as open", () => {
		// The board keeps a pending task beside the one under test so it stays open: a board whose
		// every task has closed collapses to the done line and has no task row left to read.
		const boardWith = (status: string): TodoViewResult => ({
			content: [{ type: "text", text: "board" }],
			details: {
				storage: "session",
				phases: [
					{
						name: "Work",
						tasks: [
							{ content: "the task", status: status as TodoPhase["tasks"][number]["status"] },
							{ content: "still open", status: "pending" },
						],
					},
				],
			},
		});
		const taskRow = (rows: readonly string[]): string => rows.find(row => row.includes("the task")) ?? "";
		const drawnRow = (status: string): string =>
			taskRow(viewLines(boardWith(status), { expanded: true, partial: false }));
		const oracleRow = (status: string): string => taskRow(oracleLines(boardWith(status), HOST_EXPANDED));

		// Swept from the vocabulary the wire package owns, not from a list written here, and pinned by
		// exact equality: a status added to it arrives with no mark of its own and reds this until one
		// is recorded.
		const marks: Record<string, string> = {};
		for (const status of TODO_STATUSES) {
			const drawn = stripVTControlCharacters(drawnRow(status)).trimEnd();
			expect({ status, row: drawn }).toEqual({
				status,
				row: stripVTControlCharacters(oracleRow(status)).trimEnd(),
			});
			marks[status] = drawn.slice(drawn.indexOf("the task") - 2, drawn.indexOf("the task") - 1);
		}
		expect(marks).toEqual({
			pending: theme.checkbox.unchecked,
			in_progress: theme.checkbox.progress,
			completed: theme.checkbox.checked,
			abandoned: theme.checkbox.unchecked,
		});

		// A status this build has no case for is open work, so it is marked and toned as open and never
		// struck. The last three are keys a record lookup answers off `Object.prototype`, which is how a
		// mark table hands back a function where a glyph was expected.
		for (const foreign of ["cancelled", "blocked", "toString", "constructor", "__proto__"]) {
			const drawn = drawnRow(foreign);
			expect(stripVTControlCharacters(drawn).trimEnd()).toBe(stripVTControlCharacters(oracleRow(foreign)).trimEnd());
			expect(stripVTControlCharacters(drawn)).toContain(`${theme.checkbox.unchecked} the task`);
			expect(struckChars(drawn)).toBe(0);
			expect(attributes([drawn])).toEqual(attributes([oracleRow(foreign)]));
		}
	});
	it("exception cell: a task row states its colour once per span, where main stated it once per row", () => {
		const rowOf = (rows: readonly string[]): string => rows.find(row => row.includes("wire the workspace")) ?? "";
		const drawn = rowOf(viewLines(board, { expanded: true, partial: false }));
		const oracle = rowOf(oracleLines(board, HOST_EXPANDED));
		const accent = theme.fg("accent", "x").replace("x", "").replace("\x1b[39m", "");
		// Main coloured the mark, the gap and the words as one run. A view names the mark and the
		// words as two spans, because a host that is not a terminal draws the mark from its own table,
		// so the terminal restates the same colour on each. Same glyph, same colour, same words.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(oracle.split(accent).length - 1).toBe(1);
		expect(drawn.split(accent).length - 1).toBe(2);
		expect(drawn).toContain(theme.checkbox.progress);
	});

	it("exception cell: the collapsed row's separators sit in the run beside them, not in one of their own", () => {
		const drawn = viewLines(board, { expanded: false, partial: false })[0] ?? "";
		const oracle = oracleLines(board, HOST_COLLAPSED)[0] ?? "";
		const dim = theme.fg("dim", "x").replace("x", "").replace("\x1b[39m", "");
		// Both rows read the same. Main drew each separator dot as its own dim run around each
		// metadatum; the host writes the dots into the run it is already drawing, so the row carries
		// fewer runs for the same bytes on screen.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(drawn.split(dim).length).toBeLessThan(oracle.split(dim).length);
		expect(stripVTControlCharacters(drawn)).toContain("4 tasks · 1 done · Foundation");
	});

	it("exception cell: a board with no tasks opens no empty colour runs", () => {
		const bodyRow = (rows: readonly string[]): string => rows.find(row => row.includes("No todos")) ?? "";
		const drawn = bodyRow(viewLines(emptyBoard, { expanded: true, partial: false }));
		const oracle = bodyRow(oracleLines(emptyBoard, HOST_EXPANDED));
		// Main's status line opened and closed a colour for a title it had already drawn and for an
		// emblem this card does not carry, leaving two zero-width runs before the text. The host emits
		// a run only for a span that has something in it.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(/\x1b\[[\d;]+m\x1b\[39m/u.test(oracle)).toBe(true);
		expect(/\x1b\[[\d;]+m\x1b\[39m/u.test(drawn)).toBe(false);
		expect(stripVTControlCharacters(drawn)).toContain("No todos");
	});
});
