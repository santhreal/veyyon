/**
 * The `browser` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 *
 * The tool has three actions and two card shapes, so both are swept: the `open` and `close` row over
 * every action, every browser kind the registry can report and every outcome, and the `run` panel
 * over the script, its output, both ceilings and four terminal widths. The browser kinds and the
 * actions are recorded as total records of their own unions, so a fifth kind or a fourth action fails
 * the type check here rather than going uncompared.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatOutputNotice,
	formatTruncationMetaNotice,
	type TruncationMeta,
} from "@veyyon/coding-agent/tools/core/output-notice";
import { replaceTabs, shortenPath } from "@veyyon/coding-agent/tools/core/render-utils";
import type { BrowserParams, BrowserToolDetails } from "@veyyon/coding-agent/tools/web/browser";
import {
	type BrowserViewArgs,
	type BrowserViewResult,
	browserToolView,
} from "@veyyon/coding-agent/tools/web/browser/view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ToolView, ToolViewContext } from "@veyyon/view";
import * as browserOracle from "../oracles/browser-main-renderer";
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

/**
 * Every browser kind a result can report, as a total record of the registry's own union.
 *
 * A tag the union grows fails the type check here, which is the only way a run-time sweep can be
 * total over a union: the tags exist at compile time alone, so the list is checked by the compiler
 * and read by the loop below.
 */
const BROWSER_KINDS: Record<NonNullable<BrowserToolDetails["browser"]>, true> = {
	headless: true,
	spawned: true,
	connected: true,
	cmux: true,
};

/** Every action the tool takes, as a total record of the schema's own union. */
const ACTIONS: Record<BrowserParams["action"], true> = { open: true, close: true, run: true };

const KINDS = Object.keys(BROWSER_KINDS) as Array<NonNullable<BrowserToolDetails["browser"]>>;
const EVERY_ACTION = Object.keys(ACTIONS) as Array<BrowserParams["action"]>;
const WIDTHS = [200, WIDTH, 40];
const DISCLOSURES = [
	[COLLAPSED, HOST_COLLAPSED],
	[EXPANDED, HOST_EXPANDED],
] as const;

/**
 * Rows with the colour of the frame's rail dropped, so a comparison is about the content of the card.
 *
 * The rail is the one thing a converted panel draws differently on purpose: every card the host
 * frames from a view carries a muted rail, where main coloured it by the cell's state. Kept out of
 * the row comparisons and asserted on its own, so a real regression in the rows is not buried under a
 * colour that was changed deliberately.
 */
function sameRailColour(rows: readonly string[]): string[] {
	const rail = theme.symbol("block.rail");
	const pattern = new RegExp(`^(\\x1b\\[49m)?\\x1b\\[[0-9;:]*m${rail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
	return rows.map(row => row.replace(pattern, `$1${rail}`));
}

describe("browser tool differential", () => {
	const URL = "https://example.com/docs/getting-started";
	const CODE = Array.from({ length: 18 }, (_unused, index) => `const value${index + 1} = ${index + 1};`).join("\n");

	function viewLines(view: ToolView, width = WIDTH, spinnerFrame?: number): string[] {
		return renderCompLines(drawToolView(view, theme, spinnerFrame), width);
	}

	function callView(args: BrowserViewArgs, context: ToolViewContext, width = WIDTH): string[] {
		return viewLines(browserToolView.renderCall(args, context), width, context.frame);
	}

	function callOracle(args: BrowserViewArgs, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(browserOracle.browserToolRenderer.renderCall(args, options, theme), width);
	}

	function resultView(
		result: BrowserViewResult,
		context: ToolViewContext,
		args: BrowserViewArgs,
		width = WIDTH,
	): string[] {
		return viewLines(browserToolView.renderResult(result, context, args), width, context.frame);
	}

	function resultOracle(
		result: BrowserViewResult,
		options: RenderResultOptions,
		args: BrowserViewArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(browserOracle.browserToolRenderer.renderResult(result, options, theme, args), width);
	}

	it("draws the tab row byte for byte, over every action, every browser kind and every outcome", () => {
		for (const action of EVERY_ACTION) {
			if (action === "run") continue;
			for (const kind of KINDS) {
				const args: BrowserViewArgs = { action, name: "docs", url: "https://example.com/asked-for" };
				const settled: BrowserViewResult = {
					content: [],
					// The tab and the url the RESULT reports, both differing from what was asked for, so
					// a card that read either off the arguments draws a different row.
					details: { action, name: "landed", url: URL, browser: kind },
				};
				const failed: BrowserViewResult = { ...settled, isError: true };
				for (const [context, options] of DISCLOSURES) {
					for (const width of WIDTHS) {
						expect(resultView(settled, context, args, width)).toEqual(
							resultOracle(settled, options, args, width),
						);
						expect(resultView(failed, context, args, width)).toEqual(resultOracle(failed, options, args, width));
						// The call row, whose browser kind comes from the arguments alone because a call
						// has no result to read it off.
						expect(callView(args, context, width)).toEqual(callOracle(args, options, width));
						// A partial tab row, drawn without a spinner frame because the tool's registry
						// entry animates the `run` card alone: an `open` is one operation that either
						// happened or has not yet, so nothing on the row changes between frames.
						const partial: ToolViewContext = { ...context, partial: true };
						const hostPartial: RenderResultOptions = { ...options, isPartial: true };
						expect(resultView(settled, partial, args, width)).toEqual(
							resultOracle(settled, hostPartial, args, width),
						);
					}
				}
			}
		}
		// Anti-vacuity: the compared row names the operation, the tab, the browser and the url, and a
		// settled row is titled by the tool's own mark rather than by an outcome icon.
		const drawn = resultView(
			{ content: [], details: { action: "open", name: "docs", url: URL, browser: "headless" } },
			COLLAPSED,
			{ action: "open", name: "docs", url: URL },
			200,
		);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain('Open tab "docs"');
		expect(flat).toContain("headless");
		expect(flat).toContain("example.com/docs/getting-started");
		expect(drawn.join("\n")).toContain(theme.styledSymbol("tool.browser", "accent"));
	});

	it("draws every way a close names its tabs byte for byte: all, one, and killed", () => {
		const closes: BrowserViewArgs[] = [
			{ action: "close", all: true },
			{ action: "close" },
			{ action: "close", name: "docs" },
			{ action: "close", name: "docs", kill: true },
			{ action: "close", all: true, kill: true },
		];
		for (const args of closes) {
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(callView(args, context, width)).toEqual(callOracle(args, options, width));
					const result: BrowserViewResult = { content: [], details: { action: "close", name: args.name } };
					expect(resultView(result, context, args, width)).toEqual(resultOracle(result, options, args, width));
				}
			}
		}
		// Anti-vacuity: a close with no tab named closes all of them, and `kill` is stated on the row.
		expect(stripVTControlCharacters(callView(closes[1]!, COLLAPSED, 200).join("\n"))).toContain("Close all tabs");
		expect(stripVTControlCharacters(callView(closes[3]!, COLLAPSED, 200).join("\n"))).toContain(
			'Close tab "docs" (kill)',
		);
	});

	it("draws the browser kind the arguments name byte for byte, over every way of naming one", () => {
		const spawns: BrowserViewArgs[] = [
			{ action: "open", app: { cdp_url: "http://127.0.0.1:9222" } },
			{ action: "open", app: { path: join(homedir(), "apps/Cursor/Cursor") } },
			{ action: "open", app: { cmux: true } },
			{ action: "open", app: { surface: "left" } },
			{ action: "open", app: { cmux: false, surface: "left" } },
			{ action: "open", app: { cmux: true, surface: "left" } },
		];
		for (const args of spawns) {
			for (const [context, options] of DISCLOSURES) {
				for (const width of WIDTHS) {
					expect(callView(args, context, width)).toEqual(callOracle(args, options, width));
				}
			}
		}
		// Anti-vacuity: the arguments answer over the result's own tag, and a cmux surface is named.
		const connected: BrowserViewResult = { content: [], details: { action: "open", browser: "headless" } };
		expect(stripVTControlCharacters(resultView(connected, COLLAPSED, spawns[0]!, 200).join("\n"))).toContain(
			"connected http://127.0.0.1:9222",
		);
		expect(stripVTControlCharacters(callView(spawns[5]!, COLLAPSED, 200).join("\n"))).toContain("cmux left");
		expect(stripVTControlCharacters(callView(spawns[4]!, COLLAPSED, 200).join("\n"))).not.toContain("cmux");
		// A spawned binary under the home directory is named the way a reader recognises it.
		expect(stripVTControlCharacters(callView(spawns[1]!, COLLAPSED, 200).join("\n"))).toContain(
			"spawned ~/apps/Cursor/Cursor",
		);
	});

	it("draws the script's rows byte for byte: the highlighting, the tabs and the carriage returns", () => {
		const scripts = [
			CODE,
			"await tab.goto('https://example.com');\n\tawait tab.click('text/Sign in');",
			"const rows = 1;\r\nconst cols = 2;",
			"progress 10%\rprogress 100%\nconst done = true;",
			"const trailing = 1;\n\n\n",
		];
		for (const code of scripts) {
			const args: BrowserViewArgs = { action: "run", name: "docs", code };
			for (const width of WIDTHS) {
				// Expanded: the ceiling is the same 200 rows in both arms, so nothing is held back and
				// every row of the panel below the header is the script.
				expect(sameRailColour(resultView({ content: [] }, EXPANDED, args, width)).slice(1)).toEqual(
					sameRailColour(resultOracle({ content: [] }, HOST_EXPANDED, args, width)).slice(1),
				);
				// Collapsed: the same rows, and the held-back note last. Both arms write that note's
				// words in the same colour; only the escapes around the reveal hint differ, since main
				// opened one dim run over both halves and closed it twice where the host closes its own
				// run before appending the hint. So the note is compared by its words.
				const view = sameRailColour(resultView({ content: [] }, COLLAPSED, args, width));
				const oracle = sameRailColour(resultOracle({ content: [] }, HOST_COLLAPSED, args, width));
				expect(view.slice(1, -1)).toEqual(oracle.slice(1, -1));
				expect(stripVTControlCharacters(view.at(-1) ?? "")).toEqual(stripVTControlCharacters(oracle.at(-1) ?? ""));
				// The call card, which is the panel the script appears in as the model writes it.
				expect(sameRailColour(callView(args, EXPANDED, width)).slice(1)).toEqual(
					sameRailColour(callOracle(args, HOST_EXPANDED, width)).slice(1),
				);
			}
		}
		// A rebuilt transcript that has the result and not the call: the panel is chosen from what the
		// result reports, and the script is the one thing it cannot then show. Main framed a blank row
		// where the script would have been; the card states no section for a script it does not have.
		const rebuilt: BrowserViewResult = {
			content: [{ type: "text", text: "12" }],
			details: { action: "run", name: "docs" },
		};
		for (const width of WIDTHS) {
			const view = sameRailColour(resultView(rebuilt, EXPANDED, {}, width));
			const oracle = sameRailColour(resultOracle(rebuilt, HOST_EXPANDED, {}, width));
			expect(view.slice(1)).toEqual(oracle.slice(2));
			expect(stripVTControlCharacters(oracle[1] ?? "").trim()).toEqual("▏");
		}
		// Anti-vacuity: the compared rows carry the script's own text, the tab is spent, and the
		// collapsed panel stops at its ceiling where the expanded one does not.
		const flat = stripVTControlCharacters(
			resultView({ content: [] }, COLLAPSED, { action: "run", code: CODE }, 200).join("\n"),
		);
		expect(flat).toContain("const value1 = 1;");
		expect(flat).toContain("const value10 = 10;");
		expect(flat).not.toContain("const value11 = 11;");
		expect(
			stripVTControlCharacters(resultView({ content: [] }, EXPANDED, { action: "run", code: CODE }, 200).join("\n")),
		).toContain("const value18 = 18;");
		expect(
			stripVTControlCharacters(
				resultView({ content: [] }, COLLAPSED, { action: "run", code: scripts[1]! }, 200).join("\n"),
			),
		).toContain("    await tab.click");
	});

	it("draws the script's output byte for byte, in its own group and under both ceilings", () => {
		const outputs = [
			"12",
			Array.from({ length: 24 }, (_unused, index) => `row ${index + 1}`).join("\n"),
			// Past the expanded ceiling, where the arm that shows everything still stops.
			Array.from({ length: 260 }, (_unused, index) => `row ${index + 1}`).join("\n"),
			"   \n  \n",
			"one\ttwo",
		];
		const args: BrowserViewArgs = { action: "run", name: "docs", code: "return 12;" };
		for (const text of outputs) {
			for (const isError of [false, true]) {
				const result: BrowserViewResult = {
					content: [{ type: "text", text }],
					details: { action: "run", name: "docs" },
					...(isError ? { isError: true } : {}),
				};
				for (const width of WIDTHS) {
					expect(sameRailColour(resultView(result, EXPANDED, args, width)).slice(1)).toEqual(
						sameRailColour(resultOracle(result, HOST_EXPANDED, args, width)).slice(1),
					);
					// The held-back note is the last row, compared by its words for the reason the
					// script's rows are: main's escapes around the reveal hint differ from the host's.
					const view = sameRailColour(resultView(result, COLLAPSED, args, width));
					const oracle = sameRailColour(resultOracle(result, HOST_COLLAPSED, args, width));
					expect(view.slice(1, -1)).toEqual(oracle.slice(1, -1));
					expect(stripVTControlCharacters(view.at(-1) ?? "")).toEqual(
						stripVTControlCharacters(oracle.at(-1) ?? ""),
					);
				}
			}
		}
		// Anti-vacuity: the output is labelled, toned as output, and capped at the collapsed ceiling.
		const result: BrowserViewResult = {
			content: [{ type: "text", text: outputs[1]! }],
			details: { action: "run", name: "docs" },
		};
		const drawn = resultView(result, COLLAPSED, args, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Output");
		expect(flat).toContain("row 10");
		expect(flat).not.toContain("row 11");
		expect(flat).toContain("… 14 more lines");
		expect(drawn.join("\n")).toContain(theme.fg("toolOutput", "row 1"));
		expect(stripVTControlCharacters(resultView(result, EXPANDED, args, 200).join("\n"))).toContain("row 24");
	});

	it("frames the panel with the host's muted rail, where main coloured the rail by the state", () => {
		const args: BrowserViewArgs = { action: "run", code: "return 1;" };
		const rail = theme.symbol("block.rail");
		// A converted card is framed the way every other converted card is, so a settled panel states
		// its outcome in its head row and not a second time on its edge.
		expect(resultView({ content: [] }, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail));
		expect(resultOracle({ content: [] }, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("dim", rail));
		// A failure is the one state both arms agree on, because a failed card says so on its edge.
		const failed: BrowserViewResult = { content: [{ type: "text", text: "boom" }], isError: true };
		expect(resultView(failed, EXPANDED, args, 200)[0]).toContain(theme.fg("error", rail));
		expect(resultOracle(failed, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("error", rail));
	});

	it("titles the panel with the tab byte for byte, and sets the url and the browser beside it", () => {
		const bare: BrowserViewArgs = { action: "run", name: "docs", code: "return 1;" };
		// The head row of a panel that names nothing but its tab, in both outcomes: same icon, same
		// title, same colour.
		for (const result of [{ content: [] }, { content: [{ type: "text", text: "boom" }], isError: true }]) {
			for (const width of WIDTHS) {
				expect(sameRailColour(resultView(result, EXPANDED, bare, width))[0]).toEqual(
					sameRailColour(resultOracle(result, HOST_EXPANDED, bare, width))[0],
				);
			}
		}
		// Main joined the tab, the url and the browser into one title and put its own separator
		// between them. The card states the tab as the row's subject, the url as what the row is about
		// and the browser as trailing detail, so the host is the one that separates them.
		const named: BrowserViewArgs = { action: "run", name: "docs", url: URL, code: "return 1;" };
		const details: BrowserToolDetails = { action: "run", name: "docs", url: URL, browser: "headless" };
		const drawn = resultView({ content: [], details }, EXPANDED, named, 200)[0] ?? "";
		const oracle = resultOracle({ content: [], details }, HOST_EXPANDED, named, 200)[0] ?? "";
		const flat = stripVTControlCharacters(drawn);
		expect(flat).toContain('tab "docs"');
		expect(flat).toContain("example.com/docs/getting-started");
		expect(flat).toContain("headless");
		expect(stripVTControlCharacters(oracle)).toContain(`tab "docs" ${theme.sep.dot.trim()}`.trimEnd());
		expect(drawn).toContain(theme.fg("accent", shortenPath(URL)));
		expect(oracle).not.toContain(theme.fg("accent", shortenPath(URL)));
	});

	it("indents what open and close printed, where main left it in column zero", () => {
		const args: BrowserViewArgs = { action: "open", name: "docs", url: URL };
		const result: BrowserViewResult = {
			content: [{ type: "text", text: "opened\tdocs\nviewport 1280x720" }],
			details: { action: "open", name: "docs", url: URL, browser: "headless" },
		};
		const drawn = resultView(result, COLLAPSED, args, 200);
		const oracle = resultOracle(result, HOST_COLLAPSED, args, 200);
		// The header is the same row in both arms; the rows under it are the tool's own lines, which
		// the host now sets in the two columns every block's lines sit in.
		expect(drawn[0]).toEqual(oracle[0]);
		expect(stripVTControlCharacters(drawn.slice(1).join("\n"))).toEqual(
			stripVTControlCharacters(oracle.slice(1).join("\n"))
				.split("\n")
				.map(row => `  ${row}`)
				.join("\n"),
		);
		expect(drawn.slice(1).join("\n")).toContain(theme.fg("toolOutput", replaceTabs("opened\tdocs")));
	});

	it("states a cut-short output inside the card, where main appended it below the frame", () => {
		const args: BrowserViewArgs = { action: "run", code: "return big();" };
		const truncation: TruncationMeta = {
			direction: "head",
			truncatedBy: "bytes",
			totalLines: 400,
			totalBytes: 40_000,
			outputLines: 120,
			outputBytes: 30_000,
			maxBytes: 30_000,
			shownRange: { start: 1, end: 120 },
			artifactId: "abc123",
		};
		const result: BrowserViewResult = {
			// The tool appends the same sentence to its text for the model. The card states it once,
			// which means stripping the copy the model was sent.
			content: [{ type: "text", text: `row one${formatOutputNotice({ truncation })}` }],
			details: { action: "run", meta: { truncation } },
		};
		const sentence = formatTruncationMetaNotice(truncation);
		const drawn = resultView(result, EXPANDED, args, 200);
		const oracle = resultOracle(result, HOST_EXPANDED, args, 200);
		// The same sentence about the same output, in both arms.
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain(sentence);
		expect(stripVTControlCharacters(oracle.join("\n"))).toContain(sentence);
		// Main appended the row BELOW the frame, so the notice about the panel's output sat outside the
		// panel and carried no rail. The card states it as its own group, inside the frame it is about,
		// and the theme's brackets are gone with it: a bracket is chrome, and a card that named one
		// would be drawing.
		const noticeRow = (rows: readonly string[]): string =>
			rows.find(row => stripVTControlCharacters(row).includes(sentence)) ?? "";
		expect(noticeRow(drawn)).toContain(theme.symbol("block.rail"));
		expect(noticeRow(oracle)).not.toContain(theme.symbol("block.rail"));
		expect(stripVTControlCharacters(noticeRow(oracle))).toContain(theme.format.bracketLeft);
		expect(stripVTControlCharacters(noticeRow(drawn))).not.toContain(theme.format.bracketLeft);
		// Both arms colour the notice as a warning, which is what the tool states about it.
		expect(noticeRow(drawn)).toContain(theme.getFgAnsi("warning"));
		expect(noticeRow(oracle)).toContain(theme.getFgAnsi("warning"));
	});

	it("closes a captured screen row's styles, where main forwarded the program's escapes raw", () => {
		const args: BrowserViewArgs = { action: "run", code: "return screen();" };
		const truecolor = "\x1b[38;2;200;40;40m";
		const result: BrowserViewResult = {
			content: [{ type: "text", text: `\x1b[31mbasic row\x1b[0m\n${truecolor}chosen row\nplain row` }],
			details: { action: "run" },
		};
		const drawn = resultView(result, EXPANDED, args, 200).join("\n");
		const oracle = resultOracle(result, HOST_EXPANDED, args, 200).join("\n");
		// Every row keeps its words in both arms.
		for (const row of ["basic row", "chosen row", "plain row"]) {
			expect(stripVTControlCharacters(drawn)).toContain(row);
			expect(stripVTControlCharacters(oracle)).toContain(row);
		}
		// A colour the program stated in full is replayed; a legacy colour code is not, because the
		// card draws the row over the ground the theme gives output and an unclosed legacy colour
		// bleeds into the rows after it. Main forwarded both escapes untouched and coloured neither
		// row itself.
		expect(drawn).toContain(truecolor);
		expect(oracle).toContain(truecolor);
		expect(oracle).toContain("\x1b[31m");
		expect(drawn).not.toContain("\x1b[31m");
		expect(drawn).toContain(theme.getFgAnsi("toolOutput"));
	});

	it("says what is running on a row of its own, where main said it in the panel's head row", () => {
		const args: BrowserViewArgs = { action: "run", name: "docs", code: "await tab.goto(url);" };
		const partial: ToolViewContext = { expanded: false, partial: true, frame: 2 };
		const drawn = stripVTControlCharacters(resultView({ content: [] }, partial, args, 200).join("\n"));
		const oracle = stripVTControlCharacters(
			resultOracle({ content: [] }, { expanded: false, isPartial: true, spinnerFrame: 2 }, args, 200).join("\n"),
		);
		expect(drawn).toContain("(streaming)");
		expect(oracle).toContain("running");
		// The head row of a streaming panel carries no animated glyph, which is what lets a growing
		// panel scroll-append: main's head row carried both the spinner and the word.
		expect(drawn.split("\n")[0]).toContain('tab "docs"');
		expect(drawn.split("\n")[0]).not.toContain("running");
	});

	/**
	 * The two things a byte comparison cannot see, asserted on the view itself.
	 *
	 * This terminal's highlighter reads javascript and typescript with one grammar, and its palette
	 * gives `muted` and `toolOutput` the same colour, so a card that named the wrong language or the
	 * wrong tone draws the same bytes here and a different card in a host that tells them apart. Both
	 * are stated in the value, which is the contract a second host reads.
	 */
	it("states the language of the script and the role of every output row", () => {
		const args: BrowserViewArgs = { action: "run", name: "docs", code: "return 1;\nreturn 2;" };
		const result: BrowserViewResult = {
			content: [{ type: "text", text: `plain\n\x1b[38;2;1;2;3mscreen\n${"more\n".repeat(12)}` }],
			details: { action: "run", name: "docs" },
		};
		const panel = framedView(browserToolView.renderResult(result, COLLAPSED, args));
		const [code, output] = panel.sections;
		expect(code?.code?.language).toEqual("javascript");
		// The script's rows carry text and nothing else: a tool that toned its own keywords would be
		// writing a colour scheme.
		expect(code?.lines.flat().every(span => span.tone === undefined && span.captured === undefined)).toBe(true);
		expect(output?.label).toEqual("Output");
		expect(output?.lines[0]).toEqual([{ text: "plain", tone: "output" }]);
		expect(output?.lines[1]).toEqual([{ text: "\x1b[38;2;1;2;3mscreen", captured: true }]);
		expect(output?.hidden).toEqual({ count: 4, noun: { one: "line", many: "lines" }, revealable: true });
		// Expanded, the same card asks for nothing further, because there is nothing further to ask
		// for: the reveal gesture belongs to a card that is still holding rows back.
		const opened = framedView(browserToolView.renderResult(result, EXPANDED, args));
		expect(opened.sections[1]?.hidden).toBeUndefined();
	});
});
