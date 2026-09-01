/**
 * The `write` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { formatExpandHint } from "@veyyon/coding-agent/tools/core/render-utils";
import { type WriteViewArgs, type WriteViewResult, writeToolView } from "@veyyon/coding-agent/tools/fs/write-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as writeOracle from "../oracles/write-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	framedView,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("write tool differential", () => {
	const PATH = "src/app.ts";
	const RESOLVED = "/repo/src/app.ts";
	const FILE = Array.from({ length: 20 }, (_unused, index) => `const value${index + 1} = ${index + 1};`).join("\n");
	const ARGS: WriteViewArgs = { path: PATH, content: FILE };

	/**
	 * A card with the block's own width padding removed.
	 *
	 * The head row of a settled card states its metadata as entries the host separates, so the two
	 * arms' longest rows differ by a column or two and the block pads every other row to match. The
	 * padding sits between the content and the background reset, so `trimEnd` never reaches it, and it
	 * is the host's layout rather than either renderer's bytes.
	 */
	function fitted(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +(\x1b\[49m)$/, "$1"));
	}

	function result(overrides: Partial<WriteViewResult> = {}): WriteViewResult {
		return {
			content: [{ type: "text", text: `Wrote ${RESOLVED}` }],
			details: { resolvedPath: RESOLVED },
			...overrides,
		};
	}

	function viewLines(
		value: WriteViewResult,
		context: ToolViewContext,
		width = WIDTH,
		args: WriteViewArgs | undefined = ARGS,
	): string[] {
		return fitted(renderCompLines(drawToolView(writeToolView.renderResult(value, context, args), theme), width));
	}

	function oracleLines(
		value: WriteViewResult,
		options: RenderResultOptions,
		width = WIDTH,
		args: WriteViewArgs | undefined = ARGS,
	): string[] {
		return fitted(
			renderCompLines(writeOracle.mainWriteToolRenderer.renderResult(value, options, theme, args), width),
		);
	}

	it("draws the failed card byte for byte, at every width and disclosure", () => {
		const failures: WriteViewResult[] = [
			{ content: [{ type: "text", text: "EACCES: permission denied, open 'src/app.ts'" }], isError: true },
			{ content: [{ type: "text", text: "" }], isError: true },
			{ content: [{ type: "text", text: "Error:   \tspaced\tmessage" }], isError: true },
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(viewLines(value, context, width)).toEqual(oracleLines(value, options, width));
				}
			}
		}
		// Anti-vacuity: the compared card names the tool and the file, marks the failure, and carries
		// the message indented under the header rather than an empty frame.
		const drawn = viewLines(failures[0]!, COLLAPSED, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Write: src/app.ts");
		expect(flat).toContain("  EACCES: permission denied");
		expect(drawn.join("\n")).toContain(theme.fg("error", "EACCES: permission denied, open 'src/app.ts'"));
		// A message with no text still says something, in both arms alike.
		expect(stripVTControlCharacters(viewLines(failures[1]!, COLLAPSED, 200).join("\n"))).toContain("Unknown error");
	});

	it("draws the file's rows byte for byte: the gutter, the highlighting and the tabs", () => {
		const files = [
			FILE,
			// A tab-indented file: the gutter is the host's and the tab is replaced, in both arms.
			"function f() {\n\treturn 1;\n}",
			// Past the three-digit gutter, where a width derived from the line count would shift rows.
			Array.from({ length: 1200 }, (_unused, index) => `line ${index + 1}`).join("\n"),
			"",
		];
		for (const content of files) {
			const args: WriteViewArgs = { path: PATH, content };
			for (const width of [200, WIDTH, 40]) {
				// Expanded: nothing is held back, so every row of the card below the header is the file
				// and is compared whole.
				expect(viewLines(result(), EXPANDED, width, args).slice(1)).toEqual(
					oracleLines(result(), HOST_EXPANDED, width, args).slice(1),
				);
				// Collapsed: the same rows, minus the held-back note the host words differently.
				expect(viewLines(result(), COLLAPSED, width, args).slice(1, -1)).toEqual(
					oracleLines(result(), HOST_COLLAPSED, width, args).slice(1, -1),
				);
			}
		}
		// Anti-vacuity: the rows compared carry the gutter and the file's own text, and a collapsed
		// card stops at the preview budget where an expanded one does not.
		const collapsed = stripVTControlCharacters(viewLines(result(), COLLAPSED, 200).join("\n"));
		expect(collapsed).toContain("  1 const value1 = 1;");
		expect(collapsed).toContain("  6 const value6 = 6;");
		expect(collapsed).not.toContain("  7 const value7 = 7;");
		expect(stripVTControlCharacters(viewLines(result(), EXPANDED, 200).join("\n"))).toContain(
			" 20 const value20 = 20;",
		);
	});

	it("draws the compiler's diagnostics byte for byte, grouped and capped as main grouped them", () => {
		const messages = [
			"src/app.ts:12:5 [error] [ts] Type 'string' is not assignable to type 'number' (2322)",
			"src/app.ts:3:1 [warning] [biome] unused import",
			"src/other.ts:8:2 [info] consider a narrower type",
			"src/other.ts:8:2 [hint] a hint with no code",
			"a line the grammar does not match [error] raw",
			"a note the grammar does not match",
		];
		const cases: Array<{ errored: boolean; summary: string; messages: string[] }> = [
			{ errored: true, summary: "2 errors, 1 warning", messages },
			{ errored: false, summary: "1 warning", messages: messages.slice(1, 3) },
			{ errored: true, summary: "", messages: messages.slice(0, 1) },
			// Past the collapsed cap, where both arms count what they kept back.
			{
				errored: true,
				summary: "9 errors",
				messages: Array.from({ length: 9 }, (_unused, index) => `src/app.ts:${index + 1}:1 [error] boom`),
			},
		];
		for (const diagnostics of cases) {
			const value = result({ details: { resolvedPath: RESOLVED, diagnostics } });
			for (const width of [200, WIDTH]) {
				// The diagnostics rows sit below the file's rows; the expanded arm holds nothing back,
				// so every row below the header is compared.
				expect(viewLines(value, EXPANDED, width).slice(1)).toEqual(
					oracleLines(value, HOST_EXPANDED, width).slice(1),
				);
			}
		}
		// Anti-vacuity: the compared rows carry the diagnostics header with its summary, the file each
		// group belongs to, the location, the message, the code, and the severity tone.
		const value = result({ details: { resolvedPath: RESOLVED, diagnostics: cases[0]! } });
		const drawn = viewLines(value, EXPANDED, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Diagnostics (2 errors, 1 warning)");
		expect(flat).toContain("src/other.ts");
		expect(flat).toContain(":12:5 Type 'string' is not assignable to type 'number' (2322)");
		expect(drawn.join("\n")).toContain(theme.fg("error", "Type 'string' is not assignable to type 'number'"));
		// The worst comes first inside a file: the error on line 12 above the warning on line 3.
		const rows = drawn.map(row => stripVTControlCharacters(row));
		expect(rows.findIndex(row => row.includes(":12:5"))).toBeLessThan(
			rows.findIndex(row => row.includes(":3:1 unused import")),
		);
		// A collapsed card keeps five of them back and says so, which is the one row the two arms
		// word differently and is compared in its own cell below.
		expect(stripVTControlCharacters(viewLines(value, COLLAPSED, 200).at(-1) ?? "")).toContain("… 1 more");
	});

	it("states the file's length and its execute bit as row metadata, where main wrote them into the description", () => {
		const value = result({ details: { resolvedPath: RESOLVED, madeExecutable: true } });
		const drawn = viewLines(value, EXPANDED, 200)[0]!;
		const oracle = oracleLines(value, HOST_EXPANDED, 200)[0]!;
		expect(drawn).not.toEqual(oracle);
		// Main wrote the separator and both facts into the description, so the dot before the count
		// was the tool's and the success colour sat inside the row's muted run.
		expect(oracle).toContain(`${theme.fg("dim", " · 20 lines")}`);
		expect(oracle).toContain(theme.fg("success", "made executable!"));
		// The view states two facts and no separator; the host joins them with its own and draws the
		// pair in the dim it gives every row's trailing detail.
		expect(drawn).toContain(theme.fg("dim", `20 lines${theme.sep.dot}${theme.fg("success", "made executable!")}`));
		// The visible words are the same words, in the same order, on the same row.
		expect(stripVTControlCharacters(drawn)).toContain("20 lines");
		expect(stripVTControlCharacters(drawn)).toContain("made executable!");
		expect(stripVTControlCharacters(drawn).indexOf("20 lines")).toBeLessThan(
			stripVTControlCharacters(drawn).indexOf("made executable!"),
		);
		// The file's rows below it are untouched by the difference.
		expect(viewLines(value, EXPANDED, 200).slice(1)).toEqual(oracleLines(value, HOST_EXPANDED, 200).slice(1));
	});

	it("words the held-back count as the host words every card's, where main nested the gesture inside its own run", () => {
		const drawn = viewLines(result(), COLLAPSED, 200).at(-1)!;
		const oracle = oracleLines(result(), HOST_COLLAPSED, 200).at(-1)!;
		expect(drawn).not.toEqual(oracle);
		// The same sentence either way: the count, the unit, and the gesture the reader uses.
		expect(stripVTControlCharacters(drawn)).toEqual(stripVTControlCharacters(oracle));
		expect(stripVTControlCharacters(drawn)).toContain("… 14 more lines");
		expect(stripVTControlCharacters(drawn)).toContain("expand");
		// Main opened one dim run over the whole sentence and nested the gesture's own run inside it;
		// the host writes the count in dim and closes it before the gesture beside it.
		expect(oracle).toContain(theme.fg("dim", `… 14 more lines ${formatExpandHint(theme, false, true)}`));
		expect(drawn).toContain(`${theme.fg("dim", "… 14 more lines")} ${formatExpandHint(theme, false, true)}`);
	});

	it("windows the streaming preview by the rows it occupies, where main windowed it by its own line count", () => {
		const args: WriteViewArgs = { path: PATH, content: FILE };
		const drawn = renderCompLines(
			drawToolView(writeToolView.renderCall(args, { expanded: false, partial: true, frame: 0 }), theme, 0),
			WIDTH,
		);
		const oracle = renderCompLines(
			writeOracle.mainWriteToolRenderer.renderCall(
				args,
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				theme,
			),
			WIDTH,
		);
		expect(drawn).not.toEqual(oracle);
		// Main cut the file to its last twelve LINES and wrote a bracketed count of the rest; the host
		// cuts it to the twelve ROWS it was given, spends one of them on the note, and offers the
		// expand gesture the tool no longer words.
		expect(stripVTControlCharacters(oracle.join("\n"))).toContain("… (8 earlier lines)");
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain("… 9 earlier lines");
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain("expand");
		// Both arms follow the streaming edge and both say the card is still arriving.
		for (const arm of [drawn, oracle]) {
			const flat = stripVTControlCharacters(arm.join("\n"));
			expect(flat).toContain(" 20 const value20 = 20;");
			expect(flat).toContain("… (streaming)");
			expect(flat).not.toContain("  1 const value1 = 1;");
		}
		// Expanded, neither arm windows anything, and the rows below the header are byte-identical.
		const wholeDrawn = renderCompLines(
			drawToolView(writeToolView.renderCall(args, { expanded: true, partial: true, frame: 0 }), theme, 0),
			WIDTH,
		);
		const wholeOracle = renderCompLines(
			writeOracle.mainWriteToolRenderer.renderCall(
				args,
				{ expanded: true, isPartial: true, spinnerFrame: 0 },
				theme,
			),
			WIDTH,
		);
		expect(wholeDrawn).toEqual(wholeOracle);
	});

	it("states one language for the call row and the settled card, where main resolved two", () => {
		const args: WriteViewArgs = { path: "notes", content: "hello\n" };
		const call = framedView(writeToolView.renderCall(args, { expanded: true, partial: true, frame: 0 })).header;
		const settled = framedView(writeToolView.renderResult(result(), EXPANDED, args)).header;
		// An extensionless file names no language. Main resolved the call row's to `text` and the
		// settled card's to nothing at all, so a host with language glyphs drew a different badge on
		// each card and the glyph changed under the reader when the write settled. The view states one
		// language for both, empty because the file names one the tool cannot tell — which is a file a
		// host may still mark, and not the same claim as a row that names no file.
		expect(call.language).toEqual("");
		expect(settled.language).toEqual("");
		expect(call.language).not.toBeUndefined();
		// A file whose language IS named states that language on both cards.
		const known = framedView(writeToolView.renderCall(ARGS, { expanded: true, partial: true, frame: 0 })).header;
		expect(known.language).toEqual("typescript");
		expect(framedView(writeToolView.renderResult(result(), EXPANDED, ARGS)).header.language).toEqual("typescript");
		// The bundled preset ships no language glyphs, so `langBadge` is empty for every language and
		// neither arm's drawn row can show this difference. That is what the field claim is for, and
		// what this cell does NOT catch is a host that reads `language` and draws the wrong glyph.
		expect(theme.langBadge("typescript")).toEqual("");
		// With no badge to draw, the call row the host draws is byte for byte the row main drew.
		expect(
			renderCompLines(
				drawToolView(writeToolView.renderCall(ARGS, { expanded: true, partial: true, frame: 0 }), theme, 0),
				200,
			)[0]!,
		).toEqual(
			renderCompLines(
				writeOracle.mainWriteToolRenderer.renderCall(
					ARGS,
					{ expanded: true, isPartial: true, spinnerFrame: 0 },
					theme,
				),
				200,
			)[0]!,
		);
	});

	it("leaves no blank rows between a partial result's progress line and the file, where main left two", () => {
		const value = result({ content: [{ type: "text", text: "Writing 4096 bytes to src/app.ts..." }] });
		const partial = { expanded: true, partial: true, frame: 0 } as const;
		const hostPartial: RenderResultOptions = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const drawn = fitted(
			renderCompLines(drawToolView(writeToolView.renderResult(value, partial, ARGS), theme, 0), 200),
		);
		const oracle = fitted(
			renderCompLines(writeOracle.mainWriteToolRenderer.renderResult(value, hostPartial, theme, ARGS), 200),
		);
		// A row of the frame and nothing else: no letter and no digit anywhere on it.
		const wordless = (row: string): boolean => !/[\p{L}\p{N}]/u.test(stripVTControlCharacters(row));
		// Main's progress text and its preview were one string, and the preview opened with the blank
		// pair that the leading-blank trim only reaches at the top of a card, so the gap survived in
		// the middle of one. Sections carry no such padding.
		expect(oracle.filter(wordless)).toHaveLength(2);
		expect(drawn.filter(wordless)).toHaveLength(0);
		// Below the head row, every row either arm draws is the same row: the progress line, then the
		// file as far as it has arrived.
		expect(drawn.slice(1)).toEqual(oracle.filter(row => !wordless(row)).slice(1));
		// The head row differs only in who writes the separator before the length. Main wrote it into
		// the description; the view states the length as row metadata and the host spaces it, exactly
		// as it spaces every other tool's.
		expect(stripVTControlCharacters(oracle[0]!)).toContain(`src/app.ts${theme.sep.dot}20 lines`);
		expect(stripVTControlCharacters(drawn[0]!)).toContain("src/app.ts 20 lines");
		// Anti-vacuity: the progress line leads the card, the file follows it, and the row states the
		// length of what has arrived without claiming the execute bit that settling decides.
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Writing 4096 bytes to src/app.ts...");
		expect(flat).toContain("  1 const value1 = 1;");
		expect(flat).not.toContain("made executable");
	});
});
