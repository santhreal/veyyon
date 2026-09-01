/**
 * The `read_url` card draws what main's renderer drew.
 *
 * TWO DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS: the held-back note and the truncation mark, both
 * of which the host now words and tones rather than the tool.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { settings } from "@veyyon/coding-agent/config/settings";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatExpandHint } from "@veyyon/coding-agent/tools/core/render-utils";
import type { ReadUrlToolDetails } from "@veyyon/coding-agent/tools/web/fetch";
import { type ReadUrlViewResult, readUrlToolView } from "@veyyon/coding-agent/tools/web/fetch-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import * as fetchOracle from "../oracles/fetch-main-renderer";
import {
	COLLAPSED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	renderCompLines,
	renderCompText,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("read_url tool differential", () => {
	const details: ReadUrlToolDetails = {
		kind: "url",
		url: "https://example.com/docs",
		finalUrl: "https://example.com/docs",
		contentType: "text/html",
		method: "GET",
		truncated: false,
		notes: [],
	};
	const body = Array.from({ length: 9 }, (_, index) => `page line ${index + 1}`).join("\n");
	const page = { content: [{ type: "text", text: `fetched from example.com\n---\n\n${body}` }], details };
	const truncatedPage = {
		content: [{ type: "text", text: `---\n\n${body}` }],
		details: {
			...details,
			finalUrl: "https://example.com/docs/v2",
			truncated: true,
			notes: ["reader mode", "cached"],
			meta: {
				truncation: {
					direction: "head",
					truncatedBy: "lines",
					totalLines: 40,
					totalBytes: 4096,
					outputLines: 9,
					outputBytes: 107,
					artifactId: "abc123",
				},
			},
		} satisfies ReadUrlToolDetails,
	};

	function oracleLinesOf(result: ReadUrlViewResult, expanded: boolean, width = WIDTH): string[] {
		return renderCompLines(
			fetchOracle.renderReadUrlResult(result, expanded ? HOST_EXPANDED : HOST_COLLAPSED, theme),
			width,
		);
	}

	function viewLinesOf(result: ReadUrlViewResult, expanded: boolean, width = WIDTH): string[] {
		return renderCompLines(drawToolView(readUrlToolView.renderResult(result, { expanded }), theme), width);
	}

	/** The row a card writes for what it held back, which is the one row the two arms word differently. */
	function heldBackIndex(lines: readonly string[]): number {
		return lines.findIndex(line => stripVTControlCharacters(line).includes("more lines"));
	}

	it("draws a pending call for every shape of URL exactly as the renderer did", () => {
		const targets = [
			"https://example.com/docs",
			"www.example.com/guide",
			"https://example.com/a/very/long/path/that/keeps/going/past/the/fifty/column/budget/and/then/some",
			"https://example.com/page:10-20",
			"https://example.com/page:raw",
			"artifact://abc123",
			"",
		];
		for (const target of targets) {
			for (const raw of [false, true]) {
				const args = { path: target, raw };
				const oracleComp = fetchOracle.renderReadUrlCall(args, HOST_COLLAPSED, theme);
				const card = drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme);
				expect(renderCompLines(card)).toEqual(renderCompLines(oracleComp));
			}
		}
		// Anti-vacuity: the row really carries the target and the raw flag, so a view that dropped
		// either would not be comparing two identical blanks above.
		const row = stripVTControlCharacters(
			renderCompText(drawToolView(readUrlToolView.renderCall({ path: targets[0], raw: true }, COLLAPSED), theme)),
		);
		expect(row).toContain("example.com /docs");
		expect(row).toContain("raw");
	});

	it("draws a fetched page's panel, metadata and preview with exact byte parity", () => {
		for (const result of [page, truncatedPage]) {
			for (const expanded of [false, true]) {
				const oracleLines = oracleLinesOf(result, expanded);
				const viewLines = viewLinesOf(result, expanded);
				expect(viewLines).toHaveLength(oracleLines.length);
				const note = heldBackIndex(oracleLines);
				const truncatedNotice = oracleLines.findIndex(line =>
					stripVTControlCharacters(line).includes("Output truncated"),
				);
				for (let row = 0; row < oracleLines.length; row++) {
					// The two rows the exception cells below own, pinned there rather than skipped here.
					if (row === note || row === truncatedNotice) continue;
					expect(viewLines[row]).toBe(oracleLines[row]);
				}
			}
		}
	});

	it("holds back the same lines at the same disclosure caps as the renderer did", () => {
		// Anti-vacuity for the parity cell above: the two disclosure states are not the same card. The
		// collapsed preview stops at three of the nine lines and the expanded one reaches all nine, so
		// a view that ignored the context would draw one of them wrong.
		const collapsed = viewLinesOf(page, false).map(line => stripVTControlCharacters(line));
		const expanded = viewLinesOf(page, true).map(line => stripVTControlCharacters(line));
		expect(collapsed.filter(line => line.includes("page line "))).toHaveLength(3);
		expect(expanded.filter(line => line.includes("page line "))).toHaveLength(9);
		expect(collapsed.some(line => line.includes("… 6 more lines"))).toBe(true);
		expect(expanded.some(line => line.includes("more lines"))).toBe(false);
		// A page whose body is blank says so rather than drawing an empty preview, and holds nothing
		// back, so no gesture is offered for rows that are not there.
		const empty = viewLinesOf({ content: [{ type: "text", text: "---\n\n   \n" }], details }, false);
		expect(empty.map(line => stripVTControlCharacters(line))).toEqual(
			oracleLinesOf({ content: [{ type: "text", text: "---\n\n   \n" }], details }, false).map(line =>
				stripVTControlCharacters(line),
			),
		);
		expect(empty.some(line => stripVTControlCharacters(line).includes("(no content)"))).toBe(true);
		expect(empty.some(line => stripVTControlCharacters(line).includes("more lines"))).toBe(false);
	});

	it("exception cell: the held-back note is worded and toned by the host, not by the tool", () => {
		// `main` wrote the whole note in `muted` and wrapped the host's own expand hint inside that
		// colour; the host writes one note for every card that holds something back, in `dim`, with the
		// hint beside it rather than inside it. The words and the columns are the same, which is what
		// the plain-text equality pins; the bytes of both arms are pinned so the difference stays this
		// one row and this one role.
		const oracleLines = oracleLinesOf(page, false);
		const viewLines = viewLinesOf(page, false);
		const row = heldBackIndex(oracleLines);
		expect(row).toBeGreaterThan(0);
		expect(stripVTControlCharacters(viewLines[row] ?? "")).toBe(stripVTControlCharacters(oracleLines[row] ?? ""));
		const hint = formatExpandHint(theme, false, true);
		expect(oracleLines[row]).toContain(theme.fg("muted", `… 6 more lines ${hint}`));
		expect(viewLines[row]).toContain(`${theme.fg("dim", "… 6 more lines")} ${hint}`);
	});

	it("exception cell: the truncation mark is its own span, so the glyph and its words carry the tone separately", () => {
		// `main` coloured the glyph and the sentence in one wrap. A view states a glyph the host
		// resolves and the words beside it, so the same colour opens twice: identical on a screen, and
		// pinned here so the difference cannot widen to the words themselves.
		const oracleLines = oracleLinesOf(truncatedPage, false);
		const viewLines = viewLinesOf(truncatedPage, false);
		const row = oracleLines.findIndex(line => stripVTControlCharacters(line).includes("Output truncated"));
		expect(row).toBeGreaterThan(0);
		expect(stripVTControlCharacters(viewLines[row] ?? "")).toBe(stripVTControlCharacters(oracleLines[row] ?? ""));
		expect(oracleLines[row]).toContain(theme.fg("warning", `${theme.status.warning} Output truncated`));
		expect(viewLines[row]).toContain(
			`${theme.styledSymbol("status.warning", "warning")}${theme.fg("warning", " Output truncated")}`,
		);
	});

	it("draws a failed fetch exactly as the renderer did", () => {
		const failures: ReadUrlViewResult[] = [
			{ content: [{ type: "text", text: "Error: 404 Not Found" }], isError: true, details },
			{ content: [{ type: "text", text: "Error: connection reset\nafter two retries" }], isError: true, details },
			{ content: [{ type: "text", text: "" }], isError: true },
			{ content: [], isError: true },
			// A result with no details is a failure even when nothing set the flag: there is no page.
			{ content: [{ type: "text", text: "nothing came back" }] },
			{ content: [{ type: "text", text: "a\tfailure\twith\ttabs" }], isError: true, details },
		];
		for (const failure of failures) {
			expect(viewLinesOf(failure, false)).toEqual(oracleLinesOf(failure, false));
		}
		// Anti-vacuity: the failure card is a panel with the reason in it, not an empty frame, and a
		// tab never reaches the screen.
		const rows = viewLinesOf(failures[0]!, false).map(line => stripVTControlCharacters(line));
		expect(rows.some(line => line.includes("404 Not Found"))).toBe(true);
		expect(viewLinesOf(failures[5]!, false).join("\n")).not.toContain("\t");
	});

	it("carries the same OSC 8 targets the renderer carried, on the row and in the metadata", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const args = { path: "https://example.com/docs" };
			expect(renderCompLines(drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme))).toEqual(
				renderCompLines(fetchOracle.renderReadUrlCall(args, HOST_COLLAPSED, theme)),
			);
			const redirected = { ...truncatedPage, isError: false };
			const oracleLines = oracleLinesOf(redirected, false);
			const viewLines = viewLinesOf(redirected, false);
			const finalUrlRow = oracleLines.findIndex(line => stripVTControlCharacters(line).includes("Final URL:"));
			expect(finalUrlRow).toBeGreaterThan(0);
			expect(viewLines[finalUrlRow]).toBe(oracleLines[finalUrlRow]);
			// Anti-vacuity: with hyperlinks on the rows really do carry OSC 8, so the equality above is
			// not two plain strings agreeing.
			expect(viewLines[finalUrlRow]).toContain("\u001b]8;");
			expect(viewLines[finalUrlRow]).toContain("https://example.com/docs/v2");
			const callRow = renderCompText(drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme));
			expect(callRow).toContain("\u001b]8;");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});
});
