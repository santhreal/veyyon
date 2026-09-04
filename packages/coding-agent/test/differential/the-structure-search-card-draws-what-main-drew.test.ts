/**
 * The `structure_search` card draws what main's renderer drew.
 *
 * THREE DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The empty answer, whose rows carry their own
 * two-column indent and open only the colour runs they use, where main joined pre-coloured strings
 * into one `Text` and left each row in column zero behind the zero-width runs its neighbours had
 * closed. The rail, quieted for the reason `file_search`'s and `text_search`'s are: the cap stays in
 * the words on the rows, which are byte-identical, and in the view's own `state`, which a second host
 * reads. And the held-back count, which closes the card in the same dim main wrote it in and adds the
 * expand gesture the host offers on every other card.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
} from "@veyyon/coding-agent/tools/core/render-utils";
import {
	COLLAPSED_MATCH_LIMIT,
	type StructureSearchDetails,
	type StructureSearchRenderArgs,
} from "@veyyon/coding-agent/tools/search/structure-search";
import {
	type StructureSearchViewResult,
	structureSearchToolView,
} from "@veyyon/coding-agent/tools/search/structure-search-view";
import type { ToolViewContext } from "@veyyon/view";
import * as structureSearchOracle from "../oracles/structure-search-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	framedView,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	lineView,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("structure_search tool differential", () => {
	const rail = (): string => theme.symbol("block.rail");

	/** The oracle's rail run rewritten to the colour the host's reduction paints. */
	function quietRail(lines: readonly string[], from: ThemeColor = "dim"): string[] {
		return lines.map(line => line.replace(theme.fg(from, rail()), theme.fg("borderMuted", rail())));
	}

	/** The spaces a frame pads a row with, dropped, for a card the host's hint made wider. */
	function withoutFramePad(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +\u001b\[49m$/, "\u001b[49m"));
	}

	/**
	 * The expand gesture the host closes a held-back note with, dropped.
	 *
	 * The count itself is main's, so a cell that is about the COUNT compares the rest of the row: main
	 * wrote the same words in the same dim and offered nothing after them.
	 */
	function withoutExpandHint(lines: readonly string[]): string[] {
		const hint = ` ${formatExpandHint(theme, false, true)}`;
		return lines.map(line => line.replace(hint, ""));
	}

	/**
	 * Every colour sequence that paints nothing, removed.
	 *
	 * Main joined pre-coloured strings into one `Text`, so a row carries the runs its neighbours opened
	 * and closed with no character between them. Nothing on any terminal draws differently for them.
	 */
	function withoutEmptyRuns(lines: readonly string[]): string[] {
		const sequence = /\u001b\[(?:38;2;\d+;\d+;\d+|39)m/g;
		return lines.map(line => {
			let out = "";
			let cursor = 0;
			let open: string | undefined;
			for (const match of line.matchAll(sequence)) {
				const text = line.slice(cursor, match.index);
				cursor = match.index + match[0].length;
				if (text.length > 0) {
					out += `${open ?? ""}${text}`;
					open = undefined;
				}
				if (match[0] === "\u001b[39m") {
					if (text.length > 0) out += match[0];
					open = undefined;
					continue;
				}
				open = match[0];
			}
			return `${out}${open ?? ""}${line.slice(cursor)}`;
		});
	}

	function viewLines(
		value: StructureSearchViewResult,
		context: ToolViewContext,
		args: StructureSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(structureSearchToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: StructureSearchViewResult,
		options: RenderResultOptions,
		args: StructureSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		// The oracle took the tool's whole result shape, where a view narrows it to what a card reads:
		// the content of a result that carries none is the empty list the tool would have sent.
		const whole = { content: value.content ?? [], details: value.details, isError: value.isError };
		return renderCompLines(
			structureSearchOracle.structureSearchRenderer.renderResult(whole, options, theme, args),
			width,
		);
	}

	/** A result carrying the counts every structure card reads, with the branch under test set. */
	function detailed(details: Partial<StructureSearchDetails>): StructureSearchViewResult {
		return {
			content: [{ type: "text", text: "" }],
			details: { matchCount: 0, fileCount: 0, filesSearched: 0, limitReached: false, ...details },
		};
	}

	/**
	 * A call whose arguments have not arrived.
	 *
	 * `StructureSearchRenderArgs` states the pattern, and a streamed call row is drawn before the model
	 * has sent one, so both arms are asked for the row of a call with nothing in it. The cast is the
	 * point of the case rather than a way around the type.
	 */
	const NO_ARGS = {} as StructureSearchRenderArgs;

	/** One matched node under its file, under the directory that holds it. */
	const GROUPED = ["# src/", "## a.ts", "  *12│const needle = true;", "", "## b.ts", "  *7│const needle = 2;"].join(
		"\n",
	);

	/** Groups of the shape the tool writes, one matched node each, for the budget cells. */
	function groupsOf(count: number): string {
		return Array.from({ length: count }, (_unused, index) =>
			["# src/", `## f${index}.ts`, `  *${index + 1}│const needle = ${index};`].join("\n"),
		).join("\n\n");
	}

	/**
	 * Groups of a file header and one matched node, for the cell about where the budget is spent.
	 *
	 * Two rows rather than three, so the notes' two rows change how many groups fit: at a three-row
	 * group the same two notes take the count from one group to one group, which would leave the cell
	 * green whatever the order.
	 */
	function flatGroupsOf(count: number): string {
		return Array.from({ length: count }, (_unused, index) =>
			[`## f${index}.ts`, `  *${index + 1}│const needle = ${index};`].join("\n"),
		).join("\n\n");
	}

	it("draws the pending call row byte for byte", () => {
		const calls: StructureSearchRenderArgs[] = [
			{ input: "$A()" },
			{ input: "$A()", path: "src" },
			// Two scopes arrive as the JSON-encoded string the tool's own schema takes, since `path` is
			// one string and `toPathList` is what splits it.
			{ input: "$A()", path: '["src", "docs"]' },
			{ input: "$A()", skip: 5 },
			// `skip: 0` is not a narrowing, so neither arm says it.
			{ input: "$A()", skip: 0 },
			{ input: "$A()", path: "src", skip: 2 },
			// A pattern the model sent empty, and a call with nothing in it at all: both rows say what
			// the search is for rather than naming nothing, which is the case a `??` in place of the
			// `||` changes.
			{ input: "" },
			NO_ARGS,
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(
						drawToolView(lineView(structureSearchToolView.renderCall(args, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						structureSearchOracle.structureSearchRenderer.renderCall(args, options, theme),
						width,
					);
					expect(oracle).toEqual(drawn);
				}
			}
		}
		// Anti-vacuity: the row carries the tool's title, the pattern and each narrowing the call asked
		// for, and a call with no pattern still says it is a structure search.
		const narrowed = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(structureSearchToolView.renderCall({ input: "$A()", path: "src", skip: 2 }, COLLAPSED)),
					theme,
				),
				200,
			).join(""),
		);
		expect(narrowed).toContain("Search structure: $A()");
		expect(narrowed).toContain("in src");
		expect(narrowed).toContain("skip:2");
		const bare = stripVTControlCharacters(
			renderCompLines(
				drawToolView(lineView(structureSearchToolView.renderCall(NO_ARGS, COLLAPSED)), theme),
				200,
			).join(""),
		);
		expect(bare).toContain("Search structure: ?");
		expect(bare).not.toContain("skip:");
	});

	it("names a failure in main's words, byte for byte", () => {
		const failures: StructureSearchViewResult[] = [
			{ content: [{ type: "text", text: "pattern refused to parse" }], isError: true },
			// A failure the tool reported with no message: both arms name it.
			{ content: [], isError: true },
			{ content: [{ type: "text", text: "" }], isError: true },
			// A message carrying a tab and a newline, which both arms flatten the same way.
			{ content: [{ type: "text", text: "bad\tpattern\nsecond line" }], isError: true },
			// A message the provider already opened with the word the card prepends, which neither arm
			// says twice, and one that is only whitespace, which both arms name instead.
			{ content: [{ type: "text", text: "Error: pattern refused to parse" }], isError: true },
			{ content: [{ type: "text", text: "   \t  " }], isError: true },
			{ content: [{ type: "text", text: "  padded on both sides  " }], isError: true },
			// A message that names a path under the home directory, which neither arm leaks, and one
			// longer than a row's budget, which both arms cut at the same column.
			{
				content: [{ type: "text", text: `cannot read ${join(homedir(), "repo", "src", "a.ts")}` }],
				isError: true,
			},
			{ content: [{ type: "text", text: `refused: ${"pattern ".repeat(120)}` }], isError: true },
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(oracleLines(value, options, { input: "$A()" }, width)).toEqual(
						viewLines(value, context, { input: "$A()" }, width),
					);
				}
			}
		}
		// Anti-vacuity: the row says which failure it was, and a failure with no message still names one.
		expect(viewLines(failures[0]!, COLLAPSED, { input: "$A()" }, 200)[0]).toContain(
			theme.fg("error", "Error: pattern refused to parse"),
		);
		expect(stripVTControlCharacters(viewLines(failures[1]!, COLLAPSED, { input: "$A()" }, 200).join(""))).toContain(
			"Unknown error",
		);
		// The card sanitizes what it was handed: the word is said once, the home directory never
		// reaches the row, and a message past the row's budget is cut to it.
		const said = stripVTControlCharacters(viewLines(failures[4]!, COLLAPSED, { input: "$A()" }, 200).join(""));
		expect(said).toContain("Error: pattern refused to parse");
		expect(said).not.toContain("Error: Error:");
		expect(stripVTControlCharacters(viewLines(failures[5]!, COLLAPSED, { input: "$A()" }, 200).join(""))).toContain(
			"Unknown error",
		);
		const homed = stripVTControlCharacters(viewLines(failures[7]!, COLLAPSED, { input: "$A()" }, 200).join(""));
		expect(homed).not.toContain(homedir());
		expect(homed).toContain("~/repo/src/a.ts");
		const long = stripVTControlCharacters(viewLines(failures[8]!, COLLAPSED, { input: "$A()" }, 400).join(""));
		expect(long.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE + "  Error: ".length + 4);
	});

	it("exception cell: an empty answer indents its rows under the head row it kept", () => {
		const cases: Array<{ details: Partial<StructureSearchDetails>; args: StructureSearchRenderArgs | undefined }> = [
			{ details: {}, args: { input: "$A()" } },
			{ details: {}, args: undefined },
			{ details: {}, args: { input: "" } },
			{ details: { filesSearched: 12 }, args: { input: "$A()" } },
			{ details: { scopePath: "src", filesSearched: 12 }, args: { input: "$A()" } },
			// A query that could not be parsed anywhere it ran: the card says the query may be
			// mis-scoped and lists what failed, capped, with the rest counted.
			{ details: { filesSearched: 3, parseErrors: ["src/a.ts: unexpected token"] }, args: { input: "$A()" } },
			{
				details: {
					filesSearched: 40,
					parseErrors: Array.from({ length: 25 }, (_unused, index) => `src/f${index}.ts: unexpected token`),
					parseErrorsTotal: 31,
				},
				args: { input: "$A()" },
			},
		];
		for (const { details, args } of cases) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					const drawn = viewLines(detailed(details), context, args, width);
					const oracle = withoutEmptyRuns(oracleLines(detailed(details), options, args, width));
					expect(drawn).toHaveLength(oracle.length);
					// The head row is the same row. Every row under it is the same row indented two
					// columns under that head, where main left it in column zero behind the zero-width
					// runs its neighbours had closed.
					expect(drawn[0]).toBe(oracle[0]);
					for (let row = 1; row < oracle.length; row++) expect(drawn[row]).toBe(`  ${oracle[row]}`);
				}
			}
		}
		// Anti-vacuity: the card counts zero, says how many files it read, and says what it could not
		// parse rather than reporting absence alone.
		const flat = stripVTControlCharacters(
			viewLines(
				detailed({ filesSearched: 3, parseErrors: ["src/a.ts: unexpected token"] }),
				COLLAPSED,
				{ input: "$A()" },
				200,
			).join("\n"),
		);
		expect(flat).toContain("0 matches");
		expect(flat).toContain("searched 3");
		expect(flat).toContain("No matches found");
		expect(flat).toContain("Query may be mis-scoped");
		expect(flat).toContain("- src/a.ts: unexpected token");
		// The cap is main's: twenty listed and the rest counted.
		const capped = stripVTControlCharacters(
			viewLines(
				detailed({
					filesSearched: 40,
					parseErrors: Array.from({ length: 25 }, (_unused, index) => `src/f${index}.ts: unexpected token`),
					parseErrorsTotal: 31,
				}),
				COLLAPSED,
				{ input: "$A()" },
				200,
			).join("\n"),
		);
		expect(capped).toContain("src/f19.ts");
		expect(capped).not.toContain("src/f20.ts");
		expect(capped).toContain("… 11 more");
	});

	it("draws the grouped body of a matched result byte for byte, rail apart", () => {
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			filesSearched: 10,
			cwd: "/repo",
			scopePath: "src",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH, 40]) {
				expect(quietRail(oracleLines(value, options, args, width))).toEqual(viewLines(value, context, args, width));
			}
		}
		// The rail is the block's default in one arm and the host's quiet edge in the other.
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[1]).toContain(theme.fg("dim", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[1]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row counts matches and files, states the scope and how many files were
		// read, and the body carries every matched node.
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("2 matches");
		expect(expanded).toContain("2 files");
		expect(expanded).toContain("in src");
		expect(expanded).toContain("searched 10");
		expect(expanded).toContain("const needle = true;");
		expect(expanded).toContain("const needle = 2;");
		// A nested file header is dimmed and a directory header accented, and a matched node is
		// indented under the header that opened its group.
		const rows = framedView(structureSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(rows[0]?.[0]).toMatchObject({ text: "# src/", tone: "accent" });
		expect(rows[1]?.[0]).toMatchObject({ text: "  " });
		expect(rows[1]?.[1]).toMatchObject({ text: "## a.ts", tone: "dim" });
	});

	it("holds whole groups back, closing the card with the gesture main offered nothing for", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		// Ten three-row groups against a six-row budget: one whole group fits, because a second costs
		// six rows and the reserved note row leaves five, which is the branch a per-row budget would
		// draw differently.
		const value = detailed({
			matchCount: 10,
			fileCount: 10,
			filesSearched: 20,
			cwd: "/repo",
			displayContent: groupsOf(10),
		});
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Exception: main wrote the count with no gesture; the host writes the same count in the
			// same dim and offers the expand hint it offers on every other card.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 9 more matches"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 9 more matches"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
			// Expanded holds nothing back, so every row of every group is compared.
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
		}
		// Anti-vacuity: the collapsed card is the head row, one whole group and the note, and the group
		// the budget stopped at appears in neither of its rows. The arithmetic is pinned, so raising
		// `PREVIEW_LIMITS.COLLAPSED_LINES` turns the cell red instead of silently changing the card.
		expect(COLLAPSED_MATCH_LIMIT).toBe(PREVIEW_LIMITS.COLLAPSED_LINES * 2);
		expect(COLLAPSED_MATCH_LIMIT).toBe(6);
		const collapsed = viewLines(value, COLLAPSED, args, 200);
		expect(collapsed).toHaveLength(1 + 3 + 1);
		const flat = stripVTControlCharacters(collapsed.join("\n"));
		expect(flat).toContain("const needle = 0;");
		expect(flat).not.toContain("f1.ts");
		expect(flat).not.toContain("const needle = 1;");
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("const needle = 9;");
		expect(expanded).not.toContain("more matches");
		// A group wider than the whole budget: the reserved row is what makes the note fit anyway, so
		// the card says what it held back rather than drawing an empty body.
		const oversized = detailed({
			matchCount: 8,
			fileCount: 2,
			filesSearched: 2,
			cwd: "/repo",
			displayContent: [
				["## a.ts", ...Array.from({ length: 6 }, (_unused, row) => `  *${row + 1}│const needle = ${row};`)].join(
					"\n",
				),
				["## b.ts", "  *9│const needle = 9;"].join("\n"),
			].join("\n\n"),
		});
		const held = withoutFramePad(withoutExpandHint(viewLines(oversized, COLLAPSED, args, 200)));
		expect(held).toEqual(withoutFramePad(quietRail(oracleLines(oversized, HOST_COLLAPSED, args, 200))));
		expect(held).toHaveLength(2);
		expect(stripVTControlCharacters(held[1] ?? "")).toContain("… 2 more matches");
		expect(stripVTControlCharacters(held.join("\n"))).not.toContain("a.ts");
	});

	it("says on its own rows what a capped search cut and what it could not parse", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		const capped = detailed({
			matchCount: 10,
			fileCount: 10,
			filesSearched: 20,
			limitReached: true,
			cwd: "/repo",
			// The tool writes its own notice group into the output; the card states it in its own words
			// and never counts it as a match.
			displayContent: [groupsOf(3), "Match limit reached: 30 found, 10 returned. Use skip=10."].join("\n\n"),
		});
		const withParseErrors = detailed({
			matchCount: 2,
			fileCount: 2,
			filesSearched: 20,
			cwd: "/repo",
			displayContent: [GROUPED, "Parse issues:", "  - src/broken.ts: unexpected token"].join("\n\n"),
			parseErrors: ["src/broken.ts: unexpected token"],
			parseErrorsTotal: 4,
		});
		for (const value of [capped, withParseErrors]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					// Main painted the whole rail in warning on the capped card, because the block
					// derives its edge from the state. The host keeps the quiet edge and the card states
					// the outcome in the words on its rows, which are byte-identical.
					const drawn = withoutFramePad(withoutExpandHint(viewLines(value, context, args, width)));
					const oracle = withoutFramePad(
						quietRail(oracleLines(value, options, args, width), value === capped ? "warning" : "dim"),
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		expect(oracleLines(capped, HOST_EXPANDED, args, 200)[1]).toContain(theme.fg("warning", rail()));
		expect(viewLines(capped, EXPANDED, args, 200)[1]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row marks the cap, the last row says how to page past it, and the
		// notice the tool wrote into the output is not drawn as a match group.
		const drawnCapped = viewLines(capped, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawnCapped[0] ?? "")).toContain("limit reached");
		expect(drawnCapped.at(-1)).toContain(theme.fg("warning", "limit reached; page with skip or narrow path"));
		expect(stripVTControlCharacters(drawnCapped.join("\n"))).not.toContain("Match limit reached: 30 found");
		// A card with matches counts what it could not parse instead of listing it, and the list the
		// tool wrote into the output is not a match group either.
		const drawnParse = viewLines(withParseErrors, EXPANDED, args, 200);
		expect(drawnParse.at(-1)).toContain(theme.fg("warning", "4 parse issues"));
		expect(stripVTControlCharacters(drawnParse.join("\n"))).not.toContain("Parse issues:");
		// The state is the card's own claim rather than a colour: on this preset a warning frame and a
		// success frame draw the same quiet rail, so a host that reads the view is the only reader that
		// can tell them apart.
		expect(framedView(structureSearchToolView.renderResult(capped, EXPANDED, args)).state).toBe("warning");
		expect(framedView(structureSearchToolView.renderResult(withParseErrors, EXPANDED, args)).state).toBe("success");
	});

	it("spends the budget on its notes before its groups, as main spent it", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		// Four two-row groups with both notes, which cost the body two rows before the groups are
		// measured against the six-row budget: the card draws one group where it draws two without them.
		const noted = detailed({
			matchCount: 4,
			fileCount: 4,
			filesSearched: 20,
			limitReached: true,
			cwd: "/repo",
			displayContent: flatGroupsOf(4),
			parseErrors: ["src/broken.ts: unexpected token"],
		});
		for (const width of [200, WIDTH]) {
			expect(withoutFramePad(withoutExpandHint(viewLines(noted, COLLAPSED, args, width)))).toEqual(
				withoutFramePad(quietRail(oracleLines(noted, HOST_COLLAPSED, args, width), "warning")),
			);
		}
		// Head row, one group's two rows, the held-back note, and the two notes.
		const rows = viewLines(noted, COLLAPSED, args, 200);
		expect(rows).toHaveLength(1 + 2 + 1 + 2);
		expect(rows.at(-3)).toContain(theme.fg("dim", "… 3 more matches"));
		expect(rows.at(-2)).toContain(theme.fg("warning", "limit reached; page with skip or narrow path"));
		expect(rows.at(-1)).toContain(theme.fg("warning", "1 parse issue"));
		// Without the notes the same groups draw one group more, which is what makes the ORDER the thing
		// under test rather than the group count: a budget spent on the groups first would keep two here
		// and two above.
		const unnoted = detailed({
			matchCount: 4,
			fileCount: 4,
			filesSearched: 20,
			cwd: "/repo",
			displayContent: flatGroupsOf(4),
		});
		const unnotedRows = viewLines(unnoted, COLLAPSED, args, 200);
		expect(unnotedRows).toHaveLength(1 + 4 + 1);
		expect(unnotedRows.at(-1)).toContain(theme.fg("dim", "… 2 more matches"));
		expect(withoutFramePad(withoutExpandHint(unnotedRows))).toEqual(
			withoutFramePad(quietRail(oracleLines(unnoted, HOST_COLLAPSED, args, 200))),
		);
	});

	it("states for a second host what each row of a structure search points at, and opens the same links", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			filesSearched: 4,
			cwd: "/repo",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const rows = framedView(structureSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(rows[0]?.[0]).toMatchObject({ file: "/repo/src", tone: "accent" });
		expect(rows[1]?.[1]).toMatchObject({ file: "/repo/src/a.ts", tone: "dim" });
		// A matched node names no target of its own: the tool writes the position into the row's text
		// and the card resolves the file on the header above it, which is what main linked too.
		const body = rows.find(row =>
			row
				.map(span => span.text)
				.join("")
				.includes("const needle = true;"),
		);
		expect(body?.at(-1)?.file).toBeUndefined();
		// A meta row is an aside rather than matched source, which a host reads off the tone.
		const withMeta = detailed({
			matchCount: 1,
			fileCount: 1,
			filesSearched: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", "  *12│const needle = true;", "  meta: name=needle"].join("\n"),
		});
		const metaRows =
			framedView(structureSearchToolView.renderResult(withMeta, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(metaRows.at(-1)?.at(-1)).toMatchObject({ text: "  meta: name=needle", tone: "dim" });
		// With hyperlinks on, the rows carry the OSC 8 targets main's own body carried.
		settings.override("tui.hyperlinks", "always");
		try {
			for (const width of [200, WIDTH]) {
				for (const shape of [value, withMeta]) {
					expect(quietRail(oracleLines(shape, HOST_EXPANDED, args, width))).toEqual(
						viewLines(shape, EXPANDED, args, width),
					);
				}
			}
			expect(viewLines(value, EXPANDED, args, 200)[2]).toContain("file:///repo/src/a.ts");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("expands a tab and cuts a row too long for the frame where main cut it", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		const tabbed = detailed({
			matchCount: 2,
			fileCount: 1,
			filesSearched: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", "  *12│const needle =\tfalse;", "  *13│const other =\t3;"].join("\n"),
		});
		const long = detailed({
			matchCount: 1,
			fileCount: 1,
			filesSearched: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", `  *12│const needle = "${"x".repeat(300)}";`].join("\n"),
		});
		for (const value of [tabbed, long]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40] as const) {
					expect(quietRail(oracleLines(value, options, args, width))).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		// Anti-vacuity: a tab is spaces rather than a hole in the row.
		const drawnTabs = viewLines(tabbed, EXPANDED, args, 200);
		expect(drawnTabs.join("")).not.toContain("\t");
		expect(stripVTControlCharacters(drawnTabs.join("\n"))).toContain(replaceTabs("  *12│const needle =\tfalse;"));
		// And a body row wider than the frame ends at the frame rather than wrapping onto a second row:
		// the card is its header, the group's header and one body row. The head row is main's own
		// overflow, which the frame does not clip on either arm, so the claim is about the body.
		const cut = viewLines(long, EXPANDED, args, 40);
		expect(cut).toHaveLength(3);
		for (const row of cut.slice(1)) expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(40);
		expect(stripVTControlCharacters(cut.join("\n"))).not.toContain("x".repeat(300));
	});

	it("reads the text the tool sent when it wrote no display content", () => {
		const args: StructureSearchRenderArgs = { input: "const $A = $_" };
		// The card prefers `displayContent` and falls back to the model-facing text, which is the
		// branch a result that predates the display channel takes.
		const textOnly: StructureSearchViewResult = {
			content: [{ type: "text", text: GROUPED }],
			details: { matchCount: 2, fileCount: 2, filesSearched: 4, limitReached: false, cwd: "/repo" },
		};
		// Neither channel: the card is its head row and nothing under it.
		const empty: StructureSearchViewResult = {
			content: [],
			details: { matchCount: 1, fileCount: 1, filesSearched: 1, limitReached: false },
		};
		for (const value of [textOnly, empty]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					expect(quietRail(oracleLines(value, options, args, width))).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		// Anti-vacuity: the fallback draws the groups, and the card with neither channel draws no body.
		expect(stripVTControlCharacters(viewLines(textOnly, EXPANDED, args, 200).join("\n"))).toContain(
			"const needle = true;",
		);
		expect(viewLines(empty, EXPANDED, args, 200)).toHaveLength(1);
	});
});
