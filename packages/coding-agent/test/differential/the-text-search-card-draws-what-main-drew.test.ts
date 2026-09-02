/**
 * The `text_search` card draws what main's renderer drew.
 *
 * FOUR DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The call row, the failure row and the text-only
 * empty row, which main built with `new Text(text, 1, 0)` and which lose that one-column pad. The
 * card with no matches, whose head row keeps the pad while every row under it moves two columns in,
 * where main joined the header and the message into one `Text` and left the message in column zero.
 * The rail, quieted for the reason `file_search`'s is, leaving the outcome in the words on the rows,
 * which are byte-identical. And the held-back count, which the host closes the card with in the same
 * dim main wrote it in, plus the expand gesture, where main wrote the count alone; the unit is main's
 * -- matches for an ordinary search, files for a paths-only one, and rows when the output marked no
 * match line.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import { LocalProtocolHandler } from "@veyyon/coding-agent/internal-urls/local-protocol";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatExpandHint, replaceTabs } from "@veyyon/coding-agent/tools/core/render-utils";
import {
	COLLAPSED_TEXT_LIMIT,
	EXPANDED_TEXT_LIMIT,
	type TextSearchDetails,
	type TextSearchRenderArgs,
} from "@veyyon/coding-agent/tools/search/text-search";
import { type TextSearchViewResult, textSearchToolView } from "@veyyon/coding-agent/tools/search/text-search-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as textSearchOracle from "../oracles/text-search-main-renderer";
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

describe("text_search tool differential", () => {
	const rail = (): string => theme.symbol("block.rail");

	/** Main's `new Text(text, 1, 0)` indent, dropped: the pad is the whole of the difference. */
	function unpad(lines: readonly string[]): string[] {
		return lines.map(line => (line.startsWith(" ") ? line.slice(1) : line));
	}

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
	 * Exception 35 is the gesture alone, so a cell that is about the COUNT compares the rest of the
	 * row: main wrote the same count in the same dim and offered nothing after it. Pair with
	 * `withoutFramePad`, since dropping the gesture leaves the row shorter than the frame padded it.
	 */
	function withoutExpandHint(lines: readonly string[]): string[] {
		const hint = ` ${formatExpandHint(theme, false, true)}`;
		return lines.map(line => line.replace(hint, ""));
	}
	/**
	 * Every colour sequence that paints nothing, removed.
	 *
	 * Main joined pre-coloured strings into one `Text`, so a row carries the runs its neighbours opened
	 * and closed with no character between them. Nothing on any terminal draws differently for them,
	 * and a pass over the row is exact where a regex is not: an open followed straight by a reset
	 * paints nothing, and a reset with no open before it closes nothing.
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
		value: TextSearchViewResult,
		context: ToolViewContext,
		args: TextSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(textSearchToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: TextSearchViewResult,
		options: RenderResultOptions,
		args: TextSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		// The oracle took the tool's whole result shape, where a view narrows it to what a card reads:
		// the content of a result that carries none is the empty list the tool would have sent.
		const whole = { content: value.content ?? [], details: value.details, isError: value.isError };
		return renderCompLines(textSearchOracle.textSearchRenderer.renderResult(whole, options, theme, args), width);
	}

	/** A result the tool described with counts, which is the card that frames grouped output. */
	function detailed(details: Partial<TextSearchDetails>): TextSearchViewResult {
		return { content: [{ type: "text", text: "" }], details: { matchCount: 0, fileCount: 0, ...details } };
	}

	/**
	 * A call whose arguments have not arrived.
	 *
	 * `TextSearchRenderArgs` states the pattern, and a streamed call row is drawn before the model has
	 * sent one, so both arms are asked for the row of a call with nothing in it. The cast is the point
	 * of the case rather than a way around the type.
	 */
	const NO_ARGS = {} as TextSearchRenderArgs;

	/** Two files under one directory, which is the shape the tool writes for a multi-file search. */
	const GROUPED = [
		"# src/",
		"## a.ts",
		" 11│const before = 1;",
		"*12│const needle = true;",
		" 13│const after = 3;",
		"",
		"## b.ts",
		"*7│const needle = 2;",
	].join("\n");

	it("exception cell: draws the pending call row in the column its siblings draw in", () => {
		const calls: Array<TextSearchRenderArgs | undefined> = [
			{ input: "needle" },
			{ input: "needle", path: "src" },
			// Two scopes arrive as the JSON-encoded string the tool's own schema takes, since `path` is
			// one string and `toPathList` is what splits it.
			{ input: "needle", path: '["src", "docs"]' },
			{ input: "needle", case: false },
			{ input: "needle", gitignore: false },
			{ input: "needle", skip: 5 },
			// `skip: 0` is not a narrowing, so neither arm says it.
			{ input: "needle", skip: 0 },
			{ input: "needle", path: "src", case: false, gitignore: false, skip: 2 },
			// A pattern the model sent empty, and a call with no arguments at all: both rows say what
			// the search is for rather than naming nothing, which is the case a `??` in place of the
			// `||` changes.
			{ input: "" },
			// A call with no arguments at all, which is the row a host draws before the model has sent
			// any: the type states the pattern, and a streamed call has not carried one yet.
			NO_ARGS,
			undefined,
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(
						drawToolView(lineView(textSearchToolView.renderCall(args ?? NO_ARGS, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						textSearchOracle.textSearchRenderer.renderCall(args ?? NO_ARGS, options, theme),
						width,
					);
					expect(unpad(oracle)).toEqual(drawn);
				}
			}
		}
		// The pad is real in one arm and absent in the other, so the cell above is not comparing two
		// unpadded rows.
		const padded = renderCompLines(
			textSearchOracle.textSearchRenderer.renderCall({ input: "needle" }, HOST_COLLAPSED, theme),
			200,
		);
		expect(padded[0]!.startsWith(" ")).toBe(true);
		const flush = renderCompLines(
			drawToolView(lineView(textSearchToolView.renderCall({ input: "needle" }, COLLAPSED)), theme),
			200,
		);
		expect(flush[0]!.startsWith(" ")).toBe(false);
		// Anti-vacuity: the row carries the tool's title, the pattern, and each narrowing the call
		// asked for, and a call with no pattern still says it is a search.
		const narrowed = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(
						textSearchToolView.renderCall(
							{ input: "needle", path: "src", case: false, gitignore: false, skip: 2 },
							COLLAPSED,
						),
					),
					theme,
				),
				200,
			).join(""),
		);
		expect(narrowed).toContain("Search text: needle");
		expect(narrowed).toContain("in src");
		expect(narrowed).toContain("case:insensitive");
		expect(narrowed).toContain("gitignore:false");
		expect(narrowed).toContain("skip:2");
		const bare = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(textSearchToolView.renderCall(NO_ARGS, COLLAPSED)), theme), 200).join(
				"",
			),
		);
		expect(bare).toContain("Search text: ?");
		expect(bare).not.toContain("skip:");
	});

	it("exception cell: names a failure in main's words, one column left of them", () => {
		const failures: TextSearchViewResult[] = [
			{ content: [{ type: "text", text: "regex refused to compile" }], isError: true },
			{ content: [], details: { error: "bad pattern" } },
			// A failure the tool reported with neither a message nor details: both arms name it.
			{ content: [], isError: true },
			// Both channels at once: the details win in both arms.
			{ content: [{ type: "text", text: "content text" }], details: { error: "details error" }, isError: true },
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "needle" }, width))).toEqual(
						viewLines(value, context, { input: "needle" }, width),
					);
				}
			}
		}
		// Anti-vacuity: the row says which failure it was, and the details beat the content text
		// rather than being appended to it.
		const drawn = viewLines(failures[3]!, COLLAPSED, { input: "needle" }, 200);
		expect(drawn[0]).toContain(theme.fg("error", "Error: details error"));
		expect(stripVTControlCharacters(drawn.join(""))).not.toContain("content text");
		expect(stripVTControlCharacters(viewLines(failures[2]!, COLLAPSED, { input: "x" }, 200).join(""))).toContain(
			"Unknown error",
		);
	});

	it("exception cell: states a text-only empty answer where main stated it", () => {
		const empties: TextSearchViewResult[] = [
			{ content: [{ type: "text", text: "No matches found" }] },
			{ content: [{ type: "text", text: "" }] },
			{ content: [] },
			{ content: [{ type: "text", text: "" }], details: { displayContent: "No matches found" } },
		];
		for (const value of empties) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "needle" }, width))).toEqual(
						viewLines(value, context, { input: "needle" }, width),
					);
				}
			}
		}
		// Anti-vacuity: one row, the warning mark, and the words main wrote.
		const drawn = viewLines(empties[0]!, COLLAPSED, { input: "needle" }, 200);
		expect(drawn).toHaveLength(1);
		expect(drawn[0]).toContain(theme.fg("muted", "No matches found"));
	});

	it("lists the lines of a text-only result byte for byte inside the rail the host quiets", () => {
		const lines = Array.from({ length: 12 }, (_unused, index) => `hit ${index}\tafter a tab`);
		const value: TextSearchViewResult = { content: [{ type: "text", text: lines.join("\n") }] };
		const args: TextSearchRenderArgs = { input: "hit" };
		for (const width of [200, WIDTH, 40]) {
			// Expanded holds nothing back, so every row of the body is compared.
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
			// Collapsed shows the same rows and holds the same count back; only the note differs.
			const drawn = withoutFramePad(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Exception: main wrote the count with no gesture; the host writes the same count in the
			// same dim and offers the expand hint it offers on every other card.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 7 more items"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 7 more items"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// The rail is the block's default in one arm and the host's quiet edge in the other.
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("dim", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row counts the rows, the collapsed body reserves one of its six for
		// the note, the tab is spaces rather than a hole, and expanding reveals the rest.
		const collapsed = viewLines(value, COLLAPSED, args, 200);
		expect(stripVTControlCharacters(collapsed[0] ?? "")).toContain("12 items");
		expect(collapsed).toHaveLength(COLLAPSED_TEXT_LIMIT + 1);
		expect(stripVTControlCharacters(collapsed[1] ?? "")).toContain("hit 0");
		expect(stripVTControlCharacters(collapsed[1] ?? "")).toContain("after a tab");
		expect(collapsed[1]).not.toContain("\t");
		expect(stripVTControlCharacters(collapsed.join("\n"))).not.toContain("hit 5");
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("hit 11");
		expect(expanded).not.toContain("more items");
	});

	it("draws the grouped body of a detailed result byte for byte, rail apart", () => {
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH, 40]) {
				expect(quietRail(oracleLines(value, options, args, width))).toEqual(viewLines(value, context, args, width));
			}
		}
		// Anti-vacuity: the head row counts matches and files and states the scope; the collapsed card
		// keeps the headers and the marked lines and drops the context around them, which is what the
		// expanded card carries.
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("2 matches");
		expect(expanded).toContain("2 files");
		expect(expanded).toContain("in src");
		expect(expanded).toContain("const before = 1;");
		const collapsed = stripVTControlCharacters(viewLines(value, COLLAPSED, args, 200).join("\n"));
		expect(collapsed).toContain("const needle = true;");
		expect(collapsed).not.toContain("const before = 1;");
		// A nested file header is dimmed and a directory header accented, and a body row is indented
		// under the header that opened its group.
		const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(rows[0]?.[0]).toMatchObject({ text: "# src/", tone: "accent" });
		expect(rows[1]?.[0]).toMatchObject({ text: "  " });
		expect(rows[1]?.[1]).toMatchObject({ text: "## a.ts", tone: "dim" });
	});

	it("holds groups back in the unit the search was asked for, closing the card with the gesture", () => {
		// Nine groups of two rows each: twice the collapsed budget, so the card holds groups back.
		const groups = Array.from({ length: 9 }, (_unused, index) =>
			[`## f${index}.ts`, `*${index + 1}│const needle = ${index};`].join("\n"),
		);
		const value = detailed({ matchCount: 9, fileCount: 9, cwd: "/repo", displayContent: groups.join("\n\n") });
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 7 more matches"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 7 more matches"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
		}
		// A paths-only search counts what it held back in files, because its rows are files.
		const pathsOnly = detailed({
			matchCount: 25,
			fileCount: 25,
			pathsOnly: true,
			cwd: "/repo",
			displayContent: Array.from({ length: 25 }, (_unused, index) => `## mod-${index}.ts`).join("\n\n"),
		});
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(pathsOnly, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(pathsOnly, HOST_COLLAPSED, args, width)));
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Every row of a paths-only body is a header, so the search marked no match line and none
			// of the rows shown counts against the total: the note names all 25 files.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 25 more files"));
		}
		const flat = stripVTControlCharacters(viewLines(pathsOnly, COLLAPSED, args, 200).join("\n"));
		expect(flat).toContain("more files");
		expect(flat).not.toContain("more matches");
		// Output the search marked no match line in at all: the note counts rows, since the head
		// row's own count cannot be apportioned between what is shown and what is not.
		const unmarked = detailed({
			matchCount: 40,
			fileCount: 1,
			cwd: "/repo",
			displayContent: Array.from({ length: 40 }, (_unused, index) => ` ${index + 1}│const x = ${index};`).join("\n"),
		});
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(unmarked, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(unmarked, HOST_COLLAPSED, args, width)));
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 35 more matches"));
		}
		// The note about a path the search never reached takes a row out of the budget before the
		// groups are measured against it, in both arms.
		const withMissing = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			missingPaths: ["gone/"],
		});
		expect(viewLines(withMissing, COLLAPSED, args, 200)).toEqual(
			quietRail(oracleLines(withMissing, HOST_COLLAPSED, args, 200)),
		);
		expect(viewLines(withMissing, COLLAPSED, args, 200).at(-1)).toContain(
			theme.fg("warning", "skipped missing: gone/"),
		);
	});

	it("exception cell: an empty detailed answer indents its rows under the head row it kept", () => {
		const cases: Array<{ details: Partial<TextSearchDetails>; args: TextSearchRenderArgs | undefined }> = [
			{ details: {}, args: { input: "needle" } },
			{ details: {}, args: undefined },
			{ details: {}, args: { input: "" } },
			{ details: { scopePath: "src", searchPath: "/repo/src" }, args: { input: "needle" } },
			{ details: { scopePath: "src" }, args: { input: "needle" } },
			{ details: { missingPaths: ["gone/"] }, args: { input: "needle" } },
			{ details: { missingPaths: ["a/", "b/"], scopePath: "src" }, args: { input: "needle" } },
		];
		for (const { details, args } of cases) {
			const value = detailed({ ...details, fileCount: details.fileCount ?? 1 });
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					const drawn = withoutEmptyRuns(viewLines(value, context, args, width));
					const oracle = withoutEmptyRuns(unpad(oracleLines(value, options, args, width)));
					expect(drawn).toHaveLength(oracle.length);
					// The head row is the same row one column left. Every row under it is the same row
					// indented two columns under that head, where main left it in column zero behind
					// the runs its single `Text` had closed.
					expect(drawn[0]).toBe(oracle[0]);
					for (let row = 1; row < oracle.length; row++) expect(drawn[row]).toBe(`  ${oracle[row]}`);
				}
			}
		}
		// Anti-vacuity: the card says it found nothing, counts zero, and says separately what it never
		// reached.
		const missing = viewLines(detailed({ fileCount: 1, missingPaths: ["gone/"] }), COLLAPSED, { input: "x" }, 200);
		const flat = stripVTControlCharacters(missing.join("\n"));
		expect(flat).toContain("0 matches");
		expect(flat).toContain("No matches found");
		expect(missing.at(-1)).toContain(theme.fg("warning", "skipped missing: gone/"));
	});

	it("says on the rows what a truncated search cut, leaving the rail quiet", () => {
		const cut = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			truncated: true,
			missingPaths: ["gone/"],
		});
		const byColumn = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			// A column cut states the column it cut at, which is the shape `OutputMeta` records.
			meta: { limits: { columnTruncated: { maxColumn: 200 } } } as TextSearchDetails["meta"],
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const value of [cut, byColumn]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					// Main painted the whole rail in warning because the block derives its edge from
					// the state. The host keeps the quiet edge and the card states the outcome in the
					// words on its rows, which are byte-identical.
					expect(quietRail(oracleLines(value, options, args, width), "warning")).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		expect(oracleLines(cut, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("warning", rail()));
		expect(viewLines(cut, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row marks the truncation once, and the card still names the path it
		// never reached.
		const drawn = viewLines(cut, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("truncated");
		expect(drawn.filter(row => row.includes(theme.fg("warning", "skipped missing: gone/")))).toHaveLength(1);
		// The state is the card's own claim rather than a colour: on this preset a warning frame and a
		// success frame draw the same quiet rail, so a host that reads the view is the only reader
		// that can tell them apart.
		expect(framedView(textSearchToolView.renderResult(cut, EXPANDED, args)).state).toBe("warning");
		expect(
			framedView(
				textSearchToolView.renderResult(
					detailed({ matchCount: 1, fileCount: 1, cwd: "/repo", displayContent: GROUPED }),
					EXPANDED,
					args,
				),
			).state,
		).toBe("success");
	});

	it("states for a second host what each row of a search points at, and opens the same links", () => {
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		// A body row names the file AND the line inside it, which is what makes it a position rather
		// than a document: a row that carried the file alone would send a reader to line one.
		const body = rows.find(row =>
			row
				.map(span => span.text)
				.join("")
				.includes("needle"),
		);
		expect(body?.at(-1)).toMatchObject({ file: "/repo/src/a.ts", fileLine: 12, tone: "output" });
		expect(rows[0]?.[0]).toMatchObject({ file: "/repo/src" });
		// A url header names its target as a link rather than as a path, stripped of the `##` and of
		// the count the tool appended.
		const urlValue = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## https://example.com/page (1 match)", "*3│const needle = true;"].join("\n"),
		});
		const urlRows = framedView(textSearchToolView.renderResult(urlValue, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(urlRows[0]?.[0]).toMatchObject({ link: "https://example.com/page", tone: "accent" });
		expect(urlRows[0]?.[0]?.file).toBeUndefined();
		// With hyperlinks on, the rows carry the OSC 8 targets main's own body carried, line and all.
		settings.override("tui.hyperlinks", "always");
		try {
			for (const width of [200, WIDTH]) {
				for (const shape of [value, urlValue]) {
					expect(quietRail(oracleLines(shape, HOST_EXPANDED, args, width))).toEqual(
						viewLines(shape, EXPANDED, args, width),
					);
				}
			}
			const drawn = viewLines(value, EXPANDED, args, 200);
			expect(drawn.some(row => row.includes("line=12"))).toBe(true);
			expect(viewLines(urlValue, EXPANDED, args, 200)[1]).toContain("https://example.com/page");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("frames a result the tool counted on one axis alone, as main framed it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		// Main framed the detailed card when EITHER count arrived and read the missing one as zero, so
		// a result carrying matches alone is the grouped card and one carrying files alone is the empty
		// card. Neither is the text-only card, which is what a card reads a result with no count at all
		// as, and which nothing else here distinguishes from a result counted on one axis.
		const withMatches: TextSearchViewResult = {
			content: [{ type: "text", text: GROUPED }],
			details: { matchCount: 2, cwd: "/repo" },
		};
		const withFiles: TextSearchViewResult = {
			content: [{ type: "text", text: GROUPED }],
			details: { fileCount: 2, cwd: "/repo" },
		};
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH] as const) {
				expect(quietRail(oracleLines(withMatches, options, args, width))).toEqual(
					viewLines(withMatches, context, args, width),
				);
				// A count on the file axis alone is zero matches, which is the empty card: the head row
				// one column left, and every row under it two columns in.
				const drawn = withoutEmptyRuns(viewLines(withFiles, context, args, width));
				const oracle = withoutEmptyRuns(unpad(oracleLines(withFiles, options, args, width)));
				expect(drawn).toHaveLength(oracle.length);
				expect(drawn[0]).toBe(oracle[0]);
				for (let row = 1; row < oracle.length; row++) expect(drawn[row]).toBe(`  ${oracle[row]}`);
			}
		}
		// Anti-vacuity: each card states the axis it was given and zero for the one it was not, and
		// neither is the text-only card, whose head row counts its rows as items.
		const matches = stripVTControlCharacters(viewLines(withMatches, EXPANDED, args, 200).join("\n"));
		expect(matches).toContain("2 matches");
		expect(matches).toContain("0 files");
		expect(matches).not.toContain("items");
		const files = stripVTControlCharacters(viewLines(withFiles, EXPANDED, args, 200).join("\n"));
		expect(files).toContain("0 matches");
		expect(files).toContain("No matches found");
		expect(files).not.toContain("items");
	});

	it("expands a tab and cuts a row too long for the frame where main cut it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const tabbed = detailed({
			matchCount: 2,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", "*12│const needle =\tfalse;", "*13│const other =\t3;"].join("\n"),
		});
		const long = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", `*12│const needle = "${"x".repeat(300)}";`].join("\n"),
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
		expect(stripVTControlCharacters(drawnTabs.join("\n"))).toContain(replaceTabs("const needle =\tfalse;"));
		// And a row wider than the frame ends at the frame rather than wrapping onto a second row: the
		// card is its header, the group's header, and one body row.
		const cut = viewLines(long, EXPANDED, args, 40);
		expect(cut).toHaveLength(3);
		for (const row of cut) expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(40);
		expect(stripVTControlCharacters(cut.join("\n"))).not.toContain("x".repeat(300));
	});

	it("lists the rows main listed of a text-only result, blanks dropped and long rows cut", () => {
		const args: TextSearchRenderArgs = { input: "hit" };
		const spaced: TextSearchViewResult = {
			content: [{ type: "text", text: ["first hit", "", "   ", "second hit", "", "third hit"].join("\n") }],
		};
		const long: TextSearchViewResult = { content: [{ type: "text", text: `hit ${"y".repeat(300)}` }] };
		for (const value of [spaced, long]) {
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
		// Anti-vacuity: a blank line is not a row, so the card counts three and draws three under its
		// head row.
		const drawn = viewLines(spaced, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("3 items");
		expect(drawn).toHaveLength(4);
		// And a row wider than the frame ends at the frame.
		const cut = viewLines(long, EXPANDED, args, 40);
		expect(cut).toHaveLength(2);
		for (const row of cut) expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(40);
	});

	it("apportions what it holds back the way main apportioned it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		// Marked matches with the context around them, expanded: the note counts the marks rather than
		// the rows they sit among, so a card showing six of nine marks holds three back.
		const withContext = detailed({
			matchCount: 9,
			fileCount: 9,
			cwd: "/repo",
			displayContent: Array.from({ length: 9 }, (_unused, index) =>
				[
					`## f${index}.ts`,
					` ${index + 1}│const before = 0;`,
					`*${index + 2}│const needle = ${index};`,
					` ${index + 3}│const after = 0;`,
				].join("\n"),
			).join("\n\n"),
		});
		// Every row but the note is byte-identical, and the note differs by the gesture alone
		// (exception 35), so the count itself is compared with the gesture dropped.
		expect(withoutFramePad(quietRail(oracleLines(withContext, HOST_EXPANDED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(withContext, EXPANDED, args, 200))),
		);
		expect(viewLines(withContext, EXPANDED, args, 200)).toHaveLength(EXPANDED_TEXT_LIMIT + 1);
		expect(viewLines(withContext, EXPANDED, args, 200).at(-1)).toContain(theme.fg("dim", "… 3 more matches"));
		// The note about a path the search never reached costs the body a row before the groups are
		// measured against it, so the card draws one group's row fewer than it would without it.
		const missing = detailed({
			matchCount: 9,
			fileCount: 9,
			cwd: "/repo",
			displayContent: Array.from({ length: 9 }, (_unused, index) =>
				[`## f${index}.ts`, `*${index + 1}│const needle = ${index};`].join("\n"),
			).join("\n\n"),
			missingPaths: ["gone/"],
		});
		expect(withoutFramePad(quietRail(oracleLines(missing, HOST_COLLAPSED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(missing, COLLAPSED, args, 200))),
		);
		const missingRows = viewLines(missing, COLLAPSED, args, 200);
		// Head row, two whole groups, the held-back note, and the path it never reached.
		expect(missingRows).toHaveLength(7);
		expect(missingRows.at(-2)).toContain(theme.fg("dim", "… 7 more matches"));
		expect(missingRows.at(-1)).toContain(theme.fg("warning", "skipped missing: gone/"));
		// A paths-only search apportions its FILE count: the matches it also counted are on lines this
		// card never draws, so counting them would name rows that do not exist.
		const pathsOnly = detailed({
			matchCount: 60,
			fileCount: 25,
			pathsOnly: true,
			cwd: "/repo",
			displayContent: Array.from({ length: 25 }, (_unused, index) => `## mod-${index}.ts`).join("\n\n"),
		});
		expect(withoutFramePad(quietRail(oracleLines(pathsOnly, HOST_COLLAPSED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(pathsOnly, COLLAPSED, args, 200))),
		);
		expect(viewLines(pathsOnly, COLLAPSED, args, 200).at(-1)).toContain(theme.fg("dim", "… 25 more files"));
		// Every match the head row counted is already on a row the card drew and what is left over is
		// headers, so the note counts rows: a match count cannot say what those headers are.
		const headers = detailed({
			matchCount: 1,
			fileCount: 31,
			cwd: "/repo",
			displayContent: [
				["## a.ts", " 1│const needle = 1;"].join("\n"),
				...Array.from({ length: 30 }, (_unused, index) => `## f${index}.ts`),
			].join("\n\n"),
		});
		expect(withoutFramePad(quietRail(oracleLines(headers, HOST_EXPANDED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(headers, EXPANDED, args, 200))),
		);
		expect(viewLines(headers, EXPANDED, args, 200).at(-1)).toContain(theme.fg("dim", "… 9 more lines"));
	});

	it("links the scope on the head row to the path the search ran in", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const scoped = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		// The same scope from a result that never carried the absolute path: the words are the scope's
		// own either way, and only one of them opens anything.
		const unresolvable = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			displayContent: GROUPED,
		});
		settings.override("tui.hyperlinks", "always");
		try {
			for (const value of [scoped, unresolvable]) {
				for (const width of [200, WIDTH] as const) {
					expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
						viewLines(value, EXPANDED, args, width),
					);
				}
			}
			const head = viewLines(scoped, EXPANDED, args, 200)[0] ?? "";
			expect(head).toContain("file:///repo/src");
			expect(stripVTControlCharacters(head)).toContain("in src");
			const bare = viewLines(unresolvable, EXPANDED, args, 200)[0] ?? "";
			expect(bare).not.toContain("file:///repo/src");
			expect(stripVTControlCharacters(bare)).toContain("in src");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("resolves an internal address to the path a host opens, and carries it to the rows under it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const value = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## local://notes.md (1 match)", "*3│const needle = true;"].join("\n"),
		});
		// `local://` is the one scheme a card can resolve without waiting for the tool, and the root it
		// resolves against is the session's, so the cell installs one rather than reaching for a real
		// session. The override is process-global, hence the finally.
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => "/repo/.veyyon/artifacts",
			getSessionId: () => "differential",
		});
		const resolved = "/repo/.veyyon/artifacts/local/notes.md";
		try {
			const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
			expect(rows[0]?.[0]).toMatchObject({ file: resolved, tone: "accent" });
			expect(rows[0]?.[0]?.link).toBeUndefined();
			// The header is the only row that resolved the address, so the row under it learns the path
			// from it: the classifier that resolves paths knows nothing about the scheme.
			expect(rows[1]?.at(-1)).toMatchObject({ file: resolved, fileLine: 3 });
			settings.override("tui.hyperlinks", "always");
			try {
				for (const width of [200, WIDTH] as const) {
					expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
						viewLines(value, EXPANDED, args, width),
					);
				}
				const drawn = viewLines(value, EXPANDED, args, 200);
				expect(drawn[1]).toContain(`file://${resolved}`);
				expect(drawn[2]).toContain(`file://${resolved}?line=3`);
			} finally {
				settings.clearOverride("tui.hyperlinks");
			}
		} finally {
			LocalProtocolHandler.resetOverrideForTests();
		}
	});
});
