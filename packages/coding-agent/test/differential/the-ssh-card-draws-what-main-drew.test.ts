/**
 * The `ssh` card draws what main's renderer drew.
 *
 * FOUR DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The command preview, windowed by the rows it
 * occupies rather than by its own line count. The result frame, which states the outcome on the rail
 * and leaves the remote's output on the terminal's ground where main filled every row with the
 * outcome plate. The truncation notice, a warning-toned line rather than a bracketed aside. And the
 * collapsed output window, which spends one of its rows on the note it writes.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatTruncationMetaNotice, type TruncationMeta } from "@veyyon/coding-agent/tools/core/output-notice";
import { PREVIEW_LIMITS, previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";
import { type SshViewArgs, type SshViewResult, sshToolView } from "@veyyon/coding-agent/tools/shell/ssh-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { getStateBgColor } from "@veyyon/coding-agent/tui/utils";
import type { ToolViewContext } from "@veyyon/view";
import * as sshOracle from "../oracles/ssh-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

describe("ssh tool differential", () => {
	const args: SshViewArgs = { host: "router", command: "uptime" };
	/**
	 * The card the host asks for when nothing is streaming.
	 *
	 * `partial: false` is what `viewToolRenderer` passes on from `RenderResultOptions.isPartial`, so a
	 * cell comparing against `HOST_COLLAPSED` states it rather than leaving it undefined: an omitted
	 * `partial` is a call site with nothing to stream, which is a different question.
	 */
	const CALL_COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const CALL_EXPANDED: ToolViewContext = { expanded: true, partial: false };

	function oracleLinesOf(
		result: SshViewResult,
		options: RenderResultOptions,
		callArgs: SshViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(sshOracle.sshMainRenderer.renderResult(result, options, theme, callArgs), width);
	}

	function viewLinesOf(
		result: SshViewResult,
		context: ToolViewContext,
		callArgs: SshViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(sshToolView.renderResult(result, context, callArgs), theme), width);
	}

	/** The rows with every escape stripped, which leaves the plate out of the comparison. */
	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	it("draws the pending call frame the renderer drew, at every width and disclosure", () => {
		const calls: SshViewArgs[] = [
			{},
			{ host: "router" },
			{ host: "router", command: "uptime" },
			{ host: "router", command: "set -e\ncat > /etc/hosts <<'EOF'\n# hosts\nEOF" },
			{ host: "router", command: "col\tumn" },
			// A command that wraps past the viewport is the one case the two arms answer differently,
			// pinned in its own cell below.
			{ host: "router", command: `wide ${"x".repeat(200)}` },
		];
		for (const callArgs of calls) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40]) {
					const drawn = renderCompLines(drawToolView(sshToolView.renderCall(callArgs, context), theme), width);
					const oracle = renderCompLines(sshOracle.sshMainRenderer.renderCall(callArgs, options, theme), width);
					expect(unstyled(drawn)).toEqual(unstyled(oracle));
				}
			}
		}
		// Anti-vacuity: the frame carries the host and the command under a prompt, not an empty box.
		const rows = unstyled(renderCompLines(drawToolView(sshToolView.renderCall(args, CALL_COLLAPSED), theme)));
		expect(rows.some(row => row.includes("SSH"))).toBe(true);
		expect(rows.some(row => row.includes("[router]"))).toBe(true);
		expect(rows.some(row => row.includes("$ uptime"))).toBe(true);
	});

	it("exception cell: a wrapped command is windowed by the rows it occupies, not by its line count", () => {
		const callArgs: SshViewArgs = { host: "router", command: `wide ${"x".repeat(200)}` };
		const narrow = 12;
		const oracle = unstyled(
			renderCompLines(sshOracle.sshMainRenderer.renderCall(callArgs, HOST_COLLAPSED, theme), narrow),
		);
		const drawn = unstyled(
			renderCompLines(drawToolView(sshToolView.renderCall(callArgs, CALL_COLLAPSED), theme), narrow),
		);
		// Main capped the section at a number of the tool's OWN lines, and one command line is one
		// line however many rows it wraps to, so a single long command filled the terminal it was
		// supposed to fit inside. The host counts the rows the section occupies after wrapping, so the
		// same command spends a window and says how much of itself it dropped.
		expect(oracle.length).toBeGreaterThan(drawn.length);
		// The note is read across the rows it wraps into, past the rail every framed row starts with:
		// at twelve columns "earlier lines" is two rows of the card.
		const body = (rows: readonly string[]): string => rows.map(row => row.replace(/^▏\s*/u, "")).join(" ");
		expect(body(oracle)).not.toContain("earlier line");
		expect(body(drawn)).toContain("earlier line");
		// The end of the command is what both arms keep, so the window cut the front and nothing else.
		expect(drawn.at(-1)).toBe(oracle.at(-1));
	});

	it("draws the settled and failed result frames the renderer drew", () => {
		const results: SshViewResult[] = [
			{ content: [{ type: "text", text: "" }] },
			{ content: [{ type: "text", text: "load average: 0.1" }] },
			{ content: [{ type: "text", text: "col\tumn\nsecond" }] },
			{ content: [{ type: "text", text: "permission denied" }], isError: true },
		];
		for (const result of results) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					expect(unstyled(viewLinesOf(result, context, args, width))).toEqual(
						unstyled(oracleLinesOf(result, options, args, width)),
					);
				}
			}
		}
		// Anti-vacuity: the compared rows are the command, the output label and the remote's own line.
		const rows = unstyled(viewLinesOf(results[1]!, CALL_COLLAPSED));
		expect(rows.some(row => row.includes("$ uptime"))).toBe(true);
		expect(rows.some(row => row.includes("Output"))).toBe(true);
		expect(rows.some(row => row.includes("load average: 0.1"))).toBe(true);
	});

	it("reports a result still arriving as pending, and the settled one with the ssh emblem", () => {
		const result: SshViewResult = { content: [{ type: "text", text: "streaming" }] };
		const running = unstyled(viewLinesOf(result, { expanded: false, partial: true }))[0] ?? "";
		const settled = unstyled(viewLinesOf(result, CALL_COLLAPSED))[0] ?? "";
		const oracleRunning = unstyled(oracleLinesOf(result, { expanded: false, isPartial: true }))[0] ?? "";
		expect(running).toBe(oracleRunning);
		// Without `partial` in the context both rows would be the settled one, and a live session
		// would report every update as a completed command.
		expect(running).not.toBe(settled);
		expect(settled).toContain("SSH");
	});

	it("windows the command by the rows the terminal has, keeping the end and stating the rest", () => {
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_unused, index) => `step_${index}`).join("\n");
		const callArgs: SshViewArgs = { host: "router", command };
		const rows = unstyled(viewLinesOf({ content: [] }, CALL_COLLAPSED, callArgs));
		const text = rows.join("\n");
		expect(text).toContain(`step_${total - 1}`);
		expect(text).toContain("earlier line");
		expect(text).not.toContain("step_0");
		// The window is the host's arithmetic, so the section spends no more rows than it was given.
		const commandRows = rows.filter(row => /step_\d+|earlier line/.test(row));
		expect(commandRows.length).toBeLessThanOrEqual(previewWindowRows());
		// Expanding drops the window rather than widening it.
		const expanded = unstyled(viewLinesOf({ content: [] }, CALL_EXPANDED, callArgs)).join("\n");
		expect(expanded).toContain("$ step_0");
		expect(expanded).not.toContain("earlier line");
	});

	it("exception cell: the frame states its outcome on the rail alone, and leaves the body unplated", () => {
		const result: SshViewResult = { content: [{ type: "text", text: "load average: 0.1" }] };
		const plate = theme.getBgAnsi(getStateBgColor("success"));
		// Main filled every row with the success plate, which is the treatment a card whose body is a
		// verdict asks for; an ssh body is the remote host's own output, so the card now states the
		// outcome once, on the rail, and leaves the transcript on the terminal's ground. Every other
		// cell here compares the arms with escapes stripped, which is what makes this the one pinned
		// difference between them.
		expect(oracleLinesOf(result, HOST_COLLAPSED).some(line => line.includes(plate))).toBe(true);
		expect(viewLinesOf(result, CALL_COLLAPSED).some(line => line.includes(plate))).toBe(false);
	});

	it("exception cell: the truncation notice is a warning line, not a bracketed aside", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 400,
			totalBytes: 40_960,
			outputLines: 20,
			outputBytes: 2_048,
		};
		const result: SshViewResult = {
			content: [{ type: "text", text: "output" }],
			details: { meta: { truncation } },
		};
		const message = formatTruncationMetaNotice(truncation);
		expect(message.length).toBeGreaterThan(0);
		const notice = (lines: readonly string[]): string => unstyled(lines).find(line => line.includes(message)) ?? "";
		const oracleNotice = notice(oracleLinesOf(result, HOST_COLLAPSED));
		const viewNotice = notice(viewLinesOf(result, CALL_COLLAPSED));
		// Same words in both arms. The brackets main drew around them are the theme's, which a tool
		// cannot name, so the line arrives as a warning-toned run and the host draws it plainly.
		// The rail and its indent are the host's two columns, which every row of a framed card carries.
		expect(viewNotice.trimEnd().endsWith(message)).toBe(true);
		expect(oracleNotice).toContain(theme.format.bracketLeft);
		expect(viewNotice).not.toContain(theme.format.bracketLeft);
	});

	it("exception cell: the collapsed output window spends its own row on the note it writes", () => {
		const text = Array.from({ length: 40 }, (_unused, index) => `out ${index}`).join("\n");
		const result: SshViewResult = { content: [{ type: "text", text }] };
		const outputRows = (lines: readonly string[]): string[] =>
			unstyled(lines).filter(row => /out \d+|earlier line/.test(row));
		const oracle = outputRows(oracleLinesOf(result, HOST_COLLAPSED));
		const drawn = outputRows(viewLinesOf(result, CALL_COLLAPSED));
		// Main showed `OUTPUT_COLLAPSED` lines AND a note above them, so the section drew one row more
		// than the bound it counted against; the host's window counts the note as one of the rows it
		// was given, and words it the way every other windowed section is worded.
		expect(oracle.length).toBe(PREVIEW_LIMITS.OUTPUT_COLLAPSED + 1);
		expect(drawn.length).toBe(PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		expect(oracle.at(-1)).toBe(drawn.at(-1));
		expect(oracle[0]).toContain("earlier lines, showing");
		expect(drawn[0]).toContain("earlier lines");
		expect(drawn[0]).not.toContain("showing");
	});
});
