/**
 * The `ast_edit` card draws what main's renderer drew.
 *
 * ONE DIFFERENCE IS ASSERTED AS AN EXCEPTION CELL. The held-back groups, whose count closes the card
 * in the dim the host writes every held-back note in, with the expand gesture the host offers, where
 * main wrote the same sentence in muted and offered nothing.
 * ONE BRANCH IS UNOBSERVABLE RATHER THAN UNTESTED. The row a collapsed card reserves for its
 * held-back note changes nothing at the current budget, since the smallest group the tool writes is
 * three rows and a second group costs seven. Both arms reserve it identically, and the cell asserts
 * the arithmetic, so raising `PREVIEW_LIMITS.COLLAPSED_LINES` turns this red instead of leaving the
 * branch silently uncovered.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatGroupedFiles } from "@veyyon/coding-agent/tools/core/grouped-file-output";
import {
	formatCodeFrameLine,
	formatExpandHint,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
} from "@veyyon/coding-agent/tools/core/render-utils";
import type { AstEditToolDetails } from "@veyyon/coding-agent/tools/search/ast-edit";
import {
	type AstEditViewArgs,
	type AstEditViewResult,
	astEditToolView,
} from "@veyyon/coding-agent/tools/search/ast-edit-view";
import type { ToolViewContext } from "@veyyon/view";
import * as astEditOracle from "../oracles/ast-edit-main-renderer";
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

describe("ast_edit tool differential", () => {
	/**
	 * One file's frame the way the tool writes it: one `formatCodeFrameLine` row per side of the
	 * change, whose marker rides in the gutter the card swaps for a space, which is what decides the
	 * tone of the row. A one-column line number keeps the marker in column zero, as the tool's own
	 * gutter does for a single-digit line.
	 */
	function frame(start: number): string[] {
		return [
			formatCodeFrameLine("-", start, `const before = foo(${start});`, 1),
			formatCodeFrameLine("+", start, `const after = bar(${start});`, 1),
		];
	}

	/**
	 * The display half of the tool's own grouped output for `files`, built by the formatter the tool
	 * builds it with, so the fixture cannot drift from the shape a card splits on: a `#` per nesting
	 * level, and a blank row before every directory header, which is the only place a change group
	 * ends. Trailing notices follow the body after a blank row, where the tool appends them.
	 */
	function grouped(files: string[], notices: string[] = []): string {
		const body = formatGroupedFiles(files, file => {
			const lines = frame(files.indexOf(file) + 1);
			return { headerSuffix: " (1)", modelLines: lines, displayLines: lines };
		}).display;
		return notices.length === 0 ? body.join("\n") : [...body, "", ...notices].join("\n");
	}

	/** `files` files under one `src/` directory: one directory header, one group, nothing held back. */
	function display(files: number, notices: string[] = []): string {
		return grouped(
			Array.from({ length: files }, (_unused, index) => `src/file-${index}.ts`),
			notices,
		);
	}

	/** `count` directories of `filesPer` files: the card splits this into `count` change groups. */
	function dirs(count: number, filesPer: number): string {
		return grouped(
			Array.from({ length: count }, (_unused, dir) =>
				Array.from({ length: filesPer }, (_ignored, file) => `pkg-${dir}/file-${file}.ts`),
			).flat(),
		);
	}

	function details(overrides: Partial<AstEditToolDetails> = {}): AstEditToolDetails {
		return {
			totalReplacements: 4,
			filesTouched: 2,
			filesSearched: 37,
			applied: false,
			limitReached: false,
			scopePath: "src",
			cwd: "/repo",
			searchPath: "/repo/src",
			displayContent: display(2),
			...overrides,
		};
	}

	function result(overrides: Partial<AstEditToolDetails> = {}): AstEditViewResult {
		return { content: [{ type: "text", text: "model facing" }], details: details(overrides) };
	}

	const ARGS: AstEditViewArgs = { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src"] };

	function viewLines(
		value: AstEditViewResult,
		context: ToolViewContext,
		width = WIDTH,
		args: AstEditViewArgs | undefined = ARGS,
	): string[] {
		return renderCompLines(drawToolView(astEditToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: AstEditViewResult,
		options: RenderResultOptions,
		width = WIDTH,
		args: AstEditViewArgs | undefined = ARGS,
	): string[] {
		return renderCompLines(astEditOracle.astEditToolRenderer.renderResult(value, options, theme, args), width);
	}

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: AstEditViewArgs[] = [
			{ ops: [{ pat: "foo($A)", out: "bar($A)" }] },
			{ ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src", "test"] },
			{
				ops: [
					{ pat: "a()", out: "b()" },
					{ pat: "c()", out: "d()" },
				],
				paths: ["src"],
			},
			// A pattern is source text: multi-line and tab-indented, which the row collapses.
			{ ops: [{ pat: "class $_ {\n\tmethod() { $$$B }\n}", out: "x" }] },
			{ ops: [] },
			{},
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(astEditToolView.renderCall(args, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						astEditOracle.astEditToolRenderer.renderCall(args, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the rows compared above carry the pattern with its whitespace collapsed, the
		// scope, and the rewrite count when more than one op was sent.
		const one = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(astEditToolView.renderCall(ARGS, COLLAPSED)), theme), 200).join(""),
		);
		expect(one).toContain("AST Edit: foo($A)");
		expect(one).toContain("in src");
		const many = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(
						astEditToolView.renderCall(
							{
								ops: [
									{ pat: "a()", out: "b()" },
									{ pat: "c()", out: "d()" },
								],
							},
							COLLAPSED,
						),
					),
					theme,
				),
				200,
			).join(""),
		);
		expect(many).toContain("2 rewrites");
		const folded = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(astEditToolView.renderCall({ ops: [{ pat: "class $_ {\n\tm() { $$$B }\n}" }] }, COLLAPSED)),
					theme,
				),
				200,
			).join(""),
		);
		expect(folded).toContain("class $_ { m() { $$$B } }");
		expect(folded).not.toContain("\t");
	});

	it("draws the settled card byte for byte wherever it holds nothing back", () => {
		const cases: Array<Partial<AstEditToolDetails>> = [
			// One group, so a collapsed card shows it whole and keeps nothing back.
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1) },
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1), limitReached: true },
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1), scopePath: undefined },
			{
				totalReplacements: 2,
				filesTouched: 1,
				displayContent: display(1),
				parseErrors: ["a.ts: unexpected token"],
				parseErrorsTotal: 1,
			},
			{ totalReplacements: 1, filesTouched: 1, displayContent: display(1), filesSearched: 0 },
			// A directory header at the scope's own depth, which the card tones and links as a
			// directory rather than as a file.
			{
				totalReplacements: 2,
				filesTouched: 1,
				displayContent: grouped(["deep/nested/leaf.ts"]),
			},
		];
		for (const overrides of cases) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(viewLines(result(overrides), context, width)).toEqual(
						oracleLines(result(overrides), options, width),
					);
				}
			}
		}
		// Every group of a many-group card is byte-identical once expanded, which is where nothing is
		// held back and the whole body is compared.
		for (const width of [200, WIDTH, 40]) {
			const many = result({ displayContent: dirs(9, 1), totalReplacements: 18, filesTouched: 9 });
			expect(viewLines(many, EXPANDED, width)).toEqual(oracleLines(many, HOST_EXPANDED, width));
		}
		// Anti-vacuity: the compared card carries the header's counts and badge, the edited text with
		// its diff markers, and the file header as a hyperlink resolved against the edit's base.
		const drawn = viewLines(result(), EXPANDED, 200);
		const header = stripVTControlCharacters(drawn[0] ?? "");
		expect(header).toContain("AST Edit: foo($A)");
		expect(header).toContain("4 replacements");
		expect(header).toContain("2 files");
		expect(header).toContain("in src");
		expect(header).toContain("searched 37");
		expect(header).toContain("proposed");
		expect(header).not.toContain("limit reached");
		const body = drawn.join("\n");
		expect(stripVTControlCharacters(body)).toContain("-1 const before = foo(1);");
		expect(stripVTControlCharacters(body)).toContain("+1 const after = bar(1);");
		// The file header names the file the change came from, toned as a header below the scope root,
		// and its span carries the resolved path so a host that can open a file has one.
		expect(body).toContain(theme.fg("dim", "## file-0.ts (1)"));
		expect(body).toContain(theme.fg("accent", "# src/"));
		const view = framedView(astEditToolView.renderResult(result(), EXPANDED, ARGS));
		const files = view.sections
			.flatMap(section => section.lines)
			.flatMap(line => line.map(span => span.file))
			.filter((file): file is string => file !== undefined);
		expect(files).toContain("/repo/src/file-0.ts");
		expect(files).toContain("/repo/src");
		// The cap rides on the header only when it was reached, in both arms alike.
		const capped = result({ totalReplacements: 2, filesTouched: 1, displayContent: display(1), limitReached: true });
		expect(stripVTControlCharacters(viewLines(capped, COLLAPSED, 200)[0] ?? "")).toContain("limit reached");
	});

	it("says beside the changes what main said: the cap it hit and what would not parse", () => {
		const value = result({
			totalReplacements: 2,
			filesTouched: 1,
			displayContent: display(1),
			limitReached: true,
			parseErrors: ["a.ts: unexpected token", "b.ts: unexpected token"],
			parseErrorsTotal: 5,
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			expect(viewLines(value, context, 200)).toEqual(oracleLines(value, options, 200));
		}
		// Anti-vacuity: the two asides are there, in the warning tone, below the change lines rather
		// than instead of them.
		const lines = viewLines(value, EXPANDED, 200).map(line => stripVTControlCharacters(line));
		expect(lines.filter(line => line.includes("limit reached; narrow path"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("5 parse issues"))).toHaveLength(1);
		expect(lines.some(line => line.includes("-1 const before = foo(1);"))).toBe(true);
		expect(viewLines(value, EXPANDED, 200).at(-1)).toContain(theme.fg("warning", "5 parse issues"));
	});

	it("drops the trailing notices the tool wrote, in both arms", () => {
		const value = result({
			totalReplacements: 2,
			filesTouched: 1,
			displayContent: display(1, ["Safety cap reached: narrow the path", "Parse issues: 2 files"]),
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			const drawn = viewLines(value, context, 200);
			expect(drawn).toEqual(oracleLines(value, options, 200));
			// Neither arm lists the tool's own trailing notices as a change group, and the change it
			// does list is still there, so the filter is not simply dropping everything.
			const flat = stripVTControlCharacters(drawn.join("\n"));
			expect(flat).not.toContain("Safety cap reached");
			expect(flat).not.toContain("Parse issues: 2 files");
			expect(flat).toContain("## file-0.ts (1)");
			expect(flat).toContain("-1 const before = foo(1);");
		}
	});

	it("reports a result that replaced nothing as the row main reported, framing only parse issues", () => {
		const none: Partial<AstEditToolDetails> = { totalReplacements: 0, filesTouched: 0, displayContent: "" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [WIDTH, 200, 40]) {
				// No parse issues: a lone row in both arms, not a frame around nothing.
				expect(viewLines(result(none), context, width)).toEqual(oracleLines(result(none), options, width));
				// Parse issues: the same bulleted list under the same warning row, capped and counted
				// identically.
				const withErrors = result({
					...none,
					parseErrors: Array.from({ length: 6 }, (_, index) => `file-${index}.ts: unexpected token`),
					parseErrorsTotal: 11,
				});
				expect(viewLines(withErrors, context, width)).toEqual(oracleLines(withErrors, options, width));
				// More issues than the cap: both arms list PARSE_ERRORS_LIMIT of them and count the
				// rest, so a card that stopped capping would draw rows main never drew.
				const overCap = result({
					...none,
					parseErrors: Array.from({ length: PARSE_ERRORS_LIMIT + 2 }, (_, index) => `file-${index}.ts: bad`),
					parseErrorsTotal: PARSE_ERRORS_LIMIT + 9,
				});
				expect(viewLines(overCap, context, width)).toEqual(oracleLines(overCap, options, width));
			}
		}
		// A row is a row: the arm with no parse issues draws one line and opens no frame at all.
		expect(viewLines(result(none), COLLAPSED, 200)).toHaveLength(1);
		// Anti-vacuity: the row says nothing was replaced and how much was searched, and the framed
		// arm lists the capped errors and the count it held back.
		const row = stripVTControlCharacters(viewLines(result(none), COLLAPSED, 200).join("\n"));
		expect(row).toContain("0 replacements");
		expect(row).toContain("searched 37");
		const framed = stripVTControlCharacters(
			viewLines(
				result({ ...none, parseErrors: ["a.ts: bad", "b.ts: bad"], parseErrorsTotal: 7 }),
				COLLAPSED,
				200,
			).join("\n"),
		);
		expect(framed).toContain("- a.ts: bad");
		expect(framed).toContain("… 5 more");
		const capped = stripVTControlCharacters(
			viewLines(
				result({
					...none,
					parseErrors: Array.from({ length: PARSE_ERRORS_LIMIT + 2 }, (_, index) => `file-${index}.ts: bad`),
					parseErrorsTotal: PARSE_ERRORS_LIMIT + 2,
				}),
				COLLAPSED,
				200,
			).join("\n"),
		);
		expect(capped.split("\n").filter(line => line.includes(": bad"))).toHaveLength(PARSE_ERRORS_LIMIT);
		expect(capped).toContain("… 2 more");
	});

	it("exception cell: the held-back groups close the card the way the host closes every card", () => {
		// Nine directories, so the card has nine groups to budget and holds most of them back.
		const value = result({ displayContent: dirs(9, 1), totalReplacements: 18, filesTouched: 9 });
		for (const width of [200, WIDTH, 40]) {
			const drawn = viewLines(value, COLLAPSED, width);
			const oracle = oracleLines(value, HOST_COLLAPSED, width);
			// Same rows, same groups shown, same count held back: the sentence on the last row is the
			// only difference. Main wrote it in muted with no gesture; the host writes it in dim and
			// offers the expand hint every other card offers.
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 8 more changes"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(oracle.at(-1)).toContain(theme.fg("muted", "… 8 more changes"));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// Two groups, the budget fitting one: the second is held back and worded singular.
		const pair = result({ displayContent: dirs(2, 1), totalReplacements: 4, filesTouched: 2 });
		expect(viewLines(pair, COLLAPSED, 200).at(-1)).toContain(theme.fg("dim", "… 1 more change"));
		expect(oracleLines(pair, HOST_COLLAPSED, 200).at(-1)).toContain(theme.fg("muted", "… 1 more change"));
		// The row the note reserves cannot change what a card shows at the current budget: the
		// smallest group the tool writes is a root-level file header and the two sides of one change,
		// so a second group costs 3 + 1 + 3 rows and overruns COLLAPSED_CHANGE_LIMIT whether or not
		// the note's row is reserved. Raising the budget makes that arithmetic reachable and this
		// suite blind to it, which is what this assertion goes red for.
		expect(PREVIEW_LIMITS.COLLAPSED_LINES * 2).toBeLessThan(3 + 1 + 3);
		// Expanded, neither arm holds anything back and neither writes the sentence.
		expect(stripVTControlCharacters(viewLines(value, EXPANDED, 200).join("\n"))).not.toContain("more changes");
		expect(stripVTControlCharacters(oracleLines(value, HOST_EXPANDED, 200).join("\n"))).not.toContain("more changes");
	});

	it("draws an error card with exact byte parity, for single-line and multi-line errors", () => {
		for (const width of [200, WIDTH, 40]) {
			const single: AstEditViewResult = {
				content: [{ type: "text", text: "pattern did not parse" }],
				isError: true,
			};
			expect(viewLines(single, COLLAPSED, width)).toEqual(oracleLines(single, HOST_COLLAPSED, width));

			const many: AstEditViewResult = { content: [{ type: "text", text: "first\nsecond" }], isError: true };
			expect(viewLines(many, COLLAPSED, width)).toEqual(oracleLines(many, HOST_COLLAPSED, width));
		}
		// A failure with no text at all still names the failure in both arms, byte for byte.
		const bare: AstEditViewResult = { content: [], isError: true };
		expect(viewLines(bare, COLLAPSED, 200)).toEqual(oracleLines(bare, HOST_COLLAPSED, 200));
		expect(stripVTControlCharacters(viewLines(bare, COLLAPSED, 200).join("\n"))).toContain("Unknown error");
	});
});
