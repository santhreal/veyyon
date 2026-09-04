/**
 * The `launch` card draws what main's renderer drew, for every operation and for a captured screen.
 *
 * FOUR DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. A headed block, which sets its body two columns
 * in where main built the card as one `Text` of pre-coloured strings and left a body row in column
 * zero, and whose head row the host cuts without an ellipsis where main spent a column on one. A
 * listing row, which stays dim after a toned fact: main coloured the whole facts run dim and wrote
 * the state colour inside it, and the inner run closes with `\x1b[39m`, which resets to the terminal's
 * default foreground rather than to the dim it was nested in, so every fact after the state drew in
 * the default colour. And the logs frame, which states the outcome on the rail and leaves the
 * process's own output on the terminal's ground where main filled every row with the outcome plate --
 * the same decision the `ssh` card records.
 *
 * ONE CLAIM IS THIS CARD'S ALONE. A captured PTY row is one row of a screen, so the frame cuts it
 * rather than wrapping it: wrapping turns one row into six and pushes the rest of the screen out of
 * the window. The cells sweep the frame down to a twenty-column terminal and assert the row count.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getStateBgColor } from "@veyyon/coding-agent/modes/terminal/draw/utils";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { LaunchRenderArgs, LaunchToolDetails } from "@veyyon/coding-agent/tools/shell/launch";
import { type LaunchViewResult, launchToolView } from "@veyyon/coding-agent/tools/shell/launch-view";
import { visibleWidth } from "@veyyon/utils/width";
import type { ToolViewContext } from "@veyyon/view";
import * as launchOracle from "../oracles/launch-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

describe("launch tool differential", () => {
	/**
	 * A process whose clock does not move between the two arms.
	 *
	 * The card states an uptime derived from `Date.now()`, and the two arms are rendered a few
	 * microseconds apart, so a daemon started a moment ago reads `22.6s` in one and `22.7s` in the
	 * other. `startedAt: 1_000` puts the start at the epoch, where `formatDuration` reports days and
	 * hours and the comparison is stable for an hour.
	 */
	const daemon = (overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot => ({
		name: "web",
		id: "d-1",
		state: "running",
		pid: 51234,
		createdAt: 0,
		startedAt: 1_000,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	});

	const CALL_COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const CALL_EXPANDED: ToolViewContext = { expanded: true, partial: false };
	const CALL_PARTIAL: ToolViewContext = { expanded: false, partial: true };
	const HOST_PARTIAL: RenderResultOptions = { expanded: false, isPartial: true };

	/**
	 * The width at which neither arm truncates anything.
	 *
	 * Every cut in this card is the host's or main's, and the two differ by one column: main reserved
	 * a column for the ellipsis it appended, and the host cuts a row it composed to fit without one.
	 * Comparing at a width nothing reaches keeps that difference in the one cell that pins it, instead
	 * of in every cell.
	 */
	const WIDE = 200;

	function oracleLines(
		result: LaunchViewResult,
		options: RenderResultOptions,
		args: LaunchRenderArgs,
		width = WIDE,
	): string[] {
		return renderCompLines(
			launchOracle.launchToolRenderer.renderResult(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: LaunchToolDetails;
					isError?: boolean;
				},
				options,
				theme,
				args,
			),
			width,
		);
	}

	function viewLines(
		result: LaunchViewResult,
		context: ToolViewContext,
		args: LaunchRenderArgs,
		width = WIDE,
	): string[] {
		return renderCompLines(drawToolView(launchToolView.renderResult(result, context, args), theme), width);
	}

	/** The rows with the two columns a headed block sets its body in removed, so the rest can be compared. */
	function outdented(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/^ {2}/, "").trimEnd());
	}

	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	const CALLS: LaunchRenderArgs[] = [
		{},
		{ op: "start" },
		// `application` arrives several deltas before `op`, which is the window a card keyed on the op
		// alone draws nothing for.
		{ application: "bun", args: ["run", "dev"] },
		{ op: "start", name: "web", application: "bun", args: ["run", "dev"], ready: { log: "ready", port: 5173 } },
		{ op: "logs", name: "web", follow: true, cursor: 12 },
		{ op: "send", name: "web", text: "hello", keys: ["ENTER"] },
		{ op: "list" },
		{ op: "wait", name: "web", pattern: "done", timeout: 5 },
		{ op: "start", name: "web", application: "col\tumn" },
	];

	const RESULTS: Array<{ label: string; result: LaunchViewResult; args: LaunchRenderArgs }> = [
		{
			label: "start, ready, with the log line that matched",
			args: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
			result: {
				content: [{ type: "text", text: "Started web" }],
				details: { op: "start", daemon: daemon({ state: "ready", readyMatch: "listening on 5173" }) },
			},
		},
		{
			label: "start whose readiness timed out",
			args: { op: "start", name: "web", ready: { log: "ready", port: 5173 } },
			result: {
				content: [{ type: "text", text: "Started web" }],
				details: {
					op: "start",
					timedOut: true,
					daemon: daemon({ state: "starting", readyPending: ["log", "port"] }),
				},
			},
		},
		{
			label: "start that failed with an exit reason",
			args: { op: "start", name: "web" },
			result: {
				content: [{ type: "text", text: "Failed to launch web" }],
				details: {
					op: "start",
					daemon: daemon({ state: "failed", exitCode: 127, exitedAt: 2_000, exitReason: "spawn ENOENT" }),
				},
			},
		},
		{
			label: "start with no structured detail",
			args: { op: "start", name: "web" },
			result: { content: [{ type: "text", text: "Started web\nsecond line" }], details: { op: "start" } },
		},
		{
			label: "stop",
			args: { op: "stop", name: "web" },
			result: {
				content: [{ type: "text", text: "Stopped web" }],
				details: { op: "stop", daemon: daemon({ state: "exited", exitedAt: 3_000, exitCode: 0 }) },
			},
		},
		{
			label: "restart, counted",
			args: { op: "restart", name: "web" },
			result: {
				content: [{ type: "text", text: "Restarted web" }],
				details: { op: "restart", daemon: daemon({ restartCount: 3, persist: true }) },
			},
		},
		{
			label: "send",
			args: { op: "send", name: "web", text: "hi" },
			result: { content: [{ type: "text", text: "Sent" }], details: { op: "send", daemon: daemon() } },
		},
		{
			label: "wait that timed out",
			args: { op: "wait", name: "web" },
			result: {
				content: [{ type: "text", text: "Wait timed out" }],
				details: { op: "wait", timedOut: true, daemon: daemon({ state: "starting", readyPending: ["port"] }) },
			},
		},
		{
			label: "wait that matched",
			args: { op: "wait", name: "web", pattern: "done" },
			result: {
				content: [{ type: "text", text: "Matched" }],
				details: { op: "wait", matched: "done", daemon: daemon() },
			},
		},
		{
			label: "list falling back to the text it sent",
			args: { op: "list" },
			result: { content: [{ type: "text", text: "no processes running" }], details: { op: "list" } },
		},
		{
			label: "describe with a spec",
			args: { op: "describe", name: "web" },
			result: {
				content: [{ type: "text", text: "spec" }],
				details: {
					op: "describe",
					daemon: daemon({ detached: true }),
					spec: {
						name: "web",
						env: {},
						application: "bun",
						args: ["run", "dev"],
						cwd: "/repo",
						pty: true,
						restart: "on-failure",
						persist: true,
						detached: false,
					},
				},
			},
		},
		{
			label: "describe with no spec",
			args: { op: "describe", name: "web" },
			result: { content: [{ type: "text", text: "no spec" }], details: { op: "describe", daemon: daemon() } },
		},
		{
			label: "a failure, over several lines",
			args: { op: "stop", name: "web" },
			result: { content: [{ type: "text", text: "no such process: web\nsecond\tline" }], isError: true },
		},
		{
			label: "an op the card has no branch for",
			args: {},
			result: { content: [{ type: "text", text: "something" }] },
		},
		{
			label: "a process ended by a signal",
			args: { op: "stop", name: "web" },
			result: {
				content: [{ type: "text", text: "Stopped web" }],
				details: {
					op: "stop",
					daemon: daemon({ state: "exited", exitedAt: 4_000, signal: "SIGTERM", terminatedBy: "operator-stop" }),
				},
			},
		},
	];

	it("draws the call row the renderer drew, at every width, frame and disclosure", () => {
		for (const args of CALLS) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
				[{ expanded: false, partial: false, frame: 2 } as ToolViewContext, { ...HOST_COLLAPSED, spinnerFrame: 2 }],
			] as const) {
				for (const width of [WIDE, WIDTH, 40]) {
					expect(
						renderCompLines(drawToolView(launchToolView.renderCall(args, context), theme, context.frame), width),
					).toEqual(renderCompLines(launchOracle.launchToolRenderer.renderCall(args, options, theme), width));
				}
			}
		}
		// Anti-vacuity: the row names the op, the process and the command the call asked to run. The
		// readiness conditions are not on it -- main's row states them nowhere either, which the matrix
		// above proves -- so a card that started drawing them fails there rather than here.
		const rows = unstyled(renderCompLines(drawToolView(launchToolView.renderCall(CALLS[3]!, CALL_COLLAPSED), theme)));
		expect(rows[0]).toContain("Launch start");
		expect(rows[0]).toContain("web");
		expect(rows[0]).toContain("bun run dev");
	});

	it("draws every settled op's row and body the renderer drew, byte for byte past the indent", () => {
		for (const cell of RESULTS) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
				[CALL_PARTIAL, HOST_PARTIAL],
			] as const) {
				expect(outdented(viewLines(cell.result, context, cell.args))).toEqual(
					outdented(oracleLines(cell.result, options, cell.args)),
				);
			}
		}
		// Anti-vacuity: the compared rows carry the op, the daemon's state and the body each op adds.
		const rows = unstyled(viewLines(RESULTS[0]!.result, CALL_COLLAPSED, RESULTS[0]!.args));
		expect(rows[0]).toContain("Launch start");
		expect(rows[0]).toContain("ready");
		expect(rows[1]).toContain("log matched: listening on 5173");
	});

	it("caps a collapsed listing and a failure where the renderer capped them, and names the unit", () => {
		const many: LaunchViewResult = {
			content: [{ type: "text", text: "" }],
			details: {
				op: "list",
				daemons: Array.from({ length: 11 }, (_, index) => daemon({ name: `svc-${index}`, id: `d-${index}` })),
			},
		};
		const wordy: LaunchViewResult = {
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n") }],
			isError: true,
		};
		for (const [result, args] of [
			[many, { op: "list" } as LaunchRenderArgs],
			[wordy, { op: "stop", name: "web" } as LaunchRenderArgs],
		] as const) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
			] as const) {
				expect(unstyled(outdented(viewLines(result, context, args)))).toEqual(
					unstyled(outdented(oracleLines(result, options, args))),
				);
			}
		}
		// Anti-vacuity: the collapsed arms really are capped, and the units are processes and lines.
		const listRows = unstyled(viewLines(many, CALL_COLLAPSED, { op: "list" }));
		expect(listRows).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(listRows.at(-1)).toContain("3 more processes");
		const errorRows = unstyled(viewLines(wordy, CALL_COLLAPSED, { op: "stop", name: "web" }));
		expect(errorRows.at(-1)).toContain(`${12 - PREVIEW_LIMITS.OUTPUT_COLLAPSED} more lines`);
	});

	it("exception cell: a headed block sets its body two columns in and cuts its head row without a mark", () => {
		const cell = RESULTS[0]!;
		const narrow = 40;
		const drawn = viewLines(cell.result, CALL_COLLAPSED, cell.args, narrow);
		const oracle = oracleLines(cell.result, HOST_COLLAPSED, cell.args, narrow);
		// Main built the card as one `Text` of pre-coloured strings, so a body row started in column
		// zero; the host indents a headed block's lines under the row that names them, as it does for
		// every other converted card. The two columns are the whole difference on that row.
		expect(drawn[1]).toBe(`  ${oracle[1]}`);
		// Main cut the head row with `truncateToWidth`'s default mark, which spends a column on the
		// ellipsis; the host composed the row to the width it was given and cuts it without one, so it
		// keeps the column and drops the mark.
		expect(unstyled(oracle)[0]!.endsWith("…")).toBe(true);
		expect(unstyled(drawn)[0]!.endsWith("…")).toBe(false);
		expect(visibleWidth(drawn[0]!)).toBe(narrow);
		expect(unstyled(oracle)[0]!.slice(0, -1)).toBe(unstyled(drawn)[0]!.slice(0, -1));
	});

	it("exception cell: a listing row stays dim after a toned fact, where main returned to the default", () => {
		const result: LaunchViewResult = {
			content: [{ type: "text", text: "" }],
			details: { op: "list", daemons: [daemon()] },
		};
		const drawn = viewLines(result, CALL_COLLAPSED, { op: "list" });
		const oracle = oracleLines(result, HOST_COLLAPSED, { op: "list" });
		// Main coloured the whole facts run dim and then wrote the state colour inside it. The inner
		// run closes with `\x1b[39m`, which resets to the terminal's DEFAULT foreground rather than to
		// the dim it was nested in, so every fact after the state drew in the default colour. The view
		// states one span per fact, so each carries its own tone and the run after the state stays dim.
		expect(oracle[1]).toContain(`${theme.fg("dim", "")[0]}`);
		expect(unstyled(oracle)[1]).toBe(unstyled(outdented(drawn))[1]);
		expect(drawn[1]).not.toBe(`  ${oracle[1]}`);
		expect(drawn[1]).toContain(theme.fg("success", "running"));
		expect(drawn[1]).toContain(theme.fg("dim", "pid 51234"));
		// Main's row has exactly one dim opener, before the state. The view's has one per quiet run, and
		// the count is pinned rather than bounded: three separators and the three facts they set apart
		// (`pid`, uptime, lifetime), so a separator or a fact that stops being quiet drops the count
		// instead of hiding behind a floor.
		const dimOpener = theme.fg("dim", "x").split("x")[0]!;
		expect(oracle[1]!.split(dimOpener)).toHaveLength(2);
		expect(drawn[1]!.split(dimOpener)).toHaveLength(7);
	});

	it("draws the logs frame the renderer drew, on the terminal's own ground", () => {
		const logs: Array<{ label: string; result: LaunchViewResult }> = [
			{
				label: "a pipe-backed process's lines",
				result: {
					content: [{ type: "text", text: "line one\nline two\n[web: running; cursor=42]" }],
					details: { op: "logs", state: "running", cursor: 42 },
				},
			},
			{
				label: "nothing written yet",
				result: {
					content: [{ type: "text", text: "[web: running; cursor=0]" }],
					details: { op: "logs", state: "running" },
				},
			},
			{
				label: "a follow that timed out",
				result: {
					content: [{ type: "text", text: "nothing\n[web: running; cursor=0]" }],
					details: { op: "logs", state: "running", timedOut: true, cursor: 0 },
				},
			},
			{
				label: "more lines than the window holds",
				result: {
					content: [
						{
							type: "text",
							text: `${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}\n[web: running; cursor=9]`,
						},
					],
					details: { op: "logs", state: "running", cursor: 9 },
				},
			},
			{
				label: "a captured screen",
				result: {
					content: [{ type: "text", text: "[web: running; cursor=42]" }],
					details: {
						op: "logs",
						state: "running",
						cursor: 42,
						terminalRows: ["\u001b[38;2;255;0;0mred row", "plain row", "", "tail"],
					},
				},
			},
			{
				label: "a captured screen taller than the window",
				result: {
					content: [{ type: "text", text: "[web: running; cursor=42]" }],
					details: {
						op: "logs",
						state: "running",
						cursor: 42,
						terminalRows: Array.from({ length: 40 }, (_, index) => `row ${index}`),
					},
				},
			},
		];
		const args: LaunchRenderArgs = { op: "logs", name: "web" };
		for (const cell of logs) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
				[CALL_PARTIAL, HOST_PARTIAL],
			] as const) {
				for (const width of [WIDE, WIDTH]) {
					expect(unstyled(viewLines(cell.result, context, args, width))).toEqual(
						unstyled(oracleLines(cell.result, options, args, width)),
					);
				}
			}
		}
		// Anti-vacuity: the frame carries the state, the cursor, the output label and the log itself.
		const rows = unstyled(viewLines(logs[0]!.result, CALL_COLLAPSED, args));
		expect(rows[0]).toContain("Launch logs");
		expect(rows[0]).toContain("cursor 42");
		expect(rows[1]).toContain("Output");
		expect(rows[2]).toContain("line one");
		// The model-facing status suffix is the model's, and never a row of the card.
		expect(rows.join("\n")).not.toContain("cursor=42");
		expect(unstyled(viewLines(logs[1]!.result, CALL_COLLAPSED, args)).at(-1)).toContain("(no output)");
	});

	it("exception cell: the logs frame leaves the process's output on the terminal's ground", () => {
		const result: LaunchViewResult = {
			content: [{ type: "text", text: "line one\n[web: running; cursor=1]" }],
			details: { op: "logs", state: "running", cursor: 1 },
		};
		const args: LaunchRenderArgs = { op: "logs", name: "web" };
		const drawn = viewLines(result, CALL_COLLAPSED, args, WIDTH);
		const oracle = oracleLines(result, HOST_COLLAPSED, args, WIDTH);
		// Main took `framedBlock`'s default, which fills every row of the block with the outcome plate
		// and pads it out to the width. The view states `contents: "data"`, because the body is the
		// process's own output rather than a report the card is making, so the outcome stays on the
		// rail and the rows keep the terminal's ground -- the same decision the ssh card records.
		expect(oracle[2]).toContain(theme.getBgAnsi(getStateBgColor("success")));
		expect(drawn[2]).not.toContain(theme.getBgAnsi(getStateBgColor("success")));
		expect(unstyled(oracle)).toEqual(unstyled(drawn));
	});

	it("replays a captured row's own colours and keeps nothing else the program wrote", () => {
		const rows = [
			"\u001b[38;2;255;0;0mred",
			"\u001b[38:2:0:255:0mgreen",
			"\u001b[1mbold\u001b[0mplain",
			"\u001b[2J\u001b[Hafter a clear",
			"\u001b[38;2;300;0;0mout of range",
		];
		const result: LaunchViewResult = {
			content: [{ type: "text", text: "[web: running; cursor=0]" }],
			details: { op: "logs", state: "running", terminalRows: rows },
		};
		const args: LaunchRenderArgs = { op: "logs", name: "web" };
		const drawn = viewLines(result, CALL_EXPANDED, args);
		const oracle = oracleLines(result, HOST_EXPANDED, args);
		// The rows themselves are compared with their styling, because the whole point of a captured
		// span is that the program's own colours reach the terminal. Two things about the block around
		// them differ and are pinned by the ground cell above: main plated every row, which is a
		// background set at the start and reset at the end of each, and padded it out to the width.
		// Both are stripped here so the comparison is of the bytes inside the row.
		const plate = theme.getBgAnsi(getStateBgColor("success"));
		const body = (lines: readonly string[]): string[] =>
			lines.slice(2).map(line =>
				line
					.replace(/^[^ ]* {3}/u, "")
					.replaceAll(plate, "")
					.replaceAll("\u001b[49m", "")
					.trimEnd(),
			);
		expect(body(drawn)).toEqual(body(oracle));
		// Both spellings of a truecolor sequence survive, an attribute survives, and a screen clear
		// and an out-of-range colour do not.
		const joined = drawn.join("\n");
		expect(joined).toContain("\u001b[38;2;255;0;0mred");
		expect(joined).toContain("\u001b[38:2:0:255:0mgreen");
		expect(joined).toContain("\u001b[1mbold");
		expect(joined).toContain("after a clear");
		expect(joined).not.toContain("\u001b[2J");
		expect(joined).not.toContain("\u001b[38;2;300;0;0m");
	});

	it("keeps a captured screen one row per row, however narrow the terminal", () => {
		const result: LaunchViewResult = {
			content: [{ type: "text", text: "[web: running; cursor=0]" }],
			details: {
				op: "logs",
				state: "running",
				terminalRows: ["short", `wide ${"x".repeat(200)}`, "short again"],
			},
		};
		const args: LaunchRenderArgs = { op: "logs", name: "web" };
		// A pty row is one row of a screen. Wrapping it turns one row into six and pushes the rest of
		// the screen out of the window, which is what a section windowed on WRAPPED rows did: the card
		// showed the tail of one long row and none of the rows around it.
		for (const width of [WIDTH, 40, 20]) {
			const drawn = unstyled(viewLines(result, CALL_COLLAPSED, args, width));
			expect(drawn).toEqual(unstyled(oracleLines(result, HOST_COLLAPSED, args, width)));
			// Head row, label, three screen rows: the long one is cut, never wrapped.
			expect(drawn).toHaveLength(5);
			expect(drawn.at(-1)).toContain("short again");
		}
	});
});
