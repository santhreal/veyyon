/**
 * The MCP card draws what main's renderer drew.
 *
 * An MCP tool is somebody else's tool reached over a protocol, so its card is the one in this tree
 * whose content nothing here produces: the arguments that went out, and whatever the server sent
 * back, as a structure when it parses and as rows of text when it does not. The matrix below drives
 * both answers, the empty answer, the error header, the expanded argument walk, the collapsed and
 * expanded row budgets, and a spilled result whose notice must reach the reader as a warning rather
 * than as prose inside the body.
 *
 * TWO DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived silently:
 *
 *  - The rows sit two columns under the row that heads them, where main drew them flush against the
 *    card's left edge. The indent is the host's answer for every frameless card, and this card is now
 *    one of them.
 *  - The call row's arguments lose the `└─` branch main opened them with. The branch was terminal
 *    chrome on a single row that branches to nothing.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createMCPToolView, type MCPViewResult } from "@veyyon/coding-agent/mcp/view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatOutputNotice, type OutputMeta } from "@veyyon/coding-agent/tools/core/output-meta";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import * as mcpOracle from "../oracles/mcp-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

const LABEL = "sentry/search_events";
const view = createMCPToolView(LABEL);

/**
 * A row without the colour runs that draw nothing.
 *
 * Main drew the whole card as ONE string inside a `WidthAwareText`, so every row after the first
 * opens with the style state the rows above it left behind: a colour immediately followed by its
 * reset, drawing zero columns. A view is a list of rows, and the host draws each one on its own.
 * Dropping the empty pairs compares what a reader sees rather than which component concatenated it.
 */
function withoutEmptyRuns(row: string): string {
	let out = row;
	let previous = "";
	while (out !== previous) {
		previous = out;
		out = out.replace(/\x1b\[[0-9;]*m\x1b\[39m/g, "");
	}
	return out;
}

/** The rows main drew, with the two columns the host now indents a frameless card's body by. */
function indented(rows: readonly string[]): string[] {
	return rows.map((row, index) =>
		index === 0 || row === "" ? withoutEmptyRuns(row) : `  ${withoutEmptyRuns(row)}`.trimEnd(),
	);
}

/**
 * A row's words, with the tree main drew a structure with taken out.
 *
 * `json-tree-view.ts` states a structure as depth -- two columns per level and a kind mark -- where
 * the terminal walk it replaces baked a `└─` into every row. The two therefore cannot be equal
 * bytes, so the cells that walk a structure compare the words and the order, and assert separately
 * that the view's rows carry no branch.
 */
function words(row: string): string {
	return stripVTControlCharacters(row)
		.replaceAll("└─", "")
		.replaceAll("├─", "")
		.replaceAll("│", "")
		.replace(/\s+/g, " ")
		.trim();
}

function oracleResultRows(result: MCPViewResult, expanded: boolean, args?: Record<string, unknown>): string[] {
	return renderCompLines(
		mcpOracle.renderMCPResult(
			result as Parameters<typeof mcpOracle.renderMCPResult>[0],
			expanded ? HOST_EXPANDED : HOST_COLLAPSED,
			theme,
			args,
		),
		WIDTH,
	);
}

function viewResultRows(result: MCPViewResult, expanded: boolean, args?: Record<string, unknown>): string[] {
	return renderCompLines(drawToolView(view.renderResult(result, expanded ? EXPANDED : COLLAPSED, args), theme), WIDTH);
}

function resultOf(text: string, extra: Partial<MCPViewResult> = {}): MCPViewResult {
	return {
		content: [{ type: "text", text }],
		details: { serverName: "sentry", mcpToolName: "search_events" },
		...extra,
	};
}

describe("mcp tool differential", () => {
	it("exception cell: the call row states the same arguments without main's branch glyph", () => {
		const args = { query: "level:error", limit: 20 };
		const oracle = renderCompLines(mcpOracle.renderMCPCall(args, theme, LABEL), WIDTH);
		const drawn = renderCompLines(drawToolView(view.renderCall(args, COLLAPSED), theme), WIDTH);

		expect(drawn[0]).toBe(oracle[0]);
		const plainOracle = stripVTControlCharacters(oracle[1] ?? "");
		const plainDrawn = stripVTControlCharacters(drawn[1] ?? "");
		expect(plainOracle).toContain('query="level:error", limit=20');
		// The one difference: main opened the row with its tree branch, the host indents it instead.
		expect(plainOracle.trimStart().startsWith(theme.tree.last)).toBe(true);
		expect(plainDrawn).toBe(`  ${plainOracle.trimStart().slice(theme.tree.last.length).trim()}`);
	});

	it("heads a call with no arguments and says nothing under it", () => {
		const drawn = renderCompLines(drawToolView(view.renderCall({}, COLLAPSED), theme), WIDTH);
		const oracle = renderCompLines(mcpOracle.renderMCPCall({}, theme, LABEL), WIDTH);
		expect(drawn).toEqual(oracle);
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain(LABEL);
	});

	it("exception cell: walks a structured answer the way main walked it, without its branch glyphs", () => {
		const result = resultOf(JSON.stringify({ events: [{ id: 1, message: "boom" }], total: 1 }));
		for (const expanded of [false, true]) {
			const drawn = viewResultRows(result, expanded);
			const oracle = oracleResultRows(result, expanded);
			expect(drawn.map(words)).toEqual(oracle.map(words));
			expect(stripVTControlCharacters(oracle.join("\n"))).toContain("└─");
			expect(stripVTControlCharacters(drawn.join("\n"))).not.toContain("└─");
			// The depth survives the branch: a nested key still sits further in than the key above it.
			// The head is skipped, since the tool's own name ends in the key this fixture nests under.
			const rows = drawn.slice(1).map(row => stripVTControlCharacters(row));
			const parent = rows.findIndex(row => row.trim().endsWith("events"));
			const child = rows.findIndex(row => row.includes("[0]"));
			expect(parent).toBeGreaterThanOrEqual(0);
			expect(child).toBeGreaterThan(parent);
			expect(rows[child]?.search(/\S/)).toBeGreaterThan(rows[parent]?.search(/\S/) ?? 0);
		}
	});

	it("keeps a raw answer's rows and the count of the ones it dropped, at both disclosures", () => {
		const result = resultOf(Array.from({ length: 30 }, (_, i) => `event ${i}`).join("\n"));
		for (const expanded of [false, true]) {
			expect(viewResultRows(result, expanded)).toEqual(indented(oracleResultRows(result, expanded)));
		}
		const collapsed = stripVTControlCharacters(viewResultRows(result, false).join("\n"));
		expect(collapsed).toContain("event 3");
		expect(collapsed).not.toContain("event 4");
		expect(collapsed).toContain("26 more lines");
	});

	it("says an empty answer is empty, and marks a failed call as failed", () => {
		const empty = resultOf("");
		expect(viewResultRows(empty, false)).toEqual(indented(oracleResultRows(empty, false)));

		const failed = resultOf("Error: denied", {
			isError: true,
			details: { serverName: "sentry", mcpToolName: "search_events", isError: true },
		});
		expect(viewResultRows(failed, true)).toEqual(indented(oracleResultRows(failed, true)));
	});

	it("exception cell: shows the arguments on the expanded card and withholds them on the collapsed one", () => {
		const args = { query: "level:error", nested: { deep: { deeper: [1, 2, 3] } } };
		const result = resultOf(JSON.stringify({ ok: true }));
		for (const expanded of [false, true]) {
			expect(viewResultRows(result, expanded, args).map(words)).toEqual(
				oracleResultRows(result, expanded, args).map(words),
			);
		}
		expect(stripVTControlCharacters(viewResultRows(result, true, args).join("\n"))).toContain("Args");
		expect(stripVTControlCharacters(viewResultRows(result, false, args).join("\n"))).not.toContain("Args");
	});

	it("carries a spilled result's artifact link once, as the warning main wrapped it in", () => {
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 8000,
				outputLines: 4,
				outputBytes: 160,
				maxBytes: 1024,
				shownRange: { start: 97, end: 100 },
				artifactId: "7",
			},
		};
		const body = "event 97\nevent 98\nevent 99\nevent 100";
		const result: MCPViewResult = {
			content: [{ type: "text", text: body + formatOutputNotice(meta) }],
			details: { serverName: "evk", mcpToolName: "peek", meta },
		};

		expect(viewResultRows(result, true)).toEqual(indented(oracleResultRows(result, true)));
		const plain = stripVTControlCharacters(viewResultRows(result, true).join("\n"));
		expect(plain).toContain("event 97");
		// Once, as the warning: the body's own copy of the notice was stripped before the rows were
		// stated, which is the whole reason the card reads the meta rather than the text.
		expect(plain.split("artifact://7").length - 1).toBe(1);
	});
});
