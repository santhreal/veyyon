/**
 * The `read` card draws what main's renderer drew.
 *
 * The file's own rows are compared as terminal bytes -- the highlighter's colours included -- and so
 * are the pending row, the notices, the image card, the error card and the file each row links to.
 * SIX DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived in a normalizer:
 *
 *  - The file is the row's DESCRIPTION, where main wrote it into the title, so the row reads
 *    `Read: src/example.ts` where main read `Read src/example.ts`.
 *  - The gutter is three columns at every file size, where main's widened with the line count.
 *  - A resolved path and a truncation notice are plain toned lines, not bracketed asides.
 *  - A correction, an elided-span count and a conflict count are meta entries the host separates,
 *    where main wrote them into the title as parentheticals.
 *  - The collapsed window's held-back note hangs at the section's own indent, not past the gutter.
 *  - A tab in an image's details is widened, where main passed the byte through.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never calls `execute()`, so nothing here proves what a read
 * REPORTS: `test/tools/read*.test.ts` own that, and a `details` shape that changed meaning would be
 * drawn identically by both arms. It compares one theme, because the oracle and the view resolve the
 * same one. And it says nothing about the transcript component around the card -- merging a call with
 * its result, or the multi-target rows a delimited read expands into, are the component's.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatOutputNotice,
	formatTruncationMetaNotice,
	type TruncationMeta,
} from "@veyyon/coding-agent/tools/core/output-notice";
import type { ReadRenderArgs, ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { type ReadViewResult, readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import { readToolRenderer } from "../oracles/read-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

const WIDTHS = [200, WIDTH, 40];

/** Every OSC 8 target the rows carry, in the order they are drawn. */
function linkTargets(rows: readonly string[]): string[] {
	return rows.flatMap(row => [...row.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1] ?? ""));
}

describe("read tool differential", () => {
	const COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const EXPANDED_CONTEXT: ToolViewContext = { expanded: true, partial: false };
	const DISCLOSURES = [
		[COLLAPSED, HOST_COLLAPSED],
		[EXPANDED_CONTEXT, HOST_EXPANDED],
	] as const;

	function viewRows(result: ReadViewResult, context: ToolViewContext, args: ReadRenderArgs, width = WIDTH): string[] {
		return renderCompLines(drawToolView(readToolView.renderResult(result, context, args), theme), width);
	}

	function oracleRows(
		result: ReadViewResult,
		options: RenderResultOptions,
		args: ReadRenderArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(
			readToolRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails; isError?: boolean },
				options,
				theme,
				args,
			),
			width,
		);
	}

	function callViewRows(args: ReadRenderArgs, context: ToolViewContext, width = WIDTH): string[] {
		return renderCompLines(drawToolView(readToolView.renderCall(args, context), theme), width);
	}

	function callOracleRows(args: ReadRenderArgs, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(readToolRenderer.renderCall(args, options, theme), width);
	}

	/** The rows with every escape stripped, which is the comparison the exception cells run under. */
	function unstyled(rows: readonly string[]): string[] {
		return rows.map(row => stripVTControlCharacters(row).trimEnd());
	}

	/**
	 * Rows with the deliberate differences of a settled read normalized away, so what is left is the
	 * card's own content compared as terminal bytes.
	 *
	 * The rail's colour: every card the host frames carries a muted rail where main coloured it by
	 * state. The gutter's width: the host spends a constant three columns, so a number is compared by
	 * the number rather than by the cell it sits in, and the indent a wrapped row inherits from that
	 * cell with it. The row's fill: a framed block pads to its own widest row, which the first two
	 * differences move, so a row is compared without the padding they decide.
	 *
	 * Each is pinned in its own cell below, by exact string. Everything else -- the highlighter's
	 * colours, the tones, the words, the order -- is compared here byte for byte.
	 */
	function comparable(rows: readonly string[]): string[] {
		const rail = theme.symbol("block.rail");
		const railPattern = new RegExp(`^(\\x1b\\[49m)?\\x1b\\[[0-9;:]*m${rail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
		return rows.map(row =>
			row
				.replace(railPattern, `$1${rail}`)
				.replace(
					/ *(\x1b\[[0-9;:]*m)(\d*) (\x1b\[39m)/,
					(_match, open: string, number: string, close: string) => `${open}${number} ${close}`,
				)
				.replace(new RegExp(`^((?:\\x1b\\[49m)?${rail}(?:\\x1b\\[[0-9;:]*m)?) {2,}`, "u"), "$1 ")
				.replace(/ +(\x1b\[49m)?$/, "$1"),
		);
	}

	/** Unstyled rows with the gutter's own width normalized, which is the cell below this one. */
	function sameGutter(rows: readonly string[]): string[] {
		return rows.map(row => row.replace(/^(▏)\s{2,}(\d*)( )/u, "$1 $2$3"));
	}

	/** What a held-back note says, without the rail and mark the host draws it behind. */
	function noteWords(rows: readonly string[]): string {
		const row = rows.find(candidate => candidate.includes("more lines")) ?? "";
		return row.replace(/^▏\s*…\s*/u, "").trimEnd();
	}

	function detailsOf(text: string, extra: Partial<ReadToolDetails> = {}): ReadToolDetails {
		return { displayContent: { text, startLine: 1 }, contentType: "text/plain", ...extra };
	}

	function textResult(text: string, details?: ReadToolDetails): ReadViewResult {
		return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
	}

	const LONG = Array.from({ length: 30 }, (_unused, index) => `const value${index + 1} = ${index + 1};`).join("\n");

	it("draws the pending row byte for byte, over every way a call names its target", () => {
		const calls: ReadRenderArgs[] = [
			{},
			{ path: "" },
			{ path: "src/example.ts" },
			{ path: "/repo/src/example.ts:10-12" },
			{ path: "src/example.ts", offset: 40 },
			{ path: "src/example.ts", offset: 40, limit: 20 },
			{ path: "src/example.ts", limit: 20 },
			{ path: "local://handoff.md:2" },
			{ path: "notes.txt:raw" },
			{ file_path: "src/aliased.ts" },
			{ path: "docs/readme.md", raw: true },
			{ path: "archive.zip:dir/file.ts:50-60" },
			{ path: "db.sqlite:users:42" },
		];
		for (const args of calls) {
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(callViewRows(args, context, width)).toEqual(callOracleRows(args, options, width));
				}
			}
		}
		// Anti-vacuity: the pending row is the tool's name and the target it was asked for, selector
		// and range included, and a call with no path at all still draws a row.
		const named = stripVTControlCharacters(callViewRows(calls[5]!, COLLAPSED, 200).join("\n"));
		expect(named).toContain("Read: src/example.ts:40-59");
		expect(stripVTControlCharacters(callViewRows(calls[0]!, COLLAPSED, 200).join(""))).toContain("Read: …");
	});

	it("draws a url read byte for byte, which is the fetch card both arms hand it to", () => {
		const urls: ReadRenderArgs[] = [
			{ path: "https://example.com/docs" },
			{ path: "https://example.com/docs", raw: true },
			{ path: "https://example.com/docs:50-100" },
		];
		const details = {
			kind: "url" as const,
			url: "https://example.com/docs",
			finalUrl: "https://example.com/docs/final",
			contentType: "text/html",
			method: "reader",
			truncated: false,
			notes: [],
		};
		const settled = textResult("# Docs\n\nbody", details as ReadToolDetails);
		for (const args of urls) {
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(callViewRows(args, context, width)).toEqual(callOracleRows(args, options, width));
					expect(viewRows(settled, context, args, width)).toEqual(oracleRows(settled, options, args, width));
				}
			}
		}
		// Anti-vacuity: the card a url read draws is the fetch card, which states the host and the page
		// rather than a file row.
		expect(stripVTControlCharacters(viewRows(settled, COLLAPSED, urls[0]!, 200).join("\n"))).toContain("example.com");
	});

	it("draws the file's own rows byte for byte, highlighting, tabs and carriage returns included", () => {
		const files: Array<{ path: string; text: string; details?: Partial<ReadToolDetails> }> = [
			{ path: "src/example.ts", text: "export const x = 1;\nexport const y = 2;" },
			{ path: "src/example.ts", text: "\tconst indented = 1;\n\t\tconst deeper = 2;" },
			{ path: "src/example.ts", text: "const a = 1;\r\nconst b = 2;" },
			{ path: "notes.txt", text: "plain one\nplain two" },
			{ path: "src/example.py", text: "def main():\n    return 1" },
			{ path: "src/example.ts", text: "const only = 1;", details: { displayContent: { text: "", startLine: 40 } } },
			{ path: "Makefile", text: "all:\n\techo hi" },
		];
		for (const file of files) {
			const details = detailsOf(file.text, file.details ?? {});
			if (file.details?.displayContent) details.displayContent = { text: file.text, startLine: 40 };
			const result = textResult(file.text, details);
			const args: ReadRenderArgs = { path: file.path };
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					const drawn = comparable(viewRows(result, context, args, width));
					const oracle = comparable(oracleRows(result, options, args, width));
					// The header row is the one pinned difference of a settled read, compared in its own
					// cell below; every row of the file is compared as bytes.
					expect(drawn.slice(1)).toEqual(oracle.slice(1));
				}
			}
		}
		// Anti-vacuity: the rows carry the highlighter's own colours and a numbered gutter, not the
		// plain text of the file.
		const highlighted = viewRows(
			textResult("export const x = 1;", detailsOf("export const x = 1;")),
			COLLAPSED,
			{ path: "src/example.ts" },
			200,
		);
		// The block hoists the cell's leading pad out of the styled run, so the number and its one
		// trailing column are what the dim gutter run holds.
		expect(highlighted[1]).toContain(theme.fg("dim", "1 "));
		// The row is coloured by the highlighter rather than written as the file's plain text: the
		// literal `1` and the `;` after it are drawn in two colours neither of which is the gutter's.
		const colours = new Set([...(highlighted[1] ?? "").matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)].map(match => match[0]));
		expect(colours.size).toBeGreaterThanOrEqual(3);
	});

	it("numbers several windows onto one file byte for byte, blank gutters included", () => {
		const text = "const first = 1;\nconst gap = 2;\nconst last = 3;";
		const result = textResult(
			text,
			detailsOf(text, { displayContent: { text, startLine: 5, lineNumbers: [5, null, 973] } }),
		);
		const args: ReadRenderArgs = { path: "src/example.ts:5-16,960-973" };
		for (const [context, options] of DISCLOSURES) {
			for (const width of WIDTHS) {
				expect(comparable(viewRows(result, context, args, width)).slice(1)).toEqual(
					comparable(oracleRows(result, options, args, width)).slice(1),
				);
			}
		}
		// Anti-vacuity: the numbers a read states are the numbers drawn, a row it numbered `null` keeps
		// a blank cell of the same width, and the gutter is as wide as the file's last line.
		const rows = unstyled(viewRows(result, COLLAPSED, args, 200));
		expect(rows[1]).toStartWith("▏    5 const first");
		expect(rows[2]).toStartWith("▏      const gap");
		expect(rows[3]).toStartWith("▏  973 const last");
	});

	it("formats a markdown read as a document in both arms, and its bytes as source when raw was asked for", () => {
		const markdown = "# Title\n\nBody with `code` and a [link](https://example.com).\n\n- one\n- two\n";
		const asDocument = textResult(
			markdown,
			detailsOf(markdown, { contentType: "text/markdown", displayContent: { text: markdown, startLine: 1 } }),
		);
		const documentArgs: Array<ReadRenderArgs> = [{ path: "docs/readme.md" }];
		const sourceArgs: Array<ReadRenderArgs> = [{ path: "docs/readme.md", raw: true }, { path: "docs/readme.md:raw" }];
		for (const args of [...documentArgs, ...sourceArgs]) {
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(comparable(viewRows(asDocument, context, args, width)).slice(1)).toEqual(
						comparable(oracleRows(asDocument, options, args, width)).slice(1),
					);
				}
			}
		}
		// Anti-vacuity: the document arm formats the heading away and the raw arm keeps the `#`, so the
		// two are not the same card under a different name.
		const document = unstyled(viewRows(asDocument, COLLAPSED, documentArgs[0]!, 200)).join("\n");
		const source = unstyled(viewRows(asDocument, COLLAPSED, sourceArgs[0]!, 200)).join("\n");
		expect(document).toContain("Title");
		expect(document).not.toContain("# Title");
		expect(source).toContain("# Title");
	});

	it("draws the image card's rows, the read's own details included", () => {
		// A card reads the part's KIND and nothing else -- the picture itself goes to the model, and a
		// host that draws pictures reads the bytes off the result rather than off the card -- so the
		// fixtures carry the part without its payload.
		const images: ReadViewResult[] = [
			{
				content: [{ type: "image" }],
				details: { contentType: "image/png" },
			},
			{
				content: [{ type: "text", text: "image 800x600 png" }, { type: "image" }],
				details: { contentType: "image/png" },
			},
			{
				content: [{ type: "text", text: "image 800x600 png" }, { type: "image" }],
				details: {
					contentType: "image/png",
					suffixResolution: { from: "logo.png", to: "assets/logo.png" },
				},
			},
		];
		/** The same card carrying a notice, which is the one shape the brackets below change the wrap of. */
		const withNotice: ReadViewResult = {
			content: [{ type: "text", text: "image 800x600 png" }, { type: "image" }],
			details: { contentType: "image/png", resolvedPath: "/repo/assets/logo.png" },
		};
		const unbracketed = (rows: readonly string[]): string[] =>
			rows.map(row => row.replaceAll(theme.format.bracketLeft, "").replaceAll(theme.format.bracketRight, ""));
		for (const result of images) {
			const args: ReadRenderArgs = { path: "assets/logo.png" };
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					// The title's correction is pinned below; the card's own rows -- its status glyph, its
					// `Details` group and the read's own text -- are compared with escapes stripped.
					const drawn = unstyled(viewRows(result, context, args, width));
					const oracle = unstyled(oracleRows(result, options, args, width));
					expect(drawn.slice(1)).toEqual(oracle.slice(1));
				}
			}
			// The header row too, which an image card already stated as a description in both arms.
			expect(unstyled(viewRows(result, COLLAPSED, { path: "assets/logo.png" }, 200))[0]).toBe(
				unstyled(oracleRows(result, HOST_COLLAPSED, { path: "assets/logo.png" }, 200))[0]?.replace(
					" (corrected from logo.png)",
					" corrected from logo.png",
				),
			);
		}
		for (const [context, options] of DISCLOSURES) {
			// Wide enough that main's two bracket glyphs do not push the notice onto a second row, which
			// is the bracket exception below rather than a difference in what the card says.
			for (const width of [200, WIDTH]) {
				const args: ReadRenderArgs = { path: "assets/logo.png" };
				expect(unstyled(viewRows(withNotice, context, args, width))).toEqual(
					unbracketed(unstyled(oracleRows(withNotice, options, args, width))),
				);
			}
		}
		// Anti-vacuity: a picture with nothing said about it still draws a card, and it says so.
		expect(unstyled(viewRows(images[0]!, COLLAPSED, { path: "assets/logo.png" }, 200)).join("\n")).toContain(
			"(image)",
		);
	});

	it("draws the error card's rows byte for byte, over every shape an error arrives in", () => {
		const errors: ReadViewResult[] = [
			{ content: [{ type: "text", text: "Error: ENOENT: no such file" }], isError: true },
			{ content: [{ type: "text", text: "ENOENT: no such file\nat the second line" }], isError: true },
			{ content: [], isError: true },
			{
				content: [{ type: "text", text: "Error: is a directory" }],
				isError: true,
				details: { isDirectory: true, resolvedPath: "/repo/src" },
			},
			{ content: [{ type: "text", text: "Error: col\tumn" }], isError: true },
		];
		for (const result of errors) {
			const args: ReadRenderArgs = { path: "missing.ts" };
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(comparable(viewRows(result, context, args, width)).slice(1)).toEqual(
						comparable(oracleRows(result, options, args, width)).slice(1),
					);
				}
			}
		}
		// Anti-vacuity: the `Error:` prefix is dropped, the words are kept, and a result with no text
		// at all says what it can.
		const drawn = unstyled(viewRows(errors[0]!, COLLAPSED, { path: "missing.ts" }, 200)).join("\n");
		expect(drawn).toContain("ENOENT: no such file");
		expect(drawn).not.toContain("Error: ENOENT");
		expect(unstyled(viewRows(errors[2]!, COLLAPSED, { path: "missing.ts" }, 200)).join("\n")).toContain(
			"Unknown error",
		);
	});

	it("holds back the same lines of a collapsed file, and reveals them all when expanded", () => {
		const result = textResult(LONG, detailsOf(LONG));
		const args: ReadRenderArgs = { path: "src/long.ts" };
		for (const width of WIDTHS) {
			const collapsedRows = unstyled(viewRows(result, COLLAPSED, args, width));
			const collapsedOracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, width));
			const source = (rows: readonly string[]): string[] =>
				rows.filter(row => row.includes("const value")).map(row => row.replace(/^▏\s+\d+\s/, ""));
			expect(source(collapsedRows)).toEqual(source(collapsedOracle));
			expect(source(collapsedRows).length).toBe(12);
			// Both arms say the same thing about what they kept back; the row it hangs on is pinned
			// below.
			expect(noteWords(collapsedRows)).toBe(noteWords(collapsedOracle));
			expect(noteWords(collapsedRows)).toContain("18 more lines");
			// Expanded, the ceiling is two hundred rows in both arms, so the whole file is drawn and
			// neither says anything was held back.
			const expandedRows = unstyled(viewRows(result, EXPANDED_CONTEXT, args, width));
			expect(source(expandedRows)).toEqual(source(unstyled(oracleRows(result, HOST_EXPANDED, args, width))));
			expect(source(expandedRows).length).toBe(30);
			expect(expandedRows.some(row => row.includes("more lines"))).toBe(false);
		}
	});

	it("states the same notices as the renderer, over every bound a read can hit", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 900,
			totalBytes: 90_112,
			outputLines: 12,
			outputBytes: 2_048,
			artifactId: "abc123",
		};
		const cases: ReadToolDetails[] = [
			detailsOf("line one\nline two", { resolvedPath: "/repo/src/example.ts" }),
			detailsOf("line one\nline two", { meta: { truncation } }),
			detailsOf("line one\nline two", { resolvedPath: "/repo/src/example.ts", meta: { truncation } }),
			detailsOf("aaaa", {
				meta: { truncation: { ...truncation, artifactId: "art9" } },
				truncation: {
					firstLineExceedsLimit: true,
					outputBytes: 4_096,
					totalBytes: 99_999,
				} as ReadToolDetails["truncation"],
			}),
			detailsOf("aaaa", {
				meta: { truncation: { ...truncation, artifactId: undefined } },
				truncation: { firstLineExceedsLimit: true, totalBytes: 99_999 } as ReadToolDetails["truncation"],
			}),
		];
		for (const details of cases) {
			const result = textResult(details.displayContent?.text ?? "", details);
			const args: ReadRenderArgs = { path: "src/example.ts" };
			for (const [context, options] of DISCLOSURES) {
				const drawn = sameGutter(unstyled(viewRows(result, context, args, 200)));
				const oracle = sameGutter(
					unstyled(oracleRows(result, options, args, 200)).map(row =>
						row.replaceAll(theme.format.bracketLeft, "").replaceAll(theme.format.bracketRight, ""),
					),
				);
				expect(drawn.slice(1)).toEqual(oracle.slice(1));
			}
		}
		// Anti-vacuity: the notices are the sentences the notice module writes, under the group both
		// arms label `Output`.
		const withTruncation = unstyled(
			viewRows(textResult("line one", cases[2]!), COLLAPSED, { path: "src/example.ts" }, 200),
		).join("\n");
		expect(withTruncation).toContain("Output");
		expect(withTruncation).toContain("Resolved path: /repo/src/example.ts");
		expect(withTruncation).toContain(formatTruncationMetaNotice(truncation));
	});

	it("draws the file's own lines, not the anchors the model was handed", () => {
		const displayed = "export const x = 1;\nexport const y = 2;";
		const anchored = `[example.ts#1A2B]\n1:export const x = 1;\n2:export const y = 2;`;
		const result: ReadViewResult = { content: [{ type: "text", text: anchored }], details: detailsOf(displayed) };
		const args: ReadRenderArgs = { path: "src/example.ts" };
		for (const [context, options] of DISCLOSURES) {
			for (const width of WIDTHS) {
				expect(comparable(viewRows(result, context, args, width)).slice(1)).toEqual(
					comparable(oracleRows(result, options, args, width)).slice(1),
				);
			}
		}
		// Anti-vacuity: the anchors the model reads are not what the card shows, in either arm.
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200)).join("\n");
		expect(drawn).toContain("export const x = 1;");
		expect(drawn).not.toContain("#1A2B");
		expect(drawn).not.toContain("1:export");
	});

	it("states the truncation notice once, where the result's body already carried it", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 900,
			totalBytes: 90_112,
			outputLines: 2,
			outputBytes: 512,
			artifactId: "abc123",
		};
		const meta = { truncation };
		const appended = formatOutputNotice(meta);
		expect(appended.length).toBeGreaterThan(0);
		// The body the model was handed, notice and all, with no `displayContent` beside it -- which is
		// what a read reports when it has no structured window to state.
		const result: ReadViewResult = {
			content: [{ type: "text", text: `line one\nline two\n\n${appended}` }],
			details: { contentType: "text/plain", meta },
		};
		const args: ReadRenderArgs = { path: "src/example.ts" };
		for (const [context, options] of DISCLOSURES) {
			const drawn = sameGutter(unstyled(viewRows(result, context, args, 200)));
			const oracle = sameGutter(
				unstyled(oracleRows(result, options, args, 200)).map(row =>
					row.replaceAll(theme.format.bracketLeft, "").replaceAll(theme.format.bracketRight, ""),
				),
			);
			expect(drawn.slice(1)).toEqual(oracle.slice(1));
		}
		// Anti-vacuity: the sentence appears once, as the card's own notice, and not again in the body.
		const rows = unstyled(viewRows(result, COLLAPSED, args, 200));
		const sentence = formatTruncationMetaNotice(truncation);
		expect(rows.filter(row => row.includes(sentence)).length).toBe(1);
	});

	it("links the row to the same file the renderer linked, over every way a target is found", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const cases: Array<{ args: ReadRenderArgs; details?: ReadToolDetails }> = [
				{ args: { path: "/repo/src/example.ts" } },
				{ args: { path: "/repo/src/example.ts:10-12" } },
				{ args: { path: "src/example.ts" }, details: detailsOf("x", { resolvedPath: "/repo/src/example.ts" }) },
				{
					args: { path: "src/example.ts" },
					details: detailsOf("x", { meta: { source: { type: "path", value: "/repo/src/example.ts" } } }),
				},
				{
					args: { path: "src/example.ts", offset: 40 },
					details: detailsOf("x", { resolvedPath: "/repo/src/example.ts" }),
				},
				{
					args: { path: "archive.zip:dir/file.ts" },
					details: detailsOf("x", { resolvedPath: "/repo/archive.zip" }),
				},
			];
			const everyTarget: string[] = [];
			for (const { args, details } of cases) {
				const result = textResult("x", details ?? detailsOf("x"));
				for (const [context, options] of DISCLOSURES) {
					const drawn = linkTargets(viewRows(result, context, args, 200));
					const oracle = linkTargets(oracleRows(result, options, args, 200));
					expect(drawn).toEqual(oracle);
					everyTarget.push(...drawn);
				}
			}
			// Anti-vacuity: the comparison above is over links that exist, and an absolute path with no
			// resolution beside it is reachable on the strength of the argument alone.
			expect(everyTarget.length).toBeGreaterThan(cases.length);
			expect(
				linkTargets(viewRows(textResult("x", detailsOf("x")), COLLAPSED, { path: "/repo/src/example.ts" }, 200)),
			).toEqual(["file:///repo/src/example.ts"]);
			// The row points at the absolute file, at the line the selector starts on.
			const withSelector = linkTargets(
				viewRows(textResult("x", detailsOf("x")), COLLAPSED, { path: "/repo/src/example.ts:10-12" }, 200),
			);
			expect(withSelector[0]).toContain("/repo/src/example.ts");
			expect(withSelector[0]).toContain("line=10");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("resolves a carriage return inside a line to the row a screen would have shown", () => {
		const text = "progress 10%\rprogress 100%\nconst done = true;";
		const result = textResult(text, detailsOf(text));
		const args: ReadRenderArgs = { path: "src/example.ts" };
		for (const [context, options] of DISCLOSURES) {
			for (const width of WIDTHS) {
				expect(comparable(viewRows(result, context, args, width)).slice(1)).toEqual(
					comparable(oracleRows(result, options, args, width)).slice(1),
				);
			}
		}
		// Anti-vacuity: a return is a cursor sent back to column one, so the row is what was written
		// after the last of them and the byte itself never reaches the card.
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200));
		expect(drawn[1]).toContain("progress 100%");
		expect(drawn[1]).not.toContain("\r");
		expect(drawn[1]).not.toContain("progress 10%p");
	});

	it("exception cell: a tab in an image's details is widened, where main passed it through", () => {
		const result: ReadViewResult = {
			content: [{ type: "text", text: "800x600\tpng\t24KB" }, { type: "image" }],
			details: { contentType: "image/png" },
		};
		const args: ReadRenderArgs = { path: "assets/logo.png" };
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200));
		const oracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, 200));
		// A tab in a framed row opens a hole in the card rather than a column, because the frame's own
		// columns are counted in cells the tab does not know about. The rows of a code section are
		// widened by the host's highlighter; a row of prose is widened by the card that states it.
		expect(oracle.some(row => row.includes("\t"))).toBe(true);
		expect(drawn.some(row => row.includes("\t"))).toBe(false);
		expect(drawn.some(row => row.includes("800x600") && row.includes("png") && row.includes("24KB"))).toBe(true);
	});

	it("exception cell: the file is the row's description, where main wrote it into the title", () => {
		const result = textResult("const x = 1;", detailsOf("const x = 1;"));
		const args: ReadRenderArgs = { path: "src/example.ts" };
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200))[0] ?? "";
		const oracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, 200))[0] ?? "";
		// Main built its own title string, so the file arrived as part of the tool's name and the row
		// had no description at all. A view names the tool and states the file it read, which is the
		// shared row every converted card sits in, and the host writes the separator between them.
		expect(drawn).toContain("Read: src/example.ts");
		expect(oracle).toContain("Read src/example.ts");
		expect(oracle).not.toContain("Read: src/example.ts");
	});

	it("exception cell: the gutter is three columns at every file size", () => {
		const short = "const x = 1;";
		const result = textResult(short, detailsOf(short));
		const args: ReadRenderArgs = { path: "src/example.ts" };
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200));
		const oracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, 200));
		// Main sized the gutter to the last line number it was drawing, so a file crossing 10, 100 or
		// 1000 lines rewrote every row already on screen -- a streamed read then recommitted its whole
		// committed prefix into native scrollback. The host spends three columns through a 999-line
		// file, so a streamed row is byte-identical to the row the settled card draws, at the cost of
		// one column on a short file.
		expect(drawn[1]).toStartWith("▏    1 const x = 1;");
		expect(oracle[1]).toStartWith("▏   1 const x = 1;");
	});

	it("exception cell: a resolved path and a truncation notice are plain lines, not bracketed asides", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 900,
			totalBytes: 90_112,
			outputLines: 12,
			outputBytes: 2_048,
		};
		const details = detailsOf("line one", { resolvedPath: "/repo/src/example.ts", meta: { truncation } });
		const result = textResult("line one", details);
		const args: ReadRenderArgs = { path: "src/example.ts" };
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200));
		const oracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, 200));
		const message = formatTruncationMetaNotice(truncation);
		expect(message.length).toBeGreaterThan(0);
		// Same words in both arms. The brackets main drew around them are the theme's, which a tool
		// cannot name, so each notice arrives as a toned run and the host draws it plainly.
		expect(
			drawn
				.find(row => row.includes(message))
				?.trimEnd()
				.endsWith(message),
		).toBe(true);
		expect(oracle.find(row => row.includes(message))).toContain(theme.format.bracketLeft);
		expect(drawn.find(row => row.includes(message))).not.toContain(theme.format.bracketLeft);
		expect(oracle.find(row => row.includes("Resolved path"))).toContain(theme.format.bracketLeft);
		expect(drawn.find(row => row.includes("Resolved path"))).not.toContain(theme.format.bracketLeft);
	});

	it("exception cell: a correction, a summary and a conflict count are meta entries, not parentheticals", () => {
		const details = detailsOf("x", {
			displayContent: { text: "x", startLine: 5 },
			suffixResolution: { from: "example.ts", to: "src/example.ts" },
			summary: { lines: 40, elidedSpans: 3, elidedLines: 120 },
			conflictCount: 2,
		});
		const result = textResult("x", details);
		const args: ReadRenderArgs = { path: "example.ts", offset: 5, limit: 3 };
		const drawn = unstyled(viewRows(result, COLLAPSED, args, 200))[0] ?? "";
		const oracle = unstyled(oracleRows(result, HOST_COLLAPSED, args, 200))[0] ?? "";
		// Main wrote each fact into the title as a parenthetical, which put the correction between the
		// path and the range it was read at: `src/example.ts (corrected from example.ts):5-7`. The
		// three are facts about one read rather than parts of its name, so they are meta entries and
		// the host puts its own separator between them, leaving the description the file and its range.
		expect(oracle).toContain("Read src/example.ts (corrected from example.ts):5-7 (summary: 3 elided spans)");
		expect(oracle).toContain("(warn 2 conflicts)");
		expect(drawn).toContain("Read: src/example.ts:5-7");
		for (const fact of ["corrected from example.ts", "summary: 3 elided spans", "warn 2 conflicts"]) {
			expect(drawn).toContain(fact);
		}
		expect(drawn).not.toContain("(corrected from example.ts)");
	});

	it("exception cell: the held-back note hangs at the section's indent, not past the gutter", () => {
		const result = textResult(LONG, detailsOf(LONG));
		const args: ReadRenderArgs = { path: "src/long.ts" };
		const noteRow = (rows: readonly string[]): string => rows.find(row => row.includes("more lines")) ?? "";
		const drawn = noteRow(unstyled(viewRows(result, COLLAPSED, args, 200)));
		const oracle = noteRow(unstyled(oracleRows(result, HOST_COLLAPSED, args, 200)));
		// Main indented the note into the code's column, under the gutter it had just drawn. The note
		// is the section's, not the file's -- no line of the file is numbered by it -- so the host
		// writes it at the indent every other row of a section starts at.
		expect(drawn).toStartWith("▏  …");
		expect(oracle).toStartWith("▏     …");
		expect(noteWords([drawn])).toBe(noteWords([oracle]));
	});
});
