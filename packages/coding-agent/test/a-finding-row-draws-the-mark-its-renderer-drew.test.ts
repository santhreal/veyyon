/**
 * The review tool states a finding row, and the terminal draws the row its renderer drew.
 *
 * WHY THIS SUITE EXISTS. `tools/review.ts` was the last module under `src/tools/` that constructed a
 * terminal value in place, and the thing that kept it there was one glyph: a finding carries a
 * per-priority mark, `ViewStatus` names an outcome rather than a priority, and a host asked for the
 * icon of a status would not draw the P0..P3 symbol. The contract grew `ViewSpan.symbol` for it -- a
 * registry key inside a line, resolved by the host -- so the tool now names a key and never a glyph.
 *
 * THE DEFECT CLASS THIS CLOSES. Four ways a marked row silently changes when it becomes a view:
 *
 *  - THE MARK LOSES ITS PRIORITY. `styledSymbol(symbol, colour)` took both from one table. A span
 *    carries the key and the tone separately, so a mapping that drops the tone paints every priority
 *    the same accent and the row still reads correctly at a glance. Every priority is compared.
 *  - THE MARK LOSES ITS TONE'S IDENTITY. `error`, `warning`, `muted` and `accent` name a tone AND a
 *    theme colour here, which is a coincidence of naming, not a contract. The four are asserted
 *    against the priority table the renderer used, so a tone map that agreed by accident is caught.
 *  - THE MARK SWALLOWS THE LINE. A symbol span replaces its own text; a host that resolved the key and
 *    then also drew the fallback would print the glyph twice, and one that resolved nothing would drop
 *    the mark. Both are asserted, including a key this build has never heard of.
 *  - THE ROW STOPS BEING A ROW. The call row leads with the tool name in bold `toolTitle` and the
 *    result row leads with the review mark, both before the priority mark. Order and separators are
 *    the tool's, so the whole line is compared byte for byte against the expression the renderer held.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It says nothing about `execute`, nothing about the reviewer agent's
 * `ReviewFinding` coercion (`getPriorityInfo(...).ord`, covered by the corpus runner), and nothing
 * about the findings block in `task/render.ts`, which draws its own summary rows and never went
 * through this tool's renderers.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, theme as uiTheme } from "@veyyon/coding-agent/theme/theme";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	reportFindingTool,
} from "@veyyon/coding-agent/tools/review";
import { drawSpan, drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import type { ToolView } from "@veyyon/view";
import * as reviewOracle from "./oracles/review-main-renderer";

/** Colour is forced on: under a piped policy every byte comparison below would compare bare text. */
let entryPolicy: AnsiPolicy;

beforeAll(async () => {
	await initTheme();
	entryPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(entryPolicy);
});

const COLLAPSED = { expanded: false } as const;

const view = reportFindingTool.view;
if (view?.renderCall === undefined || view.renderResult === undefined) {
	throw new Error("the review tool declares no view; this suite has nothing to compare");
}
const renderCall = view.renderCall;
const renderResult = view.renderResult;

/** Wide enough that neither side wraps: these rows are one line and the comparison is about bytes. */
const WIDTH = 200;

/** A component's drawn bytes, which is what the card puts on screen. */
function drawn(comp: Component): string {
	return comp
		.render(WIDTH)
		.map(row => row.trimEnd())
		.join("\n")
		.trimEnd();
}

/** A one-line view as bytes. A framed block here would be a kind change nobody asked for. */
function line(candidate: ToolView): string {
	if (candidate.kind === "framedBlock") throw new Error(`expected a line view, drew a framed block`);
	return drawn(drawToolView(candidate, uiTheme));
}

function args(overrides?: Partial<Record<string, unknown>>): {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
} {
	return {
		title: "Guard the empty range",
		body: "An empty range slices the whole file.",
		priority: "P1",
		confidence: 0.8,
		file_path: "src/app.ts",
		line_start: 42,
		line_end: 42,
		...overrides,
	} as {
		title: string;
		body: string;
		priority: FindingPriority;
		confidence: number;
		file_path: string;
		line_start: number;
		line_end: number;
	};
}

function result(overrides?: Partial<Record<string, unknown>>) {
	const detail = { ...args(), ...overrides };
	return {
		content: [{ type: "text" as const, text: `Finding recorded: ${detail.priority} ${detail.title}` }],
		details: detail,
	};
}

/** The mark the renderer drew for a priority: one table, one colour, one call. */
function markFor(priority: FindingPriority): string {
	const info = getPriorityInfo(priority);
	return uiTheme.styledSymbol(info.symbol, info.color);
}

describe("a finding row draws the mark its renderer drew", () => {
	/**
	 * Anti-vacuity. Every comparison below is an equality between two strings this file builds, so a
	 * theme that emitted nothing would pass all of them. Colour has to be on, and the mark has to be a
	 * glyph rather than an empty string.
	 */
	it("draws styled bytes at all", () => {
		expect(getAnsiPolicy()).toBe("full");
		const mark = markFor("P0");
		expect(mark).not.toBe("");
		expect(stripVTControlCharacters(mark).trim()).not.toBe("");
		expect(mark).not.toBe(stripVTControlCharacters(mark));
		expect(PRIORITY_LABELS).toEqual(["P0", "P1", "P2", "P3"]);
	});

	/**
	 * The call row, byte for byte against the renderer main shipped.
	 *
	 * The oracle is a frozen copy of `origin/main`'s `review.ts` renderers, so neither side reads the
	 * other's priority table: a mark, tone or separator that changed shows up here.
	 */
	it("draws the call row main's renderer drew", () => {
		const call = args();
		expect(line(renderCall(call, COLLAPSED))).toBe(drawn(reviewOracle.renderCall(call, uiTheme)));
	});

	/**
	 * Every priority, so a tone map that painted them all one colour cannot pass. Asserted against the
	 * priority table the renderer used rather than against a copy of it written here.
	 */
	it.each(["P0", "P1", "P2", "P3"] as const)("draws the %s row main's renderer drew", priority => {
		const call = args({ priority });
		const row = line(renderCall(call, COLLAPSED));
		const info = getPriorityInfo(priority);

		expect(row).toBe(drawn(reviewOracle.renderCall(call, uiTheme)));
		expect(row).toContain(uiTheme.styledSymbol(info.symbol, info.color));
		expect(row).toContain(uiTheme.fg(info.color, `[${priority}]`));
		expect(stripVTControlCharacters(row)).toContain(`[${priority}]`);
	});

	/** The four priorities do not collapse into one appearance, which an accidental single tone would. */
	it("gives the four priorities four different rows", () => {
		const drawn = new Set(PRIORITY_LABELS.map(priority => line(renderCall(args({ priority }), COLLAPSED))));
		expect(drawn.size).toBe(4);
	});

	/** A title an agent already prefixed keeps one priority label, not two. */
	it("drops a priority prefix the agent wrote into the title", () => {
		const mark = stripVTControlCharacters(markFor("P1"));
		const drawn = stripVTControlCharacters(
			line(renderCall(args({ title: "[P1] Guard the empty range" }), COLLAPSED)),
		);

		expect(drawn).toBe(`report_finding ${mark} [P1] Guard the empty range`);
		expect(drawn.match(/\[P1\]/g)).toHaveLength(1);
	});

	/** The result row, byte for byte, including the review mark that leads it and the location that ends it. */
	it("draws the result row main's renderer drew", () => {
		const res = result();
		expect(line(renderResult(res, COLLAPSED))).toBe(drawn(reviewOracle.renderResult(res, uiTheme)));
	});

	/** A result with no details takes main's fallback branch, which drew the tool's own text unstyled. */
	it("draws main's no-details fallback row", () => {
		const res = { content: [{ type: "text" as const, text: "Finding recorded" }] };
		expect(line(renderResult(res, COLLAPSED))).toBe(drawn(reviewOracle.renderResult(res, uiTheme)));
	});

	/** A multi-line finding reports the range the way the renderer did, not the start line twice. */
	it("names a range only when the finding spans one", () => {
		const spanning = stripVTControlCharacters(
			line(renderResult(result({ line_start: 42, line_end: 48 }), COLLAPSED)),
		);
		expect(spanning).toContain("src/app.ts:42-48");
		const single = stripVTControlCharacters(line(renderResult(result(), COLLAPSED)));
		expect(single).toContain("src/app.ts:42");
		expect(single).not.toContain("-42");
	});

	/** A result with no details falls back to its own text, unstyled, exactly as the renderer did. */
	it("falls back to the tool's text when the result carries no details", () => {
		const drawn = line(renderResult({ content: [{ type: "text" as const, text: "Finding recorded" }] }, COLLAPSED));
		expect(drawn).toBe("Finding recorded");
	});

	/** An empty result draws an empty row rather than a stray glyph or a styled blank. */
	it("draws nothing when the result carries neither details nor text", () => {
		expect(line(renderResult({ content: [] }, COLLAPSED))).toBe("");
	});

	/**
	 * The span mechanism itself, at the drawer. A symbol span replaces its text, in its own tone; a key
	 * this build does not have falls back to the text so the line survives an extension's vocabulary.
	 */
	it("draws a symbol span as the glyph alone, and an unknown key as its fallback text", () => {
		expect(drawSpan({ symbol: "status.error", text: "", tone: "error" }, uiTheme)).toBe(
			uiTheme.styledSymbol("status.error", "error"),
		);
		expect(drawSpan({ symbol: "status.error", text: "ignored", tone: "error" }, uiTheme)).toBe(
			uiTheme.styledSymbol("status.error", "error"),
		);
		expect(
			drawSpan({ symbol: "status.a-host-has-never-heard-of-this", text: "[P1]", tone: "warning" }, uiTheme),
		).toBe(uiTheme.fg("warning", "[P1]"));
		expect(drawSpan({ symbol: "status.error", text: "" }, uiTheme)).toBe(
			uiTheme.styledSymbol("status.error", "accent"),
		);
	});

	/** The tool reaches the terminal through the view and nothing else: no renderer members remain. */
	it("declares a view and no host renderer", () => {
		expect(reportFindingTool.view).toBeDefined();
		expect("renderCall" in reportFindingTool).toBe(false);
		expect("renderResult" in reportFindingTool).toBe(false);
	});
});
