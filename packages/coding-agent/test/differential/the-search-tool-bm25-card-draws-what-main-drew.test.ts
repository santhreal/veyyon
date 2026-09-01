/**
 * The `search_tool_bm25` card draws what main's renderer drew.
 *
 * FOUR DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The matches, which are a list the host marks and
 * lays out: a branch on each row where main drew a dim bullet, the summary on the row rather than
 * indented under it, and the server and the score set off by spaces rather than by a dot the tool
 * wrote itself. The held-back count, which closes the list on the last branch and leaves the expand
 * gesture to the host, where main wrote the bracketed hint into the row. And the card with no matches
 * and the card with no details, whose message the host indents under a header it cuts, where main
 * opened a plain text block that wrapped the header and started the message in column zero behind the
 * colour runs the wrap had closed.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatExpandHint, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import type {
	SearchToolBm25Details,
	SearchToolBm25Match,
	SearchToolBm25Params,
} from "@veyyon/coding-agent/tools/search/search-tool-bm25";
import {
	type SearchToolBm25ViewResult,
	searchToolBm25ToolView,
} from "@veyyon/coding-agent/tools/search/search-tool-bm25-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ToolViewContext } from "@veyyon/view";
import * as searchToolBm25Oracle from "../oracles/search-tool-bm25-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	lineView,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("search_tool_bm25 tool differential", () => {
	/** A ranked match, with the server name on every other row so both meta shapes are drawn. */
	function match(index: number): SearchToolBm25Match {
		return {
			name: `tool_${index}`,
			label: `tool ${index}`,
			description: `what tool ${index} does`,
			...(index % 2 === 0 ? { server_name: "local" } : {}),
			schema_keys: ["a"],
			score: 1 - index / 10,
		};
	}

	function details(count: number, overrides: Partial<SearchToolBm25Details> = {}): SearchToolBm25Details {
		return {
			query: "keep track of what is left",
			limit: 8,
			total_tools: 41,
			activated_tools: ["todo"],
			also_matched: [],
			active_selected_tools: ["read", "bash"],
			tools: Array.from({ length: count }, (_, index) => match(index)),
			...overrides,
		};
	}

	function found(count: number, overrides: Partial<SearchToolBm25Details> = {}): SearchToolBm25ViewResult {
		return { content: [{ type: "text", text: "{}" }], details: details(count, overrides) };
	}

	function viewLines(result: SearchToolBm25ViewResult, context: ToolViewContext, width = WIDTH): string[] {
		return renderCompLines(drawToolView(searchToolBm25ToolView.renderResult(result, context), theme), width);
	}

	function oracleLines(result: SearchToolBm25ViewResult, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(searchToolBm25Oracle.searchToolBm25Renderer.renderResult(result, options, theme), width);
	}

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: SearchToolBm25Params[] = [
			{ query: "todo" },
			{ query: "todo", limit: 3 },
			{ query: "   " },
			{ query: "" },
			{ query: "tab\tseparated words" },
			{ query: "x".repeat(200), limit: 40 },
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(searchToolBm25ToolView.renderCall(args, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						searchToolBm25Oracle.searchToolBm25Renderer.renderCall(args, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the rows compared above carry the query, the limit when one was asked for, and
		// the words a card with no query falls back to.
		const asked = stripVTControlCharacters(
			renderCompLines(
				drawToolView(lineView(searchToolBm25ToolView.renderCall({ query: "todo", limit: 3 }, COLLAPSED)), theme),
			).join(""),
		);
		expect(asked).toContain("Tool Discovery: todo");
		expect(asked).toContain("limit:3");
		const blank = renderCompLines(
			drawToolView(lineView(searchToolBm25ToolView.renderCall({ query: "   " }, COLLAPSED)), theme),
		).join("");
		expect(stripVTControlCharacters(blank)).toContain("(empty query)");
	});

	it("heads the settled card with the row main headed it with, and frames it the same way", () => {
		for (const count of [1, 2, 5, 7, 12]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLines(found(count), context, width);
					const oracle = oracleLines(found(count), options, width);
					expect(drawn[0]).toBe(oracle[0]);
					// The frame is the one main asked for by hand: a muted edge on every row and no plate
					// behind the body, which is what a listing draws.
					const edge = theme.fg("borderMuted", theme.symbol("block.rail"));
					expect(drawn.every(line => line.startsWith(edge))).toBe(true);
					expect(oracle.every(line => line.startsWith(edge))).toBe(true);
				}
			}
		}
		// Anti-vacuity: the header compared above states the query, the match count and the inventory
		// it searched, rather than a bare tool name.
		const header = stripVTControlCharacters(viewLines(found(7), COLLAPSED)[0] ?? "");
		expect(header).toContain("Tool Discovery: keep track of what is left");
		expect(header).toContain("7 matches");
		expect(header).toContain("41 total");
	});

	it("shows every match main showed, with the same words, scores and cuts", () => {
		const long: SearchToolBm25Details = details(3, {
			tools: [
				{
					name: "verbose",
					label: "l".repeat(120),
					description: "d".repeat(200),
					server_name: "remote",
					schema_keys: [],
					score: 0.5,
				},
				{ name: "tabbed", label: "ta\tbbed", description: "sum\tmary", schema_keys: [], score: 0.25 },
				{ name: "silent", label: "silent", description: "   ", schema_keys: [], score: 0 },
			],
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			const drawn = viewLines({ content: [], details: long }, context, 200).map(line =>
				stripVTControlCharacters(line),
			);
			const oracle = oracleLines({ content: [], details: long }, options, 200).map(line =>
				stripVTControlCharacters(line),
			);
			const words = (lines: string[]): string =>
				lines
					.join(" ")
					.replaceAll(/[▏•│├└─\s]+/gu, " ")
					.replaceAll(" · ", " ")
					.trim();
			// Same labels, same server, same three-decimal scores, same summaries, cut at the same two
			// budgets: only the rows they sit on differ, which the exception cells below pin.
			expect(words(drawn)).toBe(words(oracle));
			const label = truncateToWidth("l".repeat(120), 72);
			const summary = truncateToWidth("d".repeat(200), 96);
			expect(words(drawn)).toContain(`${label} remote score 0.500 ${summary}`);
			expect(words(drawn)).toContain("ta bbed score 0.250 sum mary");
			// A match whose summary is blank contributes no summary to either arm.
			expect(words(drawn)).toContain("silent score 0.000");
			expect(words(drawn)).not.toContain("silent score 0.000  ");
		}
	});

	it("exception cell: the matches are a list the host marks, one row per tool", () => {
		const drawn = viewLines(found(2), COLLAPSED);
		const oracle = oracleLines(found(2), HOST_COLLAPSED);
		const edge = `${theme.fg("borderMuted", theme.symbol("block.rail"))} `;
		// The host marks each item with a branch and lays the summary out on the row; main drew a dim
		// bullet and indented the summary onto a row of its own, and wrote the separator between the
		// server and the score itself.
		expect(drawn.slice(1)).toEqual([
			`${edge} ${theme.fg("dim", theme.tree.branch)} ${theme.fg("accent", "tool 0")}${theme.fg("muted", " local")}${theme.fg("dim", " score 1.000")}${theme.fg("muted", " what tool 0 does")}`,
			`${edge} ${theme.fg("dim", theme.tree.last)} ${theme.fg("accent", "tool 1")}${theme.fg("dim", " score 0.900")}${theme.fg("muted", " what tool 1 does")}`,
		]);
		expect(oracle.slice(1)).toEqual([
			`${edge} ${theme.fg("dim", theme.format.bullet)} ${theme.fg("accent", "tool 0")} ${theme.fg("muted", "local")}${theme.fg("dim", theme.sep.dot)}${theme.fg("dim", "score 1.000")}`,
			`${edge}   ${theme.fg("muted", "what tool 0 does")}`,
			`${edge} ${theme.fg("dim", theme.format.bullet)} ${theme.fg("accent", "tool 1")} ${theme.fg("dim", "score 0.900")}`,
			`${edge}   ${theme.fg("muted", "what tool 1 does")}`,
		]);
	});

	it("exception cell: the held-back count closes the list and leaves the gesture to the host", () => {
		const collapsed = viewLines(found(7), COLLAPSED);
		const oracle = oracleLines(found(7), HOST_COLLAPSED);
		const edge = `${theme.fg("borderMuted", theme.symbol("block.rail"))} `;
		// Five of seven in both arms, and the same count held back. Main wrote the count and the
		// expand hint into a row of its own; the host writes the count on the branch that closes the
		// list, and offers the gesture the way it offers every other card's.
		expect(collapsed).toHaveLength(7);
		expect(oracle).toHaveLength(12);
		expect(collapsed.at(-1)).toBe(
			`${edge} ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "… 2 more tools")}`,
		);
		expect(oracle.at(-1)).toBe(
			`${edge} ${theme.fg("muted", "… 2 more tools")} ${formatExpandHint(theme, false, true)}`,
		);
		// Expanded, neither arm holds anything back, so the list closes on its last match instead.
		const expanded = viewLines(found(7), EXPANDED).map(line => stripVTControlCharacters(line));
		expect(expanded.filter(line => /tool \d+ /u.test(line))).toHaveLength(7);
		expect(expanded.some(line => line.includes("more tools"))).toBe(false);
		expect(oracleLines(found(7), HOST_EXPANDED).some(line => line.includes("more tools"))).toBe(false);
	});

	it("exception cell: a card with no matches indents its message under a header the host cuts", () => {
		for (const [total, message] of [
			[41, "No matching tools found."],
			[0, "No discoverable tools are currently loaded."],
		] as const) {
			const empty = found(0, { total_tools: total });
			const drawn = viewLines(empty, COLLAPSED);
			const oracle = oracleLines(empty, HOST_COLLAPSED);
			// Same warning row and the same sentence in both arms. Main opened a plain text block, so
			// the header wrapped onto a second row and the message started in column zero behind the
			// zero-width runs the wrap had closed; the host cuts the header to the width it has and
			// indents the message under it.
			expect(drawn).toHaveLength(2);
			expect(drawn[1]).toBe(`  ${theme.fg("muted", message)}`);
			expect(oracle).toHaveLength(3);
			expect(stripVTControlCharacters(oracle[2] ?? "")).toBe(message);
			// Given room for the whole row, both arms head the card with the same bytes; at eighty
			// columns main wrapped that row and the host cuts it, which is the difference this pins.
			expect(viewLines(empty, COLLAPSED, 400)[0]).toBe(oracleLines(empty, HOST_COLLAPSED, 400)[0]);
			expect(stripVTControlCharacters(drawn[0] ?? "")).toHaveLength(WIDTH);
		}
	});

	it("exception cell: a card with no details reports the text main reported, indented", () => {
		const cases: Array<{ result: SearchToolBm25ViewResult; text: string }> = [
			{ result: { content: [{ type: "text", text: "discovery off" }] }, text: "discovery off" },
			{ result: { content: [] }, text: "Tool discovery completed" },
			{ result: { content: [{ type: "image" }] }, text: "Tool discovery completed" },
			{
				result: { content: [{ type: "text", text: "x".repeat(TRUNCATE_LENGTHS.LINE + 40) }], isError: true },
				text: truncateToWidth("x".repeat(TRUNCATE_LENGTHS.LINE + 40), TRUNCATE_LENGTHS.LINE),
			},
		];
		for (const { result, text } of cases) {
			const drawn = viewLines(result, COLLAPSED, 400);
			const oracle = oracleLines(result, HOST_COLLAPSED, 400);
			expect(drawn[0]).toBe(oracle[0]);
			expect(drawn[1]).toBe(`  ${theme.fg("dim", text)}`);
			expect(stripVTControlCharacters(oracle[1] ?? "")).toBe(text);
		}
		// A multi-line report keeps every line in both arms, each cut at the same budget.
		const many: SearchToolBm25ViewResult = { content: [{ type: "text", text: "first\nsecond\nthird" }] };
		expect(viewLines(many, COLLAPSED, 400).map(line => stripVTControlCharacters(line).trim())).toEqual([
			"! Tool Discovery",
			"first",
			"second",
			"third",
		]);
		expect(oracleLines(many, HOST_COLLAPSED, 400).map(line => stripVTControlCharacters(line).trim())).toEqual([
			"! Tool Discovery",
			"first",
			"second",
			"third",
		]);
	});
});
