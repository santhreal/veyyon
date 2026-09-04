/**
 * The `goal` card draws what main's renderer drew.
 *
 * TWO DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. A multi-line error card: main's
 * `formatErrorDetail(msg).split("\n")` coloured the string before splitting it, so only the first row
 * carried the tone and the rest lost the indent; the view tones and indents every row. And the
 * report's section label, which main drew in a colour no other card's section label uses.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { goalToolView } from "@veyyon/coding-agent/goals/goal-tool";
import type { Goal, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import { truncateToWidth } from "@veyyon/utils/width";
import * as goalOracle from "../oracles/goal-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	framedView,
	HOST_COLLAPSED,
	lineView,
	renderCompLines,
	renderCompText,
	useDifferentialTheme,
} from "./harness";

useDifferentialTheme();

describe("goal tool differential", () => {
	it("renders pending call without objective with exact byte parity", () => {
		const ops: Array<"get" | "complete" | "resume" | "drop"> = ["get", "complete", "resume", "drop"];
		for (const op of ops) {
			const oracleComp = goalOracle.renderCall({ op }, HOST_COLLAPSED, theme);
			const card = goalToolView.renderCall({ op }, COLLAPSED);
			const viewText = renderCompText(drawToolView(lineView(card), theme));
			expect(viewText).toBe(renderCompText(oracleComp));
		}
	});

	it("exception cell: goal call with objective differs only by SGR attribute nesting order", () => {
		const objective = "Ship plugin host architecture";
		const oracleComp = goalOracle.renderCall({ op: "create", objective }, HOST_COLLAPSED, theme);
		const card = goalToolView.renderCall({ op: "create", objective }, COLLAPSED);
		const drawn = renderCompText(drawToolView(lineView(card), theme));
		const oracleText = renderCompText(oracleComp);

		// Visible text without escape characters matches exactly
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracleText));

		// SGR difference: main was italic(fg("muted", obj)), view is fg("muted", italic(obj))
		const expectedWithViewNesting = oracleText.replace(
			theme.italic(theme.fg("muted", `"${truncateToWidth(objective, TRUNCATE_LENGTHS.TITLE)}"`)),
			theme.fg("muted", theme.italic(`"${truncateToWidth(objective, TRUNCATE_LENGTHS.TITLE)}"`)),
		);
		expect(drawn).toBe(expectedWithViewNesting);
	});

	it("renders result with no active goal with exact byte parity", () => {
		const res = {
			content: [{ type: "text" as const, text: "No active goal." }],
			details: { op: "get", goal: null } as GoalToolDetails,
		};
		const oracleComp = goalOracle.renderResult(res, HOST_COLLAPSED, theme, { op: "get" });
		const card = goalToolView.renderResult(res, COLLAPSED, { op: "get" });
		const viewText = renderCompText(drawToolView(lineView(card), theme));
		expect(viewText).toBe(renderCompText(oracleComp));
	});

	it("renders result with single-line error with exact framed block byte parity", () => {
		const res = {
			content: [{ type: "text" as const, text: "Goal tool failed due to invalid arguments" }],
			isError: true,
		};
		const oracleComp = goalOracle.renderResult(res, HOST_COLLAPSED, theme, { op: "get" });
		const card = goalToolView.renderResult(res, COLLAPSED, { op: "get" });

		const viewLines = renderCompLines(drawToolView(framedView(card), theme));
		const oracleLines = renderCompLines(oracleComp);
		expect(viewLines).toEqual(oracleLines);
	});

	it("exception cell: a continuation line of a multi-line error is toned and aligned like the first", () => {
		const res = {
			content: [{ type: "text" as const, text: "Line 1 failure\nLine 2 secondary reason" }],
			isError: true,
		};
		const oracleComp = goalOracle.renderResult(res, HOST_COLLAPSED, theme, { op: "get" });
		const card = goalToolView.renderResult(res, COLLAPSED, { op: "get" });

		const viewLines = renderCompLines(drawToolView(framedView(card), theme));
		const oracleLines = renderCompLines(oracleComp);
		const words = (lines: readonly string[]): string[] =>
			lines.map(line => stripVTControlCharacters(line).replace("▏", "").trim());

		// The words on every row, and their order, are what main drew.
		expect(words(viewLines)).toEqual(words(oracleLines));

		// The two accepted differences, pinned rather than described. Main split a pre-coloured string,
		// so only its first line carried the error tone and only its first line carried the indent the
		// rail's content column expects; the continuation ran two columns left of it, unstyled.
		const continuation = (lines: readonly string[]): string => {
			const row = lines.find(line => line.includes("Line 2 secondary reason"));
			if (row === undefined) throw new Error("no continuation row was drawn");
			return row;
		};
		const indentOf = (row: string): number => {
			const bare = stripVTControlCharacters(row).replace("▏", "");
			return bare.length - bare.trimStart().length;
		};
		const first = (lines: readonly string[]): string => {
			const row = lines.find(line => line.includes("Line 1 failure"));
			if (row === undefined) throw new Error("no first error row was drawn");
			return row;
		};

		// What the row does with colour after the rail glyph: the frame's own colours sit before it, the
		// text's tone after it. Main's continuation opened no colour there, so its words drew in whatever
		// the frame had left set; every line of the view's card opens the error tone for its own text.
		//
		// Either encoding counts. A terminal that reports truecolor gets `38;2;r;g;b` and one that
		// reports 256 colours gets `38;5;n` for the same tone, so pinning one form asserts the
		// runner's colour depth rather than what the row does with colour.
		const tonedAfterRail = (row: string): boolean => /\u258f[^\u258f]*\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/.test(row);

		expect(indentOf(continuation(oracleLines))).toBe(indentOf(first(oracleLines)) - 2);
		expect(indentOf(continuation(viewLines))).toBe(indentOf(first(viewLines)));
		expect(tonedAfterRail(first(oracleLines))).toBe(true);
		expect(tonedAfterRail(continuation(oracleLines))).toBe(false);
		expect(tonedAfterRail(first(viewLines))).toBe(true);
		expect(tonedAfterRail(continuation(viewLines))).toBe(true);
	});

	it("renders settled active goal result with exact frame and badge parity", () => {
		const activeGoal: Goal = {
			objective: "Decouple TUI engine from coding-agent",
			status: "active",
			tokensUsed: 8_500,
			timeUsedSeconds: 120,
		} as Goal;
		const res = {
			content: [{ type: "text" as const, text: "Goal: ok" }],
			details: { op: "get", goal: activeGoal } as GoalToolDetails,
		};

		const oracleComp = goalOracle.renderResult(res, HOST_COLLAPSED, theme, { op: "get" });
		const card = goalToolView.renderResult(res, COLLAPSED, { op: "get" });

		const viewLines = renderCompLines(drawToolView(framedView(card), theme));
		const oracleLines = renderCompLines(oracleComp);

		// Header line and tokens/time line match exact bytes
		expect(viewLines[0]).toBe(oracleLines[0]); // Framed header
		expect(viewLines[2]).toBe(oracleLines[2]); // tokensUsed + time elapsed line
		expect(stripVTControlCharacters(viewLines[1])).toBe(stripVTControlCharacters(oracleLines[1])); // objective
	});

	it("exception cell: the report section is named in the colour every other card names a section in", () => {
		const completeGoal: Goal = {
			objective: "Decouple TUI engine from coding-agent",
			status: "complete",
			tokensUsed: 15_000,
			tokenBudget: 30_000,
			timeUsedSeconds: 300,
		} as Goal;
		const res = {
			content: [{ type: "text" as const, text: "Goal complete" }],
			details: {
				op: "complete",
				goal: completeGoal,
				completionBudgetReport: "Budget Summary:\nSpent 15,000 of 30,000 tokens",
			} as GoalToolDetails,
		};

		const oracleComp = goalOracle.renderResult(res, HOST_COLLAPSED, theme, { op: "complete" });
		const card = goalToolView.renderResult(res, COLLAPSED, { op: "complete" });

		const viewLines = renderCompLines(drawToolView(framedView(card), theme));
		const oracleLines = renderCompLines(oracleComp);

		// A section label is chrome, so the host draws it: `renderOutputBlock` takes a label's colour
		// from its caller, and `drawFramedBlock` is that caller for every view-returning tool. `main`'s
		// goal renderer handed the label over uncoloured while every other framed card in the product
		// (`read_url`, `read`, `ssh`, `gh`) hands over a tool-title one, so the converted card joins
		// its siblings and the label is the one row that differs. The bytes of both arms are pinned.
		const reportHeaderIdx = viewLines.findIndex(l => l.includes("Report"));
		expect(reportHeaderIdx).toBeGreaterThan(0);
		expect(stripVTControlCharacters(oracleLines[reportHeaderIdx] ?? "")).toBe(
			stripVTControlCharacters(viewLines[reportHeaderIdx] ?? ""),
		);
		expect(oracleLines[reportHeaderIdx]).not.toContain(theme.fg("toolTitle", "Report"));
		expect(viewLines[reportHeaderIdx]).toContain(theme.fg("toolTitle", "Report"));
		// The report itself, which is the tool's own text, is byte-identical.
		expect(viewLines[reportHeaderIdx + 1]).toBe(oracleLines[reportHeaderIdx + 1]);
	});

	it("tests both collapsed and expanded disclosure states", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const card = goalToolView.renderCall({ op: "get" }, disclosure);
			const oracleComp = goalOracle.renderCall({ op: "get" }, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});
