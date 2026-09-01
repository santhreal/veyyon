/**
 * The `update_notes` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createUpdateNotesTool } from "@veyyon/coding-agent/autoresearch/tools/update-notes";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import * as updateNotesOracle from "../oracles/update-notes-main-renderer";
import {
	autoresearchOptions,
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	lineView,
	renderCompText,
	useDifferentialTheme,
	views,
} from "./harness";

useDifferentialTheme();

describe("update_notes tool differential", () => {
	const view = views(createUpdateNotesTool(autoresearchOptions()));

	it("renders pending call with body with exact byte parity", () => {
		const callArgs = { body: "## Goals\nOptimize tree-sitter AST queries." };
		const oracleComp = updateNotesOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders pending call with append_idea with exact byte parity", () => {
		const callArgs = { body: "", append_idea: "Cache compiled query patterns across invocations" };
		const oracleComp = updateNotesOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful result with exact byte parity", () => {
		const result = { content: [{ type: "text" as const, text: "Appended idea (124 chars total)." }] };
		const oracleComp = updateNotesOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders failed result without active session with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
				},
			],
			isError: true,
		};
		const oracleComp = updateNotesOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { body: "Updated notes body." };
			const card = view.call(callArgs, disclosure);
			const oracleComp = updateNotesOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});
