/**
 * The `file_search` card draws what main's renderer drew.
 *
 * FIVE DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The call row, the failure row and the text-only
 * empty row, which main built with `new Text(text, 1, 0)`: the pad indents each one column past every
 * other tool's row, and a view is drawn with no pad, so the row moves left and nothing else changes.
 * The rail, which main left to the block's own default -- dim on a settled card and warning on a
 * truncated one -- where the host's reduction quiets every rail but a failure's, as the twelve
 * renderers that asked for `borderMuted` by hand already drew; the outcome stays in the words on the
 * rows, which are byte-identical. The held-back count, which closes the list in the same dim main
 * wrote it in and adds the expand gesture the host offers on every other card. The empty detailed
 * card, whose rows carry their own two-column indent and open only the colour runs they use, where
 * main joined pre-coloured strings into one `Text` and left each row in column zero behind the
 * zero-width runs its neighbours had closed. And the directory rows, which draw the path alone where
 * main opened a colour run for a folder glyph the preset does not draw and closed it without a
 * character between.
 *
 * ONE BRANCH IS UNOBSERVABLE RATHER THAN UNTESTED. A head row whose pattern arrived empty draws the
 * same bytes whether the view states the empty description or omits it, because the terminal draws
 * nothing for either, so only a host that reads the view could tell them apart. The cells sweep the
 * empty pattern and the absent one at every width, and the frames agree.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import type { TruncationResult } from "@veyyon/coding-agent/session/streaming-output";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatFullOutputReference } from "@veyyon/coding-agent/tools/core/output-meta";
import { formatExpandHint, PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { FileSearchDetails, FileSearchRenderArgs } from "@veyyon/coding-agent/tools/search/file-search";
import { type FileSearchViewResult, fileSearchToolView } from "@veyyon/coding-agent/tools/search/file-search-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as fileSearchOracle from "../oracles/file-search-main-renderer";
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

describe("file_search tool differential", () => {
	const rail = (): string => theme.symbol("block.rail");

	/**
	 * The oracle's rail run rewritten to the colour the host's reduction paints.
	 *
	 * Main's file search asked `framedBlock` for no rail colour, so it took the block's own default:
	 * `dim` on a settled card and `warning` on a truncated one. A view names no colour at all and the
	 * reduction in `draw-tool-view.ts` quiets every rail but a failure's, which is what the twelve
	 * renderers that passed `borderMuted` by hand already drew. Swapping the run here leaves every
	 * other byte of the row to be compared.
	 */
	function quietRail(lines: readonly string[], from: ThemeColor = "dim"): string[] {
		return lines.map(line => line.replace(theme.fg(from, rail()), theme.fg("borderMuted", rail())));
	}

	/** Main's `new Text(text, 1, 0)` indent, dropped: the pad is the whole of the difference. */
	function unpad(lines: readonly string[]): string[] {
		return lines.map(line => (line.startsWith(" ") ? line.slice(1) : line));
	}

	/**
	 * The spaces a frame pads a row with, dropped.
	 *
	 * A framed block sizes itself to its widest row, so a card whose widest row is the held-back note
	 * is one hint wider in the arm that offers the gesture. Every row of it then carries one more
	 * space before the block closes its ground. The pad is the width's doing rather than the row's, so
	 * a cell that pins the width separately compares the rows without it.
	 */
	function withoutFramePad(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +\u001b\[49m$/, "\u001b[49m"));
	}

	/**
	 * Every colour sequence that paints nothing, removed.
	 *
	 * Main joined pre-coloured strings into one `Text`, so a row carries the runs its neighbours
	 * opened and closed with no character between them, and the absent folder glyph opens one more.
	 * Nothing on any terminal draws differently for them. A pass over the row is exact where a regex
	 * is not: an open followed straight by a reset paints nothing, and a reset with no open before it
	 * closes nothing, and both appear here because the joined runs nest.
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
					// The pending open painted something, so it and the text stay.
					out += `${open ?? ""}${text}`;
					open = undefined;
				}
				if (match[0] === "\u001b[39m") {
					// A reset closes the open it follows, or nothing at all.
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
		value: FileSearchViewResult,
		context: ToolViewContext,
		args: FileSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(fileSearchToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: FileSearchViewResult,
		options: RenderResultOptions,
		args: FileSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		// The oracle took the tool's whole result shape, where a view narrows it to what a card reads:
		// the content of a result that carries none is the empty list the tool would have sent.
		const whole = { content: value.content ?? [], details: value.details, isError: value.isError };
		return renderCompLines(fileSearchOracle.fileSearchRenderer.renderResult(whole, options, theme, args), width);
	}

	/** A result the tool described with details, which is the card that frames a list. */
	function detailed(details: Partial<FileSearchDetails>): FileSearchViewResult {
		return { content: [{ type: "text", text: "" }], details: { fileCount: 0, files: [], ...details } };
	}

	const FILES = [
		"src/",
		"src/index.ts",
		"src/util.ts",
		"docs/",
		"docs/a.md",
		"README.md",
		"x/y.rs",
		"z.json",
		"q.py",
		"w.go",
		"e.rb",
	];

	it("exception cell: draws the pending call row in the column its siblings draw in", () => {
		const calls: Array<FileSearchRenderArgs | undefined> = [
			{ input: "src/**/*.ts" },
			{ input: "src/**/*.ts", limit: 50 },
			{ input: "src/**/*.ts", limit: 1 },
			{ input: "*" },
			// A pattern the model sent empty, and a call with no arguments at all: both rows say what
			// the search covers rather than naming nothing, which is the case a `??` in place of the
			// `||` changes.
			{ input: "" },
			{},
			undefined,
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				// Widths where the row fits: the wrap boundary is the pad's business, and a row cut
				// at width 12 wraps one column earlier in the padded arm, which is the same
				// difference counted twice rather than a second one.
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(
						drawToolView(lineView(fileSearchToolView.renderCall(args ?? {}, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						fileSearchOracle.fileSearchRenderer.renderCall(args ?? {}, options, theme),
						width,
					);
					// Main built the row with `new Text(text, 1, 0)`, whose one-column horizontal pad
					// indents it past every other tool's row. A view is drawn with no pad at all, so
					// the row moves one column left and nothing else about it changes.
					expect(unpad(oracle)).toEqual(drawn);
				}
			}
		}
		// The pad is real in one arm and absent in the other, so the cell above is not comparing two
		// unpadded rows.
		const padded = renderCompLines(
			fileSearchOracle.fileSearchRenderer.renderCall({ input: "*" }, HOST_COLLAPSED, theme),
			200,
		);
		expect(padded[0]!.startsWith(" ")).toBe(true);
		const flush = renderCompLines(
			drawToolView(lineView(fileSearchToolView.renderCall({ input: "*" }, COLLAPSED)), theme),
			200,
		);
		expect(flush[0]!.startsWith(" ")).toBe(false);
		// Anti-vacuity: the compared row carries the tool's title, the pattern the model asked for,
		// and the cap when one was sent, and a call with no pattern still says what it searches.
		const one = stripVTControlCharacters(flush.join(""));
		expect(one).toContain("Search files: *");
		const capped = stripVTControlCharacters(
			renderCompLines(
				drawToolView(lineView(fileSearchToolView.renderCall({ input: "src/**", limit: 50 }, COLLAPSED)), theme),
				200,
			).join(""),
		);
		expect(capped).toContain("Search files: src/**");
		expect(capped).toContain("limit:50");
		const bare = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(fileSearchToolView.renderCall({}, COLLAPSED)), theme), 200).join(""),
		);
		expect(bare).toContain("Search files: *");
	});

	it("exception cell: names a failure in main's words, one column left of them", () => {
		const failures: FileSearchViewResult[] = [
			{ content: [{ type: "text", text: "boom went the glob" }], isError: true },
			{ content: [], details: { error: "bad pattern" } as FileSearchDetails },
			// A failure the tool reported with neither a message nor details: both arms name it.
			{ content: [], isError: true },
			// Both channels at once: the details win in both arms.
			{
				content: [{ type: "text", text: "content text" }],
				details: { error: "details error" } as FileSearchDetails,
				isError: true,
			},
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "*" }, width))).toEqual(
						viewLines(value, context, { input: "*" }, width),
					);
				}
			}
		}
		// Anti-vacuity: the row says which failure it was, in the error tone, and the details beat the
		// content text rather than being appended to it.
		const drawn = viewLines(failures[3]!, COLLAPSED, { input: "*" }, 200);
		expect(drawn[0]).toContain(theme.fg("error", "Error: details error"));
		expect(stripVTControlCharacters(drawn.join(""))).not.toContain("content text");
		expect(stripVTControlCharacters(viewLines(failures[2]!, COLLAPSED, { input: "*" }, 200).join(""))).toContain(
			"Unknown error",
		);
	});

	it("exception cell: states a text-only empty answer where main stated it", () => {
		const empties: FileSearchViewResult[] = [
			{ content: [{ type: "text", text: "No files found matching" }] },
			{ content: [{ type: "text", text: "No files matching *.zig" }] },
			{ content: [{ type: "text", text: "   " }] },
			{ content: [] },
		];
		for (const value of empties) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "*.zig" }, width))).toEqual(
						viewLines(value, context, { input: "*.zig" }, width),
					);
				}
			}
		}
		// Anti-vacuity: one row, the warning mark, and the words main wrote -- not a frame around
		// nothing and not the tool's own sentence.
		const drawn = viewLines(empties[0]!, COLLAPSED, { input: "*.zig" }, 200);
		expect(drawn).toHaveLength(1);
		expect(drawn[0]).toContain(theme.fg("muted", "No files found"));
		expect(stripVTControlCharacters(drawn[0] ?? "")).not.toContain("matching");
	});

	it("lists the lines of a text-only result byte for byte inside the rail the host quiets", () => {
		const lines = Array.from({ length: 12 }, (_unused, index) => `out/f${index}.ts`);
		const value: FileSearchViewResult = { content: [{ type: "text", text: lines.join("\n") }] };
		const args: FileSearchRenderArgs = { input: "out/**" };
		for (const width of [200, WIDTH, 40]) {
			// Expanded holds nothing back, so every row of the body is compared.
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
			// Collapsed shows the same rows and holds the same count back; only the note differs.
			const drawn = viewLines(value, COLLAPSED, args, width);
			const oracle = quietRail(oracleLines(value, HOST_COLLAPSED, args, width));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Exception: main wrote the count with no gesture; the host writes the same count in the
			// same dim and offers the expand hint it offers on every other card.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 4 more files"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 4 more files"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// The rail is the block's default in one arm and the host's quiet edge in the other, so the
		// swap above is not comparing two identical runs.
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("dim", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row counts what was found, the collapsed body stops at the shared
		// cap, and expanding reveals the rest.
		const collapsed = viewLines(value, COLLAPSED, args, 200);
		expect(stripVTControlCharacters(collapsed[0] ?? "")).toContain("12 files");
		expect(collapsed).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(stripVTControlCharacters(collapsed.join("\n"))).not.toContain("out/f8.ts");
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("out/f11.ts");
		expect(expanded).not.toContain("more files");
		// A block with blank rows in it and one path too long for the frame: both arms drop the blanks
		// and cut the long row at the same column, so a card that listed a blank row or wrapped the
		// long one would draw rows main never drew.
		const ragged: FileSearchViewResult = {
			content: [
				{
					type: "text",
					text: ["out/a.ts", "", "   ", "out/b.ts", `out/${"deep/".repeat(30)}leaf.ts`, ""].join("\n"),
				},
			],
		};
		for (const width of [200, WIDTH, 40]) {
			expect(quietRail(oracleLines(ragged, HOST_EXPANDED, args, width))).toEqual(
				viewLines(ragged, EXPANDED, args, width),
			);
		}
		const raggedRows = viewLines(ragged, EXPANDED, args, WIDTH);
		expect(stripVTControlCharacters(raggedRows[0] ?? "")).toContain("3 files");
		expect(raggedRows).toHaveLength(4);
		expect(stripVTControlCharacters(raggedRows.join("\n"))).not.toContain("leaf.ts");
	});

	it("lists a detailed result byte for byte apart from the rail and the runs main left in it", () => {
		const value = detailed({ fileCount: FILES.length, files: FILES, cwd: "/repo", scopePath: "src" });
		const args: FileSearchRenderArgs = { input: "**/*" };
		for (const width of [200, WIDTH, 40]) {
			expect(withoutEmptyRuns(quietRail(oracleLines(value, HOST_EXPANDED, args, width)))).toEqual(
				withoutEmptyRuns(viewLines(value, EXPANDED, args, width)),
			);
			const drawn = withoutEmptyRuns(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutEmptyRuns(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 3 more files"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 3 more files"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
		}
		// The run the normalization removes is real, and it is main's alone: main opened a colour for a
		// folder glyph this preset does not draw and closed it with no character between.
		const rawDirectory = oracleLines(value, HOST_EXPANDED, args, 200)[1] ?? "";
		expect(rawDirectory).toContain(`${theme.fg("accent", "")}${theme.fg("accent", "src/")}`);
		expect(viewLines(value, EXPANDED, args, 200)[1]).toContain(theme.fg("accent", "src/"));
		expect(viewLines(value, EXPANDED, args, 200)[1]).not.toContain(
			`${theme.fg("accent", "")}${theme.fg("accent", "src/")}`,
		);
		// Anti-vacuity: the head row counts the files and states the scope, a directory row is toned
		// and indented as a directory and a file row as output, and the order the tool sent is the
		// order drawn.
		const drawn = viewLines(value, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("11 files");
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("in src");
		expect(drawn[2]).toContain(theme.fg("toolOutput", "src/index.ts"));
		const words = drawn.slice(1).map(row => stripVTControlCharacters(row).replace(rail(), "").trim());
		expect(words).toEqual(FILES);
		// One row over the cap: the count is worded singular in both arms, so a card that always said
		// `files` would say what main did not.
		const oneOver = detailed({
			fileCount: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1,
			files: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1 }, (_unused, index) => `src/f${index}.ts`),
			cwd: "/repo",
		});
		// The frame sizes itself to its widest row, and here that row is the note: the hint the host
		// adds makes the view's frame wider by exactly the hint, so the rows are compared without the
		// padding that width decides and the width itself is pinned below.
		const oneOverDrawn = withoutFramePad(withoutEmptyRuns(viewLines(oneOver, COLLAPSED, args, 200)));
		const oneOverOracle = withoutFramePad(
			withoutEmptyRuns(quietRail(oracleLines(oneOver, HOST_COLLAPSED, args, 200))),
		);
		expect(oneOverDrawn.slice(0, -1)).toEqual(oneOverOracle.slice(0, -1));
		expect(oneOverDrawn.at(-1)).toContain(theme.fg("dim", "… 1 more file"));
		// A frame is rectangular in both arms, and the note is the row it sizes itself to here: the
		// view's carries the gesture, main's carries the count alone. How many columns that costs is
		// the block's arithmetic over its widest row, which is why the rows above are compared without
		// the pad rather than against a hint-sized delta.
		const widths = (rows: readonly string[]): Set<number> =>
			new Set(rows.map(row => stripVTControlCharacters(row).length));
		const drawnRows = viewLines(oneOver, COLLAPSED, args, 200);
		expect(widths(drawnRows).size).toBe(1);
		expect(widths(oracleLines(oneOver, HOST_COLLAPSED, args, 200)).size).toBe(1);
		expect(stripVTControlCharacters(drawnRows.at(-1) ?? "")).toContain("… 1 more file ▸ Ctrl+O expand");
		expect(oneOverOracle.at(-1)).toContain(theme.fg("dim", "… 1 more file"));
		expect(stripVTControlCharacters(oneOverOracle.at(-1) ?? "")).not.toContain("expand");
	});

	it("states for a second host which outcome the card framed, and what each row points at", () => {
		const args: FileSearchRenderArgs = { input: "**/*" };
		// The state is the card's own claim rather than a colour: on this preset a warning frame and a
		// success frame draw the same quiet rail and the same ground, so a host that reads the view --
		// a browser, an export -- is the only reader that can tell them apart.
		const settled = detailed({ fileCount: 2, files: ["src/a.ts", "src/b.ts"], cwd: "/repo" });
		const cut = detailed({ fileCount: 2, files: ["src/a.ts"], cwd: "/repo", truncated: true });
		expect(framedView(fileSearchToolView.renderResult(settled, EXPANDED, args)).state).toBe("success");
		expect(framedView(fileSearchToolView.renderResult(cut, EXPANDED, args)).state).toBe("warning");
		// A row states the language of the file it names, and states it empty for a path whose language
		// this build cannot tell, so a host with a badge draws one for the first and nothing for the
		// second rather than dropping the field on both.
		const mixed = detailed({ fileCount: 2, files: ["src/a.ts", "notes.unknownext"], cwd: "/repo" });
		const sections = framedView(fileSearchToolView.renderResult(mixed, EXPANDED, args)).sections;
		const rows = sections[0]?.lines ?? [];
		expect(rows[0]?.at(-1)).toMatchObject({ language: "typescript", file: "/repo/src/a.ts" });
		expect(rows[1]?.at(-1)).toMatchObject({ language: "", file: "/repo/notes.unknownext" });
		// With hyperlinks on, the rows carry the OSC 8 targets main's own list carried, resolved
		// against the search's base rather than the process's.
		settings.override("tui.hyperlinks", "always");
		try {
			for (const width of [200, WIDTH]) {
				expect(withoutEmptyRuns(quietRail(oracleLines(mixed, HOST_EXPANDED, args, width)))).toEqual(
					withoutEmptyRuns(viewLines(mixed, EXPANDED, args, width)),
				);
			}
			const drawn = viewLines(mixed, EXPANDED, args, 200);
			expect(drawn[1]).toContain("\u001b]8;");
			expect(drawn[1]).toContain("/repo/src/a.ts");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("exception cell: an empty detailed answer indents its rows and opens no run it does not use", () => {
		const cases: Array<{ details: Partial<FileSearchDetails>; args: FileSearchRenderArgs | undefined }> = [
			{ details: {}, args: { input: "*.zig" } },
			// No pattern at all, and a pattern the model sent empty: the head row states for each what
			// main stated, which is the case a `??` in place of the `||` changes.
			{ details: {}, args: undefined },
			{ details: {}, args: { input: "" } },
			{ details: { truncated: true }, args: { input: "~/.cache/*" } },
			{ details: { missingPaths: ["nope/"] }, args: { input: "*" } },
			{ details: { missingPaths: ["a/", "b/"], truncated: true }, args: { input: "*" } },
			{ details: { truncated: true, resultLimitReached: 200 }, args: { input: "*" } },
		];
		for (const { details, args } of cases) {
			const value = detailed(details);
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					const drawn = withoutEmptyRuns(viewLines(value, context, args, width));
					const oracle = withoutEmptyRuns(unpad(oracleLines(value, options, args, width)));
					expect(drawn).toHaveLength(oracle.length);
					// The head row is the same row one column left. Every row under it is the same
					// row indented two columns under that head, where main left it in column zero
					// behind the runs its single `Text` had closed.
					expect(drawn[0]).toBe(oracle[0]);
					for (let row = 1; row < oracle.length; row++) {
						expect(drawn[row]).toBe(`  ${oracle[row]}`);
					}
				}
			}
		}
		// The runs the normalization removes are main's: its body row opens the colours of every
		// neighbouring run before the mark it draws, and the view's row opens only its own.
		const rawEmpty = oracleLines(detailed({}), HOST_COLLAPSED, { input: "*.zig" }, 200);
		expect(rawEmpty[1]).toContain(`${theme.fg("toolTitle", "")}${theme.fg("muted", "")}`);
		expect(viewLines(detailed({}), COLLAPSED, { input: "*.zig" }, 200)[1]).not.toContain(theme.fg("muted", ""));
		// Anti-vacuity: the card says which kind of empty it is, and says separately what the scan
		// never reached and what it cut.
		const timedOut = stripVTControlCharacters(
			viewLines(detailed({ truncated: true }), COLLAPSED, { input: "~/.cache/*" }, 200).join("\n"),
		);
		expect(timedOut).toContain("No matches before timeout (scan incomplete)");
		expect(timedOut).toContain("timed out");
		// A card with no rows states the incomplete scan on its head row and writes no reason note, in
		// both arms: the reasons belong to a card that listed something, which the truncation cell
		// below covers. A note here would be a row main never drew.
		expect(timedOut).not.toContain("truncated:");
		expect(
			stripVTControlCharacters(
				viewLines(detailed({ truncated: true, resultLimitReached: 200 }), COLLAPSED, { input: "*" }, 200).join(
					"\n",
				),
			),
		).not.toContain("limit 200 results");
		const missing = viewLines(detailed({ missingPaths: ["nope/"] }), COLLAPSED, { input: "*" }, 200);
		expect(missing.at(-1)).toContain(theme.fg("warning", "skipped missing: nope/"));
		expect(stripVTControlCharacters(missing.join("\n"))).toContain("No files found");
	});

	it("exception cell: says on the rows what a truncated scan cut, leaving the rail quiet", () => {
		const value = detailed({
			fileCount: 200,
			files: ["src/a.ts", "src/b.ts"],
			cwd: "/repo",
			truncated: true,
			resultLimitReached: 200,
			truncation: {
				content: "src/a.ts\nsrc/b.ts",
				truncated: true,
				truncatedBy: "lines",
				totalLines: 200,
				totalBytes: 4096,
				artifactId: "art_9",
			} as TruncationResult & { artifactId: string },
			missingPaths: ["gone/"],
		});
		const args: FileSearchRenderArgs = { input: "src/**" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH] as const) {
				// Main painted the whole rail in warning because the block derives its edge from the
				// state. The host keeps the quiet edge and the card states the outcome in the words on
				// its rows, which are byte-identical.
				expect(quietRail(oracleLines(value, options, args, width), "warning")).toEqual(
					viewLines(value, context, args, width),
				);
			}
		}
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("warning", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row marks the truncation, and the notes name every reason the tool
		// learned, in the order it learned them, plus the path it never reached.
		const drawn = viewLines(value, EXPANDED, args, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("200 files");
		expect(flat).toContain("truncated: limit 200 results, line limit, ");
		expect(flat).toContain("art_9");
		expect(flat).toContain("skipped missing: gone/");
		// The whole sentence is one warning run rather than a row whose first clause happens to be
		// toned, and the card writes it once.
		const note = `truncated: limit 200 results, line limit, ${formatFullOutputReference("art_9")}`;
		expect(drawn.filter(row => row.includes(theme.fg("warning", note)))).toHaveLength(1);
	});

	it("cuts a path that outruns the frame where main cut it, instead of wrapping it onto a second row", () => {
		const long = "src/very/deep/nested/directory/structure/that/is/exceptionally/long/and/overflows/index.ts";
		const value = detailed({ fileCount: 1, files: [long], cwd: "/repo" });
		const args: FileSearchRenderArgs = { input: "src/**" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [WIDTH, 60, 40, 20] as const) {
				expect(quietRail(oracleLines(value, options, args, width))).toEqual(viewLines(value, context, args, width));
			}
		}
		// Anti-vacuity: the row is cut rather than wrapped, so the card is two rows and the tail of
		// the path is absent. A wrapped row would make it three and carry `index.ts`.
		const drawn = viewLines(value, EXPANDED, args, WIDTH);
		expect(drawn).toHaveLength(2);
		expect(stripVTControlCharacters(drawn.join("\n"))).not.toContain("index.ts");
		expect(stripVTControlCharacters(drawn[1] ?? "")).toContain("src/very/deep/nested");
		// Wide enough for the whole path: the same row carries it entire, so the cut above is the
		// width's doing and not the card's.
		expect(stripVTControlCharacters(viewLines(value, EXPANDED, args, 200)[1] ?? "")).toContain(long);
	});
});
