/**
 * The `web_search` card draws what main's renderer drew.
 *
 * Every arm a query passes through is compared as terminal bytes -- the pending row, the answer's
 * markdown, the source rows, the metadata, the collapsed budgets, the unreadable-response fallback
 * and the error panel. EIGHT DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived silently:
 *
 *  - The settled card leaves the plate alone, where main opened and closed a background run on every
 *    row and padded each to the block's own width. The answer and its sources are what a provider
 *    returned, so the outcome is stated on the card's edge instead of across its ground.
 *  - A warning outcome keeps the settled rail, where main coloured the rail warning. The state shows
 *    in the header's icon, which both arms draw the same way.
 *  - A `Name: value` row's value is a bare run, where main wrapped it in the theme's `text` colour --
 *    which in this preset is an empty pair: a reset, the value, another reset.
 *  - A source's domain and age sit at the END of the row, where main placed them immediately after
 *    the title it had cut to make room for them, joined by the theme's dot glyph.
 *  - The facts of the usage row are joined by the card's own comma, where main joined them with that
 *    same dot. A host puts nothing between two runs it was handed, so the words are the tool's.
 *  - A held-back count is dim and carries the host's expand gesture, where main wrote a muted count
 *    and no gesture.
 *  - A compact caller's answer cap counts the answer's OWN lines, where main counted the rows a
 *    terminal wrapped them into, so the two arms state a different number of held-back lines.
 *  - A fallback line too long for the card ends at the margin, where main cut it with an ellipsis.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never runs a query, so nothing here proves what a search
 * REPORTS: `test/web/search/*.test.ts` own that, and a `details` shape whose meaning changed would be
 * drawn identically by both arms. It compares one theme, so two tones that resolve to one colour in
 * it are indistinguishable here, and in this preset `text` resolves to no colour at all. Neither arm
 * emits OSC 8 under the test terminal, so a source's link TARGET is proved by the unit suite rather
 * than by these bytes. The provider labels come from the provider table, so a renamed provider moves
 * both arms together.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { SearchRenderDetails, SearchResponse } from "@veyyon/coding-agent/web/search/types";
import {
	type WebSearchViewArgs,
	type WebSearchViewResult,
	webSearchToolView,
} from "@veyyon/coding-agent/web/search/view";
import type { ToolViewContext } from "@veyyon/view";
import { webSearchToolRenderer } from "../oracles/web-search-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

const WIDTHS = [200, WIDTH, 40];
const CLOSE = "\u001b[39m";

const ANSWER = ["## Overview", "The **first** paragraph.", "", "Para two.", "Para three.", "Para four."].join("\n");

/**
 * The escape that opens one theme colour, without the close the theme pairs with it.
 *
 * Read inside a cell rather than at module scope, because the theme is loaded by the harness in
 * `beforeAll` and a colour read while the file is being evaluated has no theme to read from.
 */
function colorOpen(color: "accent" | "dim" | "muted" | "warning"): string {
	const run = theme.fg(color, "");
	return run.slice(0, run.length - CLOSE.length);
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
	return {
		provider: "perplexity",
		answer: ANSWER,
		sources: [
			{ title: "Src One", url: "https://example.com/a", ageSeconds: 3600 },
			{ title: "Src Two", url: "https://docs.example.org/b/page" },
		],
		model: "sonar",
		authMode: "api_key",
		usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, searchRequests: 2 },
		...overrides,
	};
}

function found(overrides: Partial<SearchResponse> = {}): WebSearchViewResult {
	const built = response(overrides);
	return { content: [{ type: "text", text: built.answer ?? "" }], details: { response: built } };
}

function manySources(): WebSearchViewResult {
	return found({
		sources: Array.from({ length: 12 }, (_, index) => ({
			title: `Source Result ${index}`,
			url: `https://example.com/res${index}`,
		})),
	});
}

describe("web_search tool differential", () => {
	const COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const EXPANDED: ToolViewContext = { expanded: true, partial: false };
	const DISCLOSURES = [
		[COLLAPSED, HOST_COLLAPSED],
		[EXPANDED, HOST_EXPANDED],
	] as const;

	function viewRows(
		result: WebSearchViewResult,
		context: ToolViewContext,
		args?: WebSearchViewArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(webSearchToolView.renderResult(result, context, args), theme), width);
	}

	function oracleRows(
		result: WebSearchViewResult,
		options: RenderResultOptions,
		args?: WebSearchViewArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(
			webSearchToolRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
				options,
				theme,
				args,
			),
			width,
		);
	}

	/** The rows with every escape stripped, which is the comparison an exception cell runs under. */
	function unstyled(rows: readonly string[]): string[] {
		return rows.map(row => stripVTControlCharacters(row).trimEnd());
	}

	/** A row of the sources section, which only a domain in parentheses carries. */
	const SOURCE_ROW = /\([^)\s]*\.[a-z]{2,}\)/;

	/**
	 * The row with every reset that closes nothing dropped, which is what main's `text` colour is in
	 * this preset: `theme.fg("text", value)` opens no colour and closes twice, so a value arrives as a
	 * reset, the text, and a second reset. A row the host wrapped carries the halves of that pair on
	 * two rows, so the scan is over openness rather than over a pattern: every real run keeps its own
	 * close, and a colour extent that changed still fails the comparison.
	 */
	function withoutIdleResets(row: string): string {
		const escape = /\x1b\[[0-9;:]*m/g;
		let out = "";
		let read = 0;
		let open = false;
		for (let match = escape.exec(row); match !== null; match = escape.exec(row)) {
			const code = match[0];
			out += row.slice(read, match.index);
			read = match.index + code.length;
			if (code === "\x1b[39m" || code === "\x1b[0m") {
				if (open) out += code;
				open = false;
				continue;
			}
			if (/^\x1b\[(?:3[0-7]|9[0-7]|38;)/.test(code)) open = true;
			out += code;
		}
		return out + row.slice(read);
	}

	/**
	 * Rows with the deliberate differences of a settled card normalized away, so what is left is the
	 * card's own content compared as terminal bytes.
	 *
	 * Four normalizations, each pinned in its own cell below. The plate: main opened a background run
	 * on every row and padded it to the block's width, where a card of fetched data leaves the ground
	 * alone. The idle resets above, which are main's `text` colour. The separator: main joined the
	 * facts of a row with the theme's dot where the card states its own comma. And a source row, whose
	 * tail moved to the end of the row, is compared as its WORDS -- the tones of its two tail runs are
	 * pinned below instead.
	 *
	 * Everything else -- the tones, the words, the markdown, the order, the counts, the section labels
	 * -- is compared here byte for byte. What the separator rule costs is a comma inside prose, which
	 * both arms carry from one source and neither invents.
	 */
	function comparable(rows: readonly string[]): string[] {
		const dot = new RegExp(theme.sep.dot, "g");
		return rows.map(row => {
			const plateless = row.replaceAll("\u001b[49m", "");
			const words = SOURCE_ROW.test(plateless) ? stripVTControlCharacters(plateless) : plateless;
			return withoutIdleResets(words)
				// A held-back note, as the count and the unit both arms state.
				.replace(/(?:\x1b\[[0-9;:]*m)*(… \d+ more \w+).*$/u, "$1")
				// Either arm's separator between the facts of one row, including the one left at the end of a
				// row the host wrapped mid-list.
				.replace(dot, " ")
				.replace(/, /g, " ")
				// Whitespace a tail's placement and a plate's fill decide.
				.replace(/ {2,}/g, " ")
				.trimEnd()
				.replace(/,$/, "");
		});
	}

	/**
	 * Comparable rows with the rail's own colour normalized away, for the two cards whose outcome is a
	 * warning: main coloured the rail, and a view names no rail colour at all. Used only where that
	 * difference is the point, so a rail regression on a settled card still fails a cell above.
	 */
	function railAgnostic(rows: readonly string[]): string[] {
		return comparable(rows).map(row => row.replace(/^\x1b\[38;2;\d+;\d+;\d+m(?=\S)/, ""));
	}

	describe("the pending row", () => {
		for (const width of WIDTHS) {
			it(`draws the query at ${width} columns`, () => {
				const args = { query: "what changed in bun 1.3" };
				expect(renderCompLines(drawToolView(webSearchToolView.renderCall(args, COLLAPSED), theme), width)).toEqual(
					renderCompLines(webSearchToolRenderer.renderCall(args, HOST_COLLAPSED, theme), width),
				);
			});
		}

		it("cuts a query longer than the row's label budget the same way", () => {
			const args = { query: "q".repeat(400) };
			expect(renderCompLines(drawToolView(webSearchToolView.renderCall(args, COLLAPSED), theme), WIDTH)).toEqual(
				renderCompLines(webSearchToolRenderer.renderCall(args, HOST_COLLAPSED, theme), WIDTH),
			);
		});

		it("draws a call with no query at all", () => {
			expect(renderCompLines(drawToolView(webSearchToolView.renderCall({}, COLLAPSED), theme), WIDTH)).toEqual(
				renderCompLines(webSearchToolRenderer.renderCall({}, HOST_COLLAPSED, theme), WIDTH),
			);
		});
	});

	describe("a settled answer", () => {
		for (const [context, options] of DISCLOSURES) {
			for (const width of WIDTHS) {
				it(`states the same answer, sources and metadata at ${width} columns, expanded=${context.expanded}`, () => {
					const result = found();
					const args = { query: "what changed in bun 1.3" };
					expect(comparable(viewRows(result, context, args, width))).toEqual(
						comparable(oracleRows(result, options, args, width)),
					);
				});
			}
		}

		it("names the query the provider ran when the call carried none", () => {
			const result = found({ searchQueries: ["bun 1.3 release notes", "bun changelog"] });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("reports a provider that answered without a model, an auth mode or usage", () => {
			const result = found({ model: undefined, authMode: undefined, usage: undefined });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("says the answer was empty when the provider returned none", () => {
			const result: WebSearchViewResult = {
				content: [{ type: "text", text: "" }],
				details: { response: response({ answer: "" }) },
			};
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("falls back to the tool's own text when the response carried no answer", () => {
			const result: WebSearchViewResult = {
				content: [{ type: "text", text: "plain text answer" }],
				details: { response: response({ answer: undefined }) },
			};
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("reports a query that found nothing as a warning", () => {
			const result = found({ sources: [] });
			expect(comparable(viewRows(result, COLLAPSED))).toEqual(comparable(oracleRows(result, HOST_COLLAPSED)));
		});

		it("cuts a query far longer than the row it is stated on", () => {
			const result = found();
			const args = { query: `${"long ".repeat(60)}tail` };
			expect(comparable(viewRows(result, EXPANDED, args))).toEqual(
				comparable(oracleRows(result, HOST_EXPANDED, args)),
			);
		});

		it("shows the whole answer when an expanded card carries a compact caller's cap", () => {
			const result = found();
			const args = { query: "what changed", maxAnswerLines: 3 };
			expect(comparable(viewRows(result, EXPANDED, args))).toEqual(
				comparable(oracleRows(result, HOST_EXPANDED, args)),
			);
		});

		it("falls back to a source's url when its title is blank", () => {
			const result = found({ sources: [{ title: "   ", url: "https://example.com/a" }] });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("dates a source by the date it was published when it reports no age", () => {
			const result = found({ sources: [{ title: "Dated", url: "https://example.com/a", publishedDate: "2024-01-02" }] });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("names a source that reported no page at all", () => {
			const result = found({ sources: [{ title: "Local", url: "", ageSeconds: 7200 }] });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("names a provider that ran without one", () => {
			const result = found({ provider: "none", model: undefined });
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});
	});

	describe("the collapsed budgets", () => {
		it("lists the same sources collapsed, and says how many it held back", () => {
			const result = manySources();
			expect(comparable(viewRows(result, COLLAPSED))).toEqual(comparable(oracleRows(result, HOST_COLLAPSED)));
		});

		it("lists every source expanded", () => {
			const result = manySources();
			expect(comparable(viewRows(result, EXPANDED))).toEqual(comparable(oracleRows(result, HOST_EXPANDED)));
		});

		it("cuts a source row that runs out of columns rather than wrapping it", () => {
			const result = found({
				sources: [{ title: "T".repeat(120), url: "https://example.com/very/long/path", ageSeconds: 7200 }],
			});
			const drawn = unstyled(viewRows(result, EXPANDED, undefined, 40));
			const main = unstyled(oracleRows(result, HOST_EXPANDED, undefined, 40));
			// One row, ending in the tail: a title that overran became no second row in either arm.
			const overran = /^\S {2}T{3}/u;
			expect(drawn.filter(row => overran.test(row))).toHaveLength(1);
			expect(main.filter(row => overran.test(row))).toHaveLength(1);
			expect(drawn.find(row => overran.test(row))).toMatch(/T+… \(example\.com\) 2h ago$/);
			expect(main.find(row => overran.test(row))).toMatch(/T+… \(example\.com\) · 2h ago$/);
		});
	});

	describe("the error card", () => {
		for (const width of WIDTHS) {
			it(`states the failure at ${width} columns`, () => {
				const result: WebSearchViewResult = {
					content: [],
					details: { error: "Network timeout after 30s", response: response({ provider: "brave" }) },
				};
				expect(viewRows(result, COLLAPSED, undefined, width)).toEqual(
					oracleRows(result, HOST_COLLAPSED, undefined, width),
				);
			});
		}

		it("widens a tab inside the message the same way", () => {
			const result: WebSearchViewResult = {
				content: [],
				details: { error: "failed:\tconnection reset", response: response({ provider: "brave" }) },
			};
			expect(viewRows(result, COLLAPSED)).toEqual(oracleRows(result, HOST_COLLAPSED));
		});

		it("states a failure that named no provider", () => {
			const result: WebSearchViewResult = {
				content: [],
				details: { error: "no provider configured", response: response({ provider: "none", sources: [] }) },
			};
			expect(viewRows(result, COLLAPSED)).toEqual(oracleRows(result, HOST_COLLAPSED));
		});
	});

	describe("an unreadable response", () => {
		const text = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");

		for (const [context, options] of DISCLOSURES) {
			it(`shows the text it returned, expanded=${context.expanded}`, () => {
				const result: WebSearchViewResult = { content: [{ type: "text", text }] };
				expect(railAgnostic(viewRows(result, context))).toEqual(railAgnostic(oracleRows(result, options)));
			});
		}

		it("says so when the response carried nothing", () => {
			const result: WebSearchViewResult = { content: [{ type: "text", text: "   " }] };
			expect(railAgnostic(viewRows(result, EXPANDED))).toEqual(railAgnostic(oracleRows(result, HOST_EXPANDED)));
		});

		it("strips the indent a returned line carried", () => {
			const indented = ["   leading", "trailing   ", "\tboth\t"].join("\n");
			const result: WebSearchViewResult = { content: [{ type: "text", text: indented }] };
			expect(railAgnostic(viewRows(result, EXPANDED))).toEqual(railAgnostic(oracleRows(result, HOST_EXPANDED)));
		});

		it("reads the text block a response led a non-text block with", () => {
			const result: WebSearchViewResult = { content: [{ type: "image" }, { type: "text", text }] };
			expect(railAgnostic(viewRows(result, COLLAPSED))).toEqual(railAgnostic(oracleRows(result, HOST_COLLAPSED)));
		});
	});

	describe("the pinned differences", () => {
		it("leaves the plate alone on a settled card, where main opened one on every row", () => {
			const result = found();
			const drawn = viewRows(result, EXPANDED);
			const main = oracleRows(result, HOST_EXPANDED);
			expect(main.every(row => row.startsWith("\u001b[49m") && row.endsWith("\u001b[49m"))).toBe(true);
			expect(drawn.some(row => row.includes("\u001b[49m"))).toBe(false);
			// Padded to the block's own width there, and ending where the words end here.
			expect(main[0]?.length).toBeGreaterThan(drawn[0]?.length ?? 0);
			expect(unstyled(drawn)[0]).toEqual(unstyled(main)[0]);
		});

		it("keeps the settled rail where main coloured the rail of a card it framed as a warning", () => {
			const result: WebSearchViewResult = { content: [{ type: "text", text: "unparsed" }] };
			const rail = theme.symbol("block.rail");
			expect(oracleRows(result, HOST_COLLAPSED)[0]).toContain(`${colorOpen("warning")}${rail}`);
			expect(viewRows(result, COLLAPSED)[0]).not.toContain(`${colorOpen("warning")}${rail}`);
			// Both arms still state the outcome, in the header's own icon.
			expect(unstyled(viewRows(result, COLLAPSED))[0]).toEqual(unstyled(oracleRows(result, HOST_COLLAPSED))[0]);
		});

		it("cuts a title two columns later, because the tail it makes room for is two narrower", () => {
			const result = found({
				sources: [{ title: "T".repeat(120), url: "https://example.com/very/long/path", ageSeconds: 7200 }],
			});
			const kept = (rows: readonly string[]): number =>
				(unstyled(rows).find(row => row.includes("TT")) ?? "").replace(/[^T]/g, "").length;
			// Main spent three columns on the dot between the domain and the age; the card spends one.
			expect(kept(oracleRows(result, HOST_EXPANDED, undefined, 40))).toEqual(13);
			expect(kept(viewRows(result, EXPANDED, undefined, 40))).toEqual(15);
		});

		it("draws a metadata value as a bare run where main wrapped it in an empty colour pair", () => {
			const result = found();
			const value = "sonar @ Perplexity (API)";
			const main = oracleRows(result, HOST_EXPANDED).find(row => row.includes(value)) ?? "";
			const drawn = viewRows(result, EXPANDED).find(row => row.includes(value)) ?? "";
			expect(theme.fg("text", value)).toEqual(`${CLOSE}${value}${CLOSE}`);
			expect(main).toContain(`${theme.fg("muted", "Provider:")} ${CLOSE}${value}${CLOSE}`);
			expect(drawn).toContain(`${theme.fg("muted", "Provider:")} ${value}`);
		});

		it("sets a source's tail at the end of the row where main set it beside the title", () => {
			const result = found();
			const drawn = viewRows(result, EXPANDED).find(row => row.includes("Src One")) ?? "";
			const main = oracleRows(result, HOST_EXPANDED).find(row => row.includes("Src One")) ?? "";
			// Main: the title, one space, then the domain and the age joined by the theme's dot.
			expect(main).toContain(
				`${theme.fg("accent", "Src One")} ${theme.fg("dim", "(example.com)")}${theme.fg(
					"dim",
					theme.sep.dot,
				)}${theme.fg("muted", "1h ago")}`,
			);
			// The card: the title, the columns that are left, then the tail, spaced by the card itself.
			expect(drawn).toContain(theme.fg("accent", "Src One"));
			expect(drawn.replaceAll("\u001b[49m", "").trimEnd()).toEndWith(
				`${theme.fg("dim", "(example.com)")}${theme.fg("muted", " 1h ago")}`,
			);
			expect(unstyled([drawn])[0]).toMatch(/Src One {2,}\(example\.com\) 1h ago$/);
		});

		it("joins the usage facts with its own comma where main joined them with the theme's dot", () => {
			const result = found();
			const main = unstyled(oracleRows(result, HOST_EXPANDED)).find(row => row.includes("Usage:")) ?? "";
			const drawn = unstyled(viewRows(result, EXPANDED)).find(row => row.includes("Usage:")) ?? "";
			expect(main).toContain(`in 11${theme.sep.dot}out 22${theme.sep.dot}total 33${theme.sep.dot}search 2`);
			expect(drawn).toContain("in 11, out 22, total 33, search 2");
		});

		it("words a held-back count with the host's gesture where main wrote a muted count", () => {
			const result = manySources();
			const main = oracleRows(result, HOST_COLLAPSED).find(row => row.includes("4 more sources")) ?? "";
			const drawn = viewRows(result, COLLAPSED).find(row => row.includes("4 more sources")) ?? "";
			expect(main).toContain(`${colorOpen("muted")}… 4 more sources${CLOSE}`);
			expect(drawn).toContain(`${colorOpen("dim")}… 4 more sources${CLOSE}`);
			expect(stripVTControlCharacters(drawn)).toMatch(/… 4 more sources .+ expand/u);
			expect(stripVTControlCharacters(main)).not.toContain("expand");
		});

		it("offers the same gesture on what an unreadable response held back", () => {
			const text = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
			const result: WebSearchViewResult = { content: [{ type: "text", text }] };
			const main = oracleRows(result, HOST_COLLAPSED).find(row => row.includes("3 more lines")) ?? "";
			const drawn = viewRows(result, COLLAPSED).find(row => row.includes("3 more lines")) ?? "";
			expect(main).toContain(`${colorOpen("muted")}… 3 more lines${CLOSE}`);
			expect(stripVTControlCharacters(drawn)).toMatch(/… 3 more lines .+ expand/u);
			expect(stripVTControlCharacters(main)).not.toContain("expand");
		});

		it("caps a compact caller's answer in the answer's own lines where main capped the rows", () => {
			const result = found();
			const args = { query: "what changed", maxAnswerLines: 3 };
			const drawn = unstyled(viewRows(result, COLLAPSED, args));
			const main = unstyled(oracleRows(result, HOST_COLLAPSED, args));
			// Six lines of answer arrive: main wrapped them into seven rows, kept three and said four
			// were left; the card kept three of the six and said three.
			expect(main.some(row => row.includes("… 4 more lines"))).toBe(true);
			expect(drawn.some(row => row.includes("… 3 more lines"))).toBe(true);
			// Neither arm offers a gesture, because a one-shot caller printed the card and exited.
			expect(drawn.some(row => row.includes("expand"))).toBe(false);
			expect(main.some(row => row.includes("expand"))).toBe(false);
			// A capped answer is still the document the provider wrote, in both arms: the heading is a
			// heading and its marks are gone.
			expect(drawn.some(row => row.endsWith("Overview"))).toBe(true);
			expect(main.some(row => row.endsWith("Overview"))).toBe(true);
			expect(drawn.some(row => row.includes("##"))).toBe(false);
			// Both stop at the same place in the answer.
			expect(drawn.some(row => row.includes("Para two."))).toBe(false);
			expect(main.some(row => row.includes("Para two."))).toBe(false);
		});

		it("sets a source's age at the end of a row that names no page, where main set it beside the title", () => {
			const result = found({ sources: [{ title: "Local", url: "", ageSeconds: 7200 }] });
			const drawn = unstyled(viewRows(result, EXPANDED, undefined, 40)).find(row => row.includes("Local")) ?? "";
			const main = unstyled(oracleRows(result, HOST_EXPANDED, undefined, 40)).find(row => row.includes("Local")) ?? "";
			expect(main).toEndWith("Local 2h ago");
			expect(drawn).toMatch(/Local {2,}2h ago$/);
		});

		it("cuts a source row whose tail overruns the columns, where main wrapped it over three rows", () => {
			const result = found({
				sources: [{ title: "Src", url: "https://a-very-long-subdomain-name-example.com/x", ageSeconds: 3600 }],
			});
			const drawn = unstyled(viewRows(result, EXPANDED, undefined, 40));
			const main = unstyled(oracleRows(result, HOST_EXPANDED, undefined, 40));
			/** The rows of the sources section, which sits between the two labels around it. */
			const listed = (rows: readonly string[]): string[] =>
				rows.slice(
					rows.findIndex(row => row.endsWith("Sources")) + 1,
					rows.findIndex(row => row.endsWith("Metadata")),
				);
			// The tail alone is wider than the card, so main's row became three: the title, then the
			// domain, then the rest of it. The card cuts at the margin and stays one row.
			expect(listed(main)).toHaveLength(3);
			expect(listed(drawn)).toEqual([`${theme.symbol("block.rail")}  Src (a-very-long-subdomain-name-examp`]);
		});

		it("ends an over-long fallback line at the margin where main cut it with an ellipsis", () => {
			const result: WebSearchViewResult = { content: [{ type: "text", text: `${"x".repeat(200)} tail` }] };
			const drawn = unstyled(viewRows(result, EXPANDED, undefined, 40));
			const main = unstyled(oracleRows(result, HOST_EXPANDED, undefined, 40));
			expect(main[1]?.endsWith("…")).toBe(true);
			expect(drawn[1]?.endsWith("…")).toBe(false);
			expect(drawn[1]).toEqual(`${theme.symbol("block.rail")}  ${"x".repeat(37)}`);
			// One row for one line, where main's cut and the card's are both one row and a wrap is not.
			expect(drawn).toHaveLength(2);
			expect(main).toHaveLength(2);
		});
	});
});
