/**
 * The `resolve` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { ResolveToolDetails } from "@veyyon/coding-agent/tools/agent/resolve";
import { type ResolveViewResult, resolveToolView } from "@veyyon/coding-agent/tools/agent/resolve-view";
import * as resolveOracle from "../oracles/resolve-main-renderer";
import { COLLAPSED, HOST_COLLAPSED, renderCompLines, renderCompText, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

describe("resolve tool differential", () => {
	const details: ResolveToolDetails = {
		action: "apply",
		reason: "the patch matches the plan",
		label: "edit: apply the hunk to src/app.ts",
	};

	function resultLinesOf(result: ResolveViewResult, width = WIDTH): string[] {
		return renderCompLines(resolveOracle.renderResult(result, HOST_COLLAPSED, theme), width);
	}

	function viewResultLinesOf(result: ResolveViewResult, width = WIDTH): string[] {
		return renderCompLines(drawToolView(resolveToolView.renderResult(result, COLLAPSED), theme), width);
	}

	it("draws the pending call row for both actions with exact byte parity", () => {
		const reasons = [
			undefined,
			"",
			"   ",
			"the diff is what the plan asked for",
			`a reason far past the seventy-two columns the row keeps ${"and then some more of it ".repeat(4)}`,
		];
		for (const action of ["apply", "discard"] as const) {
			for (const reason of reasons) {
				const args = { action, reason: reason as string };
				expect(renderCompText(drawToolView(resolveToolView.renderCall(args, COLLAPSED), theme))).toBe(
					renderCompText(resolveOracle.renderCall(args, HOST_COLLAPSED, theme)),
				);
			}
		}
		// Anti-vacuity: the row carries the action and the badge that names the transition, so the
		// two arms above are not two blanks agreeing.
		const row = stripVTControlCharacters(
			renderCompText(
				drawToolView(resolveToolView.renderCall({ action: "discard", reason: "no" }, COLLAPSED), theme),
			),
		);
		expect(row).toContain("discard");
		expect(row).toContain("proposed -> rejected");
	});

	it("fills the same plate the renderer filled, for every outcome and at every width", () => {
		const results: ResolveViewResult[] = [
			{ content: [], details },
			{ content: [], details, isError: true },
			{ content: [], details: { ...details, action: "discard", reason: "the hunk touches a file I do not own" } },
			// A label with no source, so the card has nothing to set off at the end of its headline.
			{ content: [], details: { ...details, label: "apply the staged rename" } },
			// A label whose separator opens it states no source either, since the half before it is empty.
			{ content: [], details: { ...details, label: ": apply the staged rename" } },
			{ content: [], details: { ...details, reason: "" } },
			{ content: [], details: { ...details, reason: "   \t  " } },
			{ content: [], details: { ...details, label: "edit:\tapply\tthe\thunk" } },
			// No details at all: the tool failed before it decided anything.
			{ content: [{ type: "text", text: "no pending action" }], isError: true },
			{ content: [] },
		];
		for (const result of results) {
			for (const width of [WIDTH, 40, 12, 3, 1]) {
				expect(viewResultLinesOf(result, width)).toEqual(resultLinesOf(result, width));
			}
		}
		// Anti-vacuity: the plate is five rows of filled columns, not an empty component, and a tab
		// never reaches it.
		const plate = viewResultLinesOf(results[0]!);
		expect(plate).toHaveLength(5);
		expect(stripVTControlCharacters(plate[3] ?? "")).toContain("the patch matches the plan");
		const tag = `${theme.format.bracketLeft}edit${theme.format.bracketRight}`;
		expect(stripVTControlCharacters(plate[1] ?? "")).toContain(`Accept: apply the hunk to src/app.ts ${tag}`);
		// Each outcome states itself: the three verbs are the three decisions, and a failed apply is
		// neither of the other two.
		expect(stripVTControlCharacters(viewResultLinesOf(results[1]!)[1] ?? "")).toContain("Failed:");
		expect(stripVTControlCharacters(viewResultLinesOf(results[2]!)[1] ?? "")).toContain("Discard:");
		// A reason the tool never gave is stated as absent rather than drawn as an empty row.
		expect(stripVTControlCharacters(viewResultLinesOf(results[5]!)[3] ?? "")).toContain("No reason provided");
	});

	it("paints each outcome in its own colour, so the plate is not one colour for everything", () => {
		const accepted = resultLinesOf({ content: [], details })[1] ?? "";
		const failed = resultLinesOf({ content: [], details, isError: true })[1] ?? "";
		const discarded = resultLinesOf({ content: [], details: { ...details, action: "discard" } })[1] ?? "";
		const opener = (color: "success" | "error" | "warning"): string => theme.fg(color, "x").split("x")[0] ?? "";
		expect(new Set([accepted, failed, discarded]).size).toBe(3);
		expect(accepted).toContain(opener("success"));
		expect(failed).toContain(opener("error"));
		expect(discarded).toContain(opener("warning"));
	});
});
