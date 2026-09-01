/**
 * The `debug` card draws what main's renderer drew.
 *
 * TWO DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The result header, which colours the tool name and
 * sets the action off after it where main concatenated both untoned; and the held-back note, which
 * draws in the dim its own expand hint already used instead of a lighter muted.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { DapSessionSummary } from "@veyyon/coding-agent/debug/dap";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatExpandHint, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { DebugParams, DebugToolDetails } from "@veyyon/coding-agent/tools/shell/debug";
import { type DebugViewResult, debugToolView } from "@veyyon/coding-agent/tools/shell/debug-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as debugOracle from "../oracles/debug-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	renderCompLines,
	renderCompText,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("debug tool differential", () => {
	const snapshot: DapSessionSummary = {
		id: "dbg-1",
		adapter: "debugpy",
		cwd: "/repo",
		program: "scripts/job.py",
		status: "stopped",
		launchedAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-01T00:00:01.000Z",
		stopReason: "breakpoint",
		frameName: "main",
		source: { path: "/repo/scripts/job.py" },
		line: 42,
		column: 7,
		breakpointFiles: 1,
		breakpointCount: 1,
		functionBreakpointCount: 0,
		outputBytes: 128,
		outputTruncated: false,
		needsConfigurationDone: false,
	};

	const details: DebugToolDetails = { action: "stack_trace", success: true, snapshot };

	function oracleLinesOf(
		result: DebugViewResult,
		options: RenderResultOptions,
		args?: Partial<DebugParams>,
		width = WIDTH,
	): string[] {
		return renderCompLines(debugOracle.debugToolRenderer.renderResult(result, options, theme, args), width);
	}

	function viewLinesOf(
		result: DebugViewResult,
		context: ToolViewContext,
		args?: Partial<DebugParams>,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(debugToolView.renderResult(result, context, args), theme), width);
	}

	it("draws the call row for every target the summary names, with exact byte parity", () => {
		const calls: Array<Partial<DebugParams>> = [
			{},
			{ action: "launch", program: "/repo/scripts/job.py" },
			{ action: "set_breakpoint", file: "/repo/src/main.c", line: 42 },
			// A file with no line falls past the source branch, which is the pair the row needs.
			{ action: "set_breakpoint", file: "/repo/src/main.c" },
			{ action: "set_breakpoint", function: "main" },
			{ action: "evaluate", expression: "state.frames[0]" },
			{ action: "custom_request", command: "threads" },
			{ action: "read_memory", memory_reference: "0x7ffd" },
			{ action: "set_instruction_breakpoint", instruction_reference: "0x1000" },
			{ action: "remove_data_breakpoint", data_id: "watch-1" },
			{ action: "set_data_breakpoint", name: "counter" },
			// Empty strings fall through every branch, so the row is the action alone.
			{ action: "pause", program: "", function: "", name: "" },
			{
				action: "stack_trace",
				expression: `an expression far past the row's budget ${"and more of it ".repeat(12)}`,
			},
		];
		for (const args of calls) {
			const drawn = renderCompText(drawToolView(debugToolView.renderCall(args, COLLAPSED), theme));
			expect(drawn).toBe(renderCompText(debugOracle.debugToolRenderer.renderCall(args, HOST_COLLAPSED, theme)));
		}
		// Anti-vacuity: the row states the action with its underscores read as words, and the target
		// beside it, so the parity above is not two identical stubs.
		const row = stripVTControlCharacters(
			renderCompText(
				drawToolView(
					debugToolView.renderCall({ action: "set_breakpoint", file: "/repo/src/main.c", line: 42 }, COLLAPSED),
					theme,
				),
			),
		);
		expect(row).toContain("set breakpoint");
		expect(row).toContain("main.c:42");
	});

	it("fills the same panel the renderer filled, below the header, at every width and disclosure", () => {
		const results: Array<{ result: DebugViewResult; holdsBack: boolean }> = [
			{
				result: { content: [{ type: "text", text: "Session dbg-1\nAdapter: debugpy" }], details },
				holdsBack: false,
			},
			// No snapshot: the card is the output section alone.
			{
				result: { content: [{ type: "text", text: "ok" }], details: { action: "continue", success: true } },
				holdsBack: false,
			},
			// No text content at all, which is the "No output" line the card falls back to.
			{ result: { content: [], details }, holdsBack: false },
			{
				result: { content: [{ type: "text", text: "adapter not found" }], details, isError: true },
				holdsBack: false,
			},
			// More lines than either preview shows, which is the held-back note in both states.
			{
				result: {
					content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
					details,
				},
				holdsBack: true,
			},
			// A tab and a line past the column budget, which the card de-tabs and cuts.
			{
				result: {
					content: [{ type: "text", text: `col\tumn\n${"x".repeat(TRUNCATE_LENGTHS.LINE + 40)}` }],
					details,
				},
				holdsBack: false,
			},
		];
		for (const { result, holdsBack } of results) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLinesOf(result, context, undefined, width);
					const oracle = oracleLinesOf(result, options, undefined, width);
					// The same rows in the same order at every width, note and all: the header is the
					// one row whose words changed, and it is pinned in its own cell.
					expect(drawn.slice(1).map(line => stripVTControlCharacters(line).trimEnd())).toEqual(
						oracle.slice(1).map(line => stripVTControlCharacters(line).trimEnd()),
					);
					// A card that holds nothing back matches byte for byte; the note's colour is the
					// only other difference, and it is pinned in its own cell too.
					if (!holdsBack) expect(drawn.slice(1)).toEqual(oracle.slice(1));
				}
			}
		}
		// Anti-vacuity: the rows compared above are the session lines and the adapter's own output,
		// not a frame with nothing in it.
		const panel = viewLinesOf(results[0]!.result, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(panel.some(line => line.includes("Location: /repo/scripts/job.py:42:7"))).toBe(true);
		expect(panel.some(line => line.includes("Adapter: debugpy"))).toBe(true);
		expect(panel.some(line => line.includes("Output"))).toBe(true);
	});

	it("exception cell: the header colours its title and sets the action off, where main concatenated both", () => {
		const result: DebugViewResult = { content: [{ type: "text", text: "ok" }], details };
		const oracleHeader = oracleLinesOf(result, HOST_COLLAPSED)[0] ?? "";
		const viewHeader = viewLinesOf(result, COLLAPSED)[0] ?? "";
		// This theme draws `tool.debug` as nothing, which is why main's row opened on a blank column:
		// it concatenated an empty glyph, a space and an untoned title. The row now states the title in
		// the tool colour and sets the action off with the separator every other tool header uses, and
		// drops the column the empty glyph left behind.
		expect(theme.symbol("tool.debug")).toBe("");
		expect(stripVTControlCharacters(oracleHeader).trimEnd()).toBe("▏  Debug stack trace");
		expect(stripVTControlCharacters(viewHeader).trimEnd()).toBe("▏ Debug: stack trace");
		expect(viewHeader).toContain(theme.fg("accent", "Debug"));
		expect(viewHeader).toContain(theme.fg("muted", "stack trace"));
	});

	it("exception cell: the held-back note draws in the dim its expand hint already used", () => {
		const result: DebugViewResult = {
			content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
			details,
		};
		const note = (lines: string[]): string => lines.find(line => line.includes("more line")) ?? "";
		const oracleNote = note(oracleLinesOf(result, HOST_COLLAPSED));
		const viewNote = note(viewLinesOf(result, COLLAPSED));
		const rail = viewNote.slice(0, viewNote.indexOf("\u001b[38;2", 1));
		expect(stripVTControlCharacters(oracleNote)).toBe(stripVTControlCharacters(viewNote));
		expect(oracleNote).toBe(
			`${rail}${theme.fg("muted", `… 17 more lines ${formatExpandHint(theme, false, true)}`)}`.trimEnd(),
		);
		expect(viewNote).toBe(
			`${rail}${theme.fg("dim", "… 17 more lines")} ${formatExpandHint(theme, false, true)}`.trimEnd(),
		);
	});

	it("reports a result still arriving as running, and the settled one as done", () => {
		const result: DebugViewResult = { content: [{ type: "text", text: "ok" }], details };
		const running = viewLinesOf(result, { expanded: false, partial: true })[0] ?? "";
		const settled = viewLinesOf(result, COLLAPSED)[0] ?? "";
		const oracleRunning = oracleLinesOf(result, { expanded: false, isPartial: true })[0] ?? "";
		// The running arm draws the glyph main drew for it, and the settled arm draws none, which is
		// what this theme's blank `tool.debug` emblem means. Without `partial` in the context the two
		// would be the same row, and every update of a live session would report success.
		const glyph = (line: string): string =>
			stripVTControlCharacters(line)
				.replace(/^\s*▏\s?/u, "")
				.trimEnd()
				.slice(0, 1);
		expect(glyph(running)).toBe(glyph(oracleRunning));
		expect(glyph(running)).not.toBe(glyph(settled));
		expect(
			stripVTControlCharacters(settled)
				.replace(/^\s*▏\s?/u, "")
				.startsWith("Debug"),
		).toBe(true);
	});
});
