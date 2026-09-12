/**
 * Live view-only multi-file rendering and renderer failure resilience.
 *
 * WHY THIS SUITE EXISTS:
 *
 * 1. View-only multi-file rendering:
 *    When a tool describes a pure `view` (without legacy terminal renderer methods) and produces
 *    multi-file results (`details.perFileResults`), the component must render individual multi-file
 *    cards from projected display state (`display.multiFileViews`) rather than falling into the legacy
 *    execution branch or re-invoking aggregate `tool.view.renderResult`.
 *
 * 2. Renderer failure resilience:
 *    When a tool view or custom renderer throws during call or result rendering, the component must
 *    catch the error, render a failure diagnostic via `reportRendererFailure`, and provide an honest
 *    fallback (the tool title for calls, raw output or per-file notice for results).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { AnyAgentTool } from "@veyyon/agent-core";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import type { ToolView, ToolViewContext } from "@veyyon/view";
import { createToolExecution } from "./helpers/tool-execution";

const mockUi: TUI = {
	requestRender() {},
	requestComponentRender() {},
} as unknown as TUI;

describe("view-only multi-file rendering and renderer failure resilience", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders individual multi-file cards for view-only tools without re-invoking aggregate renderResult", () => {
		let aggregateCallCount = 0;
		let perFileCallCount = 0;

		const toolWithView: AnyAgentTool = {
			name: "edit",
			label: "Edit",
			description: "Multi-file edit tool",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: {} }),
			view: {
				renderCall(_args: unknown): ToolView {
					return {
						kind: "statusRow",
						title: "Edit",
						description: "Editing files",
					};
				},
				renderResult(
					result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
					_context: ToolViewContext,
					_args?: unknown,
				): ToolView {
					const details = result.details as { path?: string; perFileResults?: unknown[] } | undefined;
					if (details?.perFileResults) {
						aggregateCallCount++;
						return {
							kind: "statusRow",
							title: "Edit (Aggregate)",
							description: "Should not be drawn when multi-file views exist",
						};
					}
					perFileCallCount++;
					return {
						kind: "statusRow",
						title: `Edit ${details?.path ?? "unknown"}`,
						description: "applied cleanly",
					};
				},
			},
		};

		const block = createToolExecution(
			"edit",
			{ edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
			{},
			toolWithView,
			mockUi,
			process.cwd(),
		);

		block.updateResult(
			{
				content: [],
				details: {
					perFileResults: [
						{ path: "src/a.ts", isError: false },
						{ path: "src/b.ts", isError: false },
					],
				},
			},
			false,
		);

		const lines = block.render(100).map(stripAnsi).join("\n");
		expect(lines).toContain("Edit src/a.ts");
		expect(lines).toContain("Edit src/b.ts");
		expect(lines).not.toContain("Edit (Aggregate)");
		expect(aggregateCallCount).toBe(0);
		expect(perFileCallCount).toBeGreaterThanOrEqual(2);
	});

	it("captures call view exceptions and renders tool title fallback with failure notice", () => {
		const throwingCallTool: AnyAgentTool = {
			name: "failing_call_tool",
			label: "Failing Call Tool",
			description: "Throws in renderCall",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: {} }),
			view: {
				renderCall(): ToolView {
					throw new Error("Synthetic failure in renderCall");
				},
				renderResult(): ToolView {
					return {
						kind: "statusRow",
						title: "Done",
					};
				},
			},
		};

		const block = createToolExecution(
			"failing_call_tool",
			{ param: 123 },
			{},
			throwingCallTool,
			mockUi,
			process.cwd(),
		);

		const lines = block.render(100).map(stripAnsi).join("\n");
		expect(lines).toContain('tool "failing_call_tool" call renderer threw: Synthetic failure in renderCall');
		expect(lines).toContain("Failing Call Tool");
	});

	it("captures result view exceptions and renders raw output fallback with failure notice", () => {
		const throwingResultTool: AnyAgentTool = {
			name: "failing_result_tool",
			label: "Failing Result Tool",
			description: "Throws in renderResult",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: {} }),
			view: {
				renderCall(): ToolView {
					return {
						kind: "statusRow",
						title: "Running failing result tool",
					};
				},
				renderResult(): ToolView {
					throw new Error("Synthetic failure in renderResult");
				},
			},
		};

		const block = createToolExecution(
			"failing_result_tool",
			{ param: 456 },
			{},
			throwingResultTool,
			mockUi,
			process.cwd(),
		);

		block.updateResult(
			{
				content: [{ type: "text", text: "Important raw output line 1\nImportant raw output line 2" }],
			},
			false,
		);

		const lines = block.render(100).map(stripAnsi).join("\n");
		expect(lines).toContain('tool "failing_result_tool" result renderer threw: Synthetic failure in renderResult');
		expect(lines).toContain("Important raw output line 1");
		expect(lines).toContain("Important raw output line 2");
	});

	it("captures custom legacy renderer exceptions and renders honest fallback", () => {
		const legacyThrowingTool: AnyAgentTool = {
			name: "legacy_failing_tool",
			label: "Legacy Failing Tool",
			description: "Throws in legacy renderResult",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: {} }),
			renderResult() {
				throw new Error("Synthetic legacy renderResult crash");
			},
		};

		const block = createToolExecution(
			"legacy_failing_tool",
			{ param: 789 },
			{},
			legacyThrowingTool,
			mockUi,
			process.cwd(),
		);

		block.updateResult(
			{
				content: [{ type: "text", text: "Fallback legacy raw text" }],
			},
			false,
		);

		const lines = block.render(100).map(stripAnsi).join("\n");
		expect(lines).toContain('tool "legacy_failing_tool" result renderer threw: Synthetic legacy renderResult crash');
		expect(lines).toContain("Fallback legacy raw text");
	});
});
