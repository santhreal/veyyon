/**
 * The `retain`, `recall` and `reflect` cards draw what main's renderers drew.
 *
 * All three memory tools share one card shape and one oracle, so they are swept together here.
 *
 * ONE DIFFERENCE IS ASSERTED AS AN EXCEPTION CELL. A row narrower than its clamp: the host cuts the
 * line span by span, so the ellipsis falls inside the span's colour run instead of after it.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import {
	type MemoryViewResult,
	recallToolView,
	reflectToolView,
	retainToolView,
} from "@veyyon/coding-agent/tools/agent/memory-view";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { ToolView, ToolViewContext } from "@veyyon/view";
import * as memoryOracle from "../oracles/memory-main-renderer";
import { COLLAPSED, EXPANDED, HOST_COLLAPSED, renderCompLines, useDifferentialTheme } from "./harness";

useDifferentialTheme();

describe("memory tool differential", () => {
	const stored = ["remember the release cadence", "the bench seed is 7", "kernel owns the session spine"];
	const many = Array.from({ length: 12 }, (_, index) => `memory number ${index + 1}`);

	function textResult(text: string, isError = false): MemoryViewResult {
		return { content: [{ type: "text", text }], isError };
	}

	function drawn(view: ToolView): string[] {
		return renderCompLines(drawToolView(view, theme));
	}

	it("draws a retain call in both disclosure states, previewing and holding back the same items", () => {
		for (const items of [stored, many]) {
			const args = { items: items.map(content => ({ content })) };
			for (const disclosure of [COLLAPSED, EXPANDED]) {
				const host: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
				const oracleComp = memoryOracle.retainToolRenderer.renderCall(args, host, theme);
				expect(drawn(retainToolView.renderCall(args, disclosure))).toEqual(renderCompLines(oracleComp));
			}
		}
		// Anti-vacuity: twelve memories collapse to the preview cap and expand past it, so a view that
		// ignored the disclosure state would draw the same rows for both and fail here.
		const args = { items: many.map(content => ({ content })) };
		expect(drawn(retainToolView.renderCall(args, COLLAPSED))).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(drawn(retainToolView.renderCall(args, EXPANDED))).toHaveLength(many.length + 1);
	});

	it("cuts an over-wide memory, a tab-bearing one and a blank one the way the renderer did", () => {
		const args = {
			items: [
				{ content: `an overlong memory ${"x".repeat(200)} tail` },
				{ content: "a\tmemory\twith\ttabs" },
				{ content: "   " },
				{ content: "" },
			],
		};
		for (const width of [40, 80, 120]) {
			const oracleComp = memoryOracle.retainToolRenderer.renderCall(args, HOST_COLLAPSED, theme);
			const card = drawToolView(retainToolView.renderCall(args, COLLAPSED), theme);
			expect(renderCompLines(card, width)).toEqual(renderCompLines(oracleComp, width));
		}
		// A blank memory is dropped rather than drawn as an empty bullet, and a tab never reaches the
		// screen, so the card is the row plus the two memories that carry text.
		const rows = renderCompLines(drawToolView(retainToolView.renderCall(args, COLLAPSED), theme), 120);
		expect(rows).toHaveLength(3);
		expect(rows.join("\n")).not.toContain("\t");
		// The cut memory says it was cut, at the width the surface offered and not at a fixed budget.
		expect(stripVTControlCharacters(rows[1] ?? "")).toHaveLength(120);
		expect(stripVTControlCharacters(rows[1] ?? "").endsWith("…")).toBe(true);
	});

	it("exception cell: a terminal too narrow for the clamp cuts the line, not the colour", () => {
		// `main` cut the memory to a floor of eight columns whatever the terminal was, drew a row wider
		// than the surface, and let the outer truncation take the overflow off: the row ends between a
		// colour and its reset, so the cut carries no ellipsis and the last cells draw in whatever
		// colour the terminal was left in. The host cuts the span's text to the columns it has, so the
		// row ends inside its own colour and says it was cut. The bytes of both sides are pinned rather
		// than matched.
		const args = { items: [{ content: `an overlong memory ${"x".repeat(200)} tail` }] };
		const oracleComp = memoryOracle.retainToolRenderer.renderCall(args, HOST_COLLAPSED, theme);
		const card = drawToolView(retainToolView.renderCall(args, COLLAPSED), theme);
		const oracleRow = renderCompLines(oracleComp, 8)[1] ?? "";
		const viewRow = renderCompLines(card, 8)[1] ?? "";
		expect(stripVTControlCharacters(oracleRow)).toBe("  • an o");
		expect(stripVTControlCharacters(viewRow)).toBe("  • an …");
		expect(oracleRow.endsWith("\u001b[0m")).toBe(true);
		expect(viewRow.endsWith("\u001b[39m")).toBe(true);
		// Every width the clamp does not bind at is byte-identical, which is what makes the difference
		// the clamp's and not the conversion's.
		for (const width of [16, 24, 40]) {
			expect(renderCompLines(card, width)).toEqual(renderCompLines(oracleComp, width));
		}
	});

	it("draws a settled retain, its held-back count and its failure exactly as the renderer did", () => {
		const args = { items: many.map(content => ({ content })) };
		const cases: Array<[MemoryViewResult, ToolViewContext]> = [
			[textResult("3 memories stored."), COLLAPSED],
			[textResult("12 memories queued."), COLLAPSED],
			[textResult("12 memories queued."), EXPANDED],
			[textResult(""), COLLAPSED],
			[textResult("the store rejected the write", true), COLLAPSED],
		];
		for (const [result, disclosure] of cases) {
			const host: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const oracleComp = memoryOracle.retainToolRenderer.renderResult(result, host, theme, args);
			expect(drawn(retainToolView.renderResult(result, disclosure, args))).toEqual(renderCompLines(oracleComp));
		}
		// The held-back note counts memories, not lines, which is the wording the card has always used.
		const collapsed = drawn(retainToolView.renderResult(textResult("12 memories queued."), COLLAPSED, args));
		expect(stripVTControlCharacters(collapsed.at(-1) ?? "")).toContain("… 4 more");
		expect(stripVTControlCharacters(collapsed.at(-1) ?? "")).not.toContain("more lines");
	});

	it("draws a recall row, its held-back body and its miss with exact byte parity", () => {
		const args = { query: "what did we decide about the release cadence" };
		const found = textResult(
			`Found 2 relevant memories (as of 12:00 UTC):\n\nfirst recalled memory\nsecond recalled memory`,
		);
		const cases: Array<[MemoryViewResult, ToolViewContext]> = [
			[found, COLLAPSED],
			[found, EXPANDED],
			[textResult("No relevant memories found."), COLLAPSED],
			[textResult("the bank is unreachable", true), COLLAPSED],
		];
		for (const [result, disclosure] of cases) {
			const host: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const oracleComp = memoryOracle.recallToolRenderer.renderResult(result, host, theme, args);
			expect(drawn(recallToolView.renderResult(result, disclosure, args))).toEqual(renderCompLines(oracleComp));
		}
		const callOracle = memoryOracle.recallToolRenderer.renderCall(args, HOST_COLLAPSED, theme);
		expect(drawn(recallToolView.renderCall(args, COLLAPSED))).toEqual(renderCompLines(callOracle));
		// A hit collapses to the row plus the gesture and expands to the memories themselves, so the
		// two disclosure states cannot both be the row alone.
		expect(drawn(recallToolView.renderResult(found, COLLAPSED, args))).toHaveLength(2);
		expect(drawn(recallToolView.renderResult(found, EXPANDED, args))).toHaveLength(3);
	});

	it("cuts an over-wide query and a tab-bearing one the way the row did, on both reading tools", () => {
		// A query is a sentence the model wrote and reaches the row untrimmed. `main` cut it at eighty
		// columns whatever the terminal was, so the cut belongs to the card and not to the surface.
		const wide = { query: `${"remember what we decided about the release cadence ".repeat(4)}and the seed` };
		const tabbed = { query: "what\tdid\twe\tdecide" };
		for (const args of [wide, tabbed]) {
			for (const [renderer, oracle] of [
				[recallToolView, memoryOracle.recallToolRenderer],
				[reflectToolView, memoryOracle.reflectToolRenderer],
			] as const) {
				expect(drawn(renderer.renderCall(args, COLLAPSED))).toEqual(
					renderCompLines(oracle.renderCall(args, HOST_COLLAPSED, theme)),
				);
			}
		}
		// The cut is the card's, so it lands at eighty columns on a surface with two hundred: the row
		// ends in the ellipsis with room to spare, and the tabbed query reaches the screen with no tab.
		const card = drawToolView(recallToolView.renderCall(wide, COLLAPSED), theme);
		const row = stripVTControlCharacters(renderCompLines(card, 200)[0] ?? "").trimEnd();
		expect(row.endsWith("…")).toBe(true);
		expect(row.length).toBeLessThan(100);
		const tabbedRow = drawToolView(reflectToolView.renderCall(tabbed, COLLAPSED), theme);
		expect(stripVTControlCharacters(renderCompLines(tabbedRow, 200)[0] ?? "")).not.toContain("\t");
	});

	it("draws a reflect answer at both preview caps and its failure with exact byte parity", () => {
		const args = { query: "what is the release cadence" };
		const answer = textResult(Array.from({ length: 9 }, (_, index) => `answer line ${index + 1}`).join("\n"));
		const cases: Array<[MemoryViewResult, ToolViewContext]> = [
			[answer, COLLAPSED],
			[answer, EXPANDED],
			[textResult("one line answer"), COLLAPSED],
			[textResult("the reflection failed", true), COLLAPSED],
		];
		for (const [result, disclosure] of cases) {
			const host: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const oracleComp = memoryOracle.reflectToolRenderer.renderResult(result, host, theme, args);
			expect(drawn(reflectToolView.renderResult(result, disclosure, args))).toEqual(renderCompLines(oracleComp));
		}
		const callOracle = memoryOracle.reflectToolRenderer.renderCall(args, HOST_COLLAPSED, theme);
		expect(drawn(reflectToolView.renderCall(args, COLLAPSED))).toEqual(renderCompLines(callOracle));
		// The collapsed cap holds three of the nine lines back as lines, which is the unit a reflection
		// answers in, and expanding reaches all nine.
		const collapsed = drawn(reflectToolView.renderResult(answer, COLLAPSED, args));
		expect(stripVTControlCharacters(collapsed.at(-1) ?? "")).toContain("… 6 more lines");
		expect(drawn(reflectToolView.renderResult(answer, EXPANDED, args))).toHaveLength(10);
		// A blank line between two paragraphs is dropped rather than drawn as an empty row, so the
		// preview cap counts answer lines and the card holds no gap.
		const spaced = textResult("first paragraph\n\n   \nsecond paragraph");
		expect(drawn(reflectToolView.renderResult(spaced, EXPANDED, args))).toEqual(
			renderCompLines(
				memoryOracle.reflectToolRenderer.renderResult(spaced, { expanded: true, isPartial: false }, theme, args),
			),
		);
		expect(drawn(reflectToolView.renderResult(spaced, EXPANDED, args))).toHaveLength(3);
	});
});
