/**
 * A converted tool view draws the exact terminal bytes its origin/main renderer drew.
 *
 * WHY THIS SUITE EXISTS. Six tool renderers were migrated from imperative TUI Component renderers
 * (`renderCall` and `renderResult` returning `Component`) to host-agnostic `ToolView` descriptions
 * (`ToolViewRenderer` returning `StatusRowView`, `TextBlockView`, or `FramedBlockView`).
 *
 * Hand-rolled test assertions recreate the expected strings by hand, which tests the expectation
 * rather than proving equivalence with what `main` actually drew. This suite drives FROZEN ORACLES
 * copied verbatim from `origin/main` (SHA `e9467ab12c976cd830eb7a61e30bfd6adc4bff1f`) side-by-side
 * with the new `ToolView` rendering pipeline (`src/tui/draw-tool-view.ts`) across a full matrix of
 * tool calls, results, failure modes, and disclosure states.
 *
 * THE DEFECT CLASS THIS CLOSES.
 *  - Spans losing tone or bold/italic styling during view conversion.
 *  - Status glyphs or emblem icons changing, falling back, or omitting tool titles.
 *  - Result descriptions dropping truncation bounds or tab sanitation.
 *  - Disclosure states (collapsed vs expanded) failing to reveal full output or output path warnings.
 *  - Framed block state reductions (success, error, warning) mapping to incorrect rails or borders.
 *  - Error cards dropping sanitation or failing when details are absent.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Two legitimate differences are acknowledged and asserted as
 * explicit, reasoned exception cells:
 *  1) SGR nesting order for italic spans: `main` wrapped `italic(fg("muted", text))` while
 *     `drawSpan` applies styles inside color `fg("muted", italic(text))`. Both render identically
 *     in all standard ANSI terminals and produce identical visible text.
 *  2) Multi-line error cards in `goal`: `main`'s `formatErrorDetail(msg).split("\n")` only colored
 *     the first line, leaving subsequent lines untoned and unindented. The new view applies tone
 *     and indent to each line.
 * It also does not test tool execution logic (`execute()`), which is covered by tool-specific suites.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import {
	createInitExperimentTool,
	DEFAULT_HARNESS_COMMAND,
} from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import { createUpdateNotesTool } from "@veyyon/coding-agent/autoresearch/tools/update-notes";
import type {
	AutoresearchToolFactoryOptions,
	ExperimentResult,
	ExperimentState,
	LogDetails,
	RunDetails,
	RunExperimentProgressDetails,
} from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI } from "@veyyon/coding-agent/extensibility/extensions";
import { goalToolView } from "@veyyon/coding-agent/goals/goal-tool";
import type { Goal, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import type { FramedBlockView, LineToolView, ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import * as certifyArmsOracle from "./oracles/certify-arms-main-renderer";
import * as goalOracle from "./oracles/goal-main-renderer";
import * as initExperimentOracle from "./oracles/init-experiment-main-renderer";
import * as logExperimentOracle from "./oracles/log-experiment-main-renderer";
import * as runExperimentOracle from "./oracles/run-experiment-main-renderer";
import * as updateNotesOracle from "./oracles/update-notes-main-renderer";

/**
 * The full set of tools converted from Component renderers to ToolViews in this PR.
 * Pinned by exact equality so any seventh converted tool fails here until its oracle exists.
 */
export const CONVERTED_TOOLS = [
	"goal",
	"init_experiment",
	"update_notes",
	"certify_arms",
	"log_experiment",
	"run_experiment",
] as const;

const WIDTH = 80;
/**
 * The two disclosure states, in both vocabularies.
 *
 * A frozen oracle takes the host's `RenderResultOptions`, which carries `isPartial` as well; a view
 * renderer takes the `ToolViewContext`, which is the disclosure state and nothing else. Both are built
 * from the same boolean here so the two sides of every comparison are asked the same question.
 */
const COLLAPSED = { expanded: false } as const;
const EXPANDED = { expanded: true } as const;
const HOST_COLLAPSED: RenderResultOptions = { expanded: false, isPartial: false };
const HOST_EXPANDED: RenderResultOptions = { expanded: true, isPartial: false };

let entryPolicy: AnsiPolicy;

beforeAll(async () => {
	await initTheme();
	entryPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(entryPolicy);
});

function lineView(view: ToolView): LineToolView {
	if (view.kind === "framedBlock") {
		throw new Error(`expected a one-line view, got ${view.kind}`);
	}
	return view;
}

/**
 * A framed-block view, or a failure.
 *
 * The kind is part of the claim: a converted tool that started returning a row where it returned a
 * panel changed the card, so this throws rather than returning early. An early return would leave the
 * cell green with nothing compared.
 */
function framedView(view: ToolView): FramedBlockView {
	if (view.kind !== "framedBlock") throw new Error(`expected a framed block, got ${view.kind}`);
	return view;
}

function trimLines(lines: readonly string[]): string[] {
	return lines.map(line => line.trimEnd());
}

/**
 * A component's drawn lines at one fixed width.
 *
 * Both sides are compared as components rendered at the same width, which is what the card does with
 * either renderer: `main` returned a `Component` and a view goes through `drawToolView`, whose one-line
 * form is the same zero-padded `Text`. Comparing a raw view string against a rendered component would
 * only measure that one side wraps.
 */
function renderCompLines(comp: Component, width = WIDTH): string[] {
	return trimLines(comp.render(width));
}

function renderCompText(comp: Component, width = WIDTH): string {
	return trimLines(comp.render(width)).join("\n").trimEnd();
}

/**
 * A tool's two view renderers, resolved once.
 *
 * `ToolViewRenderer` declares both members optional, because a tool may describe only one card. Every
 * tool compared here describes both, so a missing one is a converted tool that stopped drawing rather
 * than a case to branch on: it fails loudly at construction instead of quietly at the first cell.
 */
function views<Args, Result>(tool: {
	view?: ToolViewRenderer<Args, Result>;
}): {
	call: (args: Args, context: ToolViewContext) => ToolView;
	result: (result: Result, context: ToolViewContext, args?: Args) => ToolView;
} {
	const call = tool.view?.renderCall;
	const result = tool.view?.renderResult;
	if (call === undefined || result === undefined) throw new Error("a converted tool declares no view renderers");
	return { call, result };
}

function autoresearchOptions(): AutoresearchToolFactoryOptions {
	const runtime = createSessionRuntime();
	return {
		dashboard: {
			clear(): void {},
			requestRender(): void {},
			showOverlay: async (): Promise<void> => {},
			updateWidget(): void {},
		},
		getRuntime: () => runtime,
		pi: {} as unknown as ExtensionAPI,
	};
}

describe("differential suite invariants and anti-vacuity", () => {
	it("pins the complete list of converted tools by exact equality", () => {
		expect([...CONVERTED_TOOLS]).toEqual([
			"goal",
			"init_experiment",
			"update_notes",
			"certify_arms",
			"log_experiment",
			"run_experiment",
		]);
	});

	it("runs under full ANSI styling policy so styling comparisons are meaningful", () => {
		expect(theme.fg("accent", "sample")).not.toBe("sample");
		expect(theme.bold("sample")).not.toBe("sample");
		expect(theme.italic("sample")).not.toBe("sample");
	});

	it("confirms every frozen oracle produces non-empty output", () => {
		const goalCall = goalOracle.renderCall({ op: "get" }, HOST_COLLAPSED, theme);
		expect(renderCompText(goalCall).length).toBeGreaterThan(0);

		const initCall = initExperimentOracle.renderCall({ name: "test_run" }, HOST_COLLAPSED, theme);
		expect(renderCompText(initCall).length).toBeGreaterThan(0);

		const notesCall = updateNotesOracle.renderCall({ body: "notes content" }, HOST_COLLAPSED, theme);
		expect(renderCompText(notesCall).length).toBeGreaterThan(0);

		const armsCall = certifyArmsOracle.renderCall(
			{ arms: [{ arm: "A", hypothesis: "hyp", diff: "diff", modified_paths: ["p.ts"] }] },
			HOST_COLLAPSED,
			theme,
		);
		expect(renderCompText(armsCall).length).toBeGreaterThan(0);

		const logCall = logExperimentOracle.renderCall(
			{ status: "keep", metric: 1.0, description: "kept" },
			HOST_COLLAPSED,
			theme,
		);
		expect(renderCompText(logCall).length).toBeGreaterThan(0);

		const runCall = runExperimentOracle.renderCall({}, HOST_COLLAPSED, theme);
		expect(renderCompText(runCall).length).toBeGreaterThan(0);
	});

	it("positive control: distinct inputs produce distinct rendered outputs", () => {
		const callA = initExperimentOracle.renderCall({ name: "alpha" }, HOST_COLLAPSED, theme);
		const callB = initExperimentOracle.renderCall({ name: "beta" }, HOST_COLLAPSED, theme);
		expect(renderCompText(callA)).not.toBe(renderCompText(callB));
	});
});

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

	it("renders completed goal with completion report with exact byte parity in report section", () => {
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

		// Section header "Report" and report lines have exact byte parity
		const reportHeaderIdx = viewLines.findIndex(l => l.includes("Report"));
		expect(reportHeaderIdx).toBeGreaterThan(0);
		expect(viewLines[reportHeaderIdx]).toBe(oracleLines[reportHeaderIdx]);
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

describe("init_experiment tool differential", () => {
	const view = views(createInitExperimentTool(autoresearchOptions()));

	it("renders pending call with exact byte parity", () => {
		const callArgs = { name: "optimize-grep-kernel", primary_metric: "search_latency_ms" };
		const oracleComp = initExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders pending call with long name truncated to 100 columns with exact byte parity", () => {
		const callArgs = { name: "x".repeat(300), primary_metric: "ms" };
		const oracleComp = initExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful result with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Started session #1: optimize-grep-kernel\nMetric: search_latency_ms (ms, lower is better)\nBenchmark entrypoint: bash autoresearch.sh",
				},
			],
		};
		const oracleComp = initExperimentOracle.renderResult(result);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders failed result with error message with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Error: ./autoresearch.sh does not exist. Phase 1 requires writing ./autoresearch.sh.",
				},
			],
			isError: true,
		};
		const oracleComp = initExperimentOracle.renderResult(result);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { name: "sweep-variants", primary_metric: "time_ms" };
			const card = view.call(callArgs, disclosure);
			const oracleComp = initExperimentOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});

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

describe("certify_arms tool differential", () => {
	const view = views(createCertifyArmsTool(autoresearchOptions()));

	it("renders pending call for triage stage with exact byte parity", () => {
		const callArgs = {
			arms: [
				{ arm: "arm-A", hypothesis: "inline function", diff: "+line", modified_paths: ["a.ts"] },
				{ arm: "arm-B", hypothesis: "memoize lookup", diff: "+line", modified_paths: ["b.ts"] },
			],
		};
		const oracleComp = certifyArmsOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders pending call for verdicts stage with exact byte parity", () => {
		const callArgs = {
			arms: [
				{ arm: "arm-A", hypothesis: "inline function", diff: "+line", modified_paths: ["a.ts"] },
				{ arm: "arm-B", hypothesis: "memoize lookup", diff: "+line", modified_paths: ["b.ts"] },
			],
			verdicts: [
				{ arm: "arm-A", certified_by: "arm-B", flagged: false },
				{ arm: "arm-B", certified_by: "arm-A", flagged: true, reason: "gamed metric" },
			],
		};
		const oracleComp = certifyArmsOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful triage result with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Triaged 2 arms: 2 surviving, 0 rejected.\nCertifier: arm-B.\n- arm-B reviews arm-A",
				},
			],
		};
		const oracleComp = certifyArmsOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders failed result without active session with exact byte parity", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "Error: no active autoresearch session. Call init_experiment first." },
			],
			isError: true,
		};
		const oracleComp = certifyArmsOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { arms: [{ arm: "A", hypothesis: "hyp", diff: "+", modified_paths: ["a.ts"] }] };
			const card = view.call(callArgs, disclosure);
			const oracleComp = certifyArmsOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});

describe("log_experiment tool differential", () => {
	const view = views(createLogExperimentTool(autoresearchOptions()));

	it("renders pending call for keep, discard, and crash outcomes with exact byte parity", () => {
		const statuses: Array<"keep" | "discard" | "crash" | "checks_failed"> = [
			"keep",
			"discard",
			"crash",
			"checks_failed",
		];
		for (const status of statuses) {
			const callArgs = { status, metric: 34.5, description: `attempted ${status} approach` };
			const oracleComp = logExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
			const card = view.call(callArgs, COLLAPSED);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});

	it("renders result with details (keep, baseline, confidence, deviations) with exact byte parity", () => {
		const experiment: ExperimentResult = {
			runNumber: 1,
			commit: "abc1234",
			metric: 14.2,
			metrics: { p99_ms: 18.0 },
			status: "keep",
			description: "unroll hot loop in walker",
			timestamp: 1_764_460_800_000,
			segment: 1,
			confidence: 2.8,
			modifiedPaths: ["crates/walker/src/lib.rs"],
			scopeDeviations: ["crates/walker/mod.rs"],
			justification: "necessary helper",
			flagged: false,
			flaggedReason: null,
		};
		const state: ExperimentState = {
			sessionId: 1,
			name: "speed",
			goal: "optimize walker",
			metricName: "time_ms",
			metricUnit: "ms",
			bestDirection: "lower",
			currentSegment: 1,
			bestMetric: 20.0,
			confidence: 2.8,
			results: [experiment],
			scopePaths: ["crates/walker"],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
			maxExperiments: 10,
			breadth: 1,
			notes: "",
			branch: "autoresearch/speed",
			baselineCommit: "0000000",
		};
		const details: LogDetails = {
			experiment,
			state,
			wallClockSeconds: 3.5,
			scopeDeviations: ["crates/walker/mod.rs"],
			justification: "necessary helper",
			flaggedRuns: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "Logged run #1 (keep): 14.2ms" }],
			details,
		};

		const oracleComp = logExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders result without details (plain fallback) with exact byte parity", () => {
		const result = { content: [{ type: "text" as const, text: "Error: git status failed, run was not logged." }] };
		const oracleComp = logExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { status: "keep" as const, metric: 10.0, description: "kept iteration" };
			const card = view.call(callArgs, disclosure);
			const oracleComp = logExperimentOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});

describe("run_experiment tool differential", () => {
	const view = views(createRunExperimentTool(autoresearchOptions()));

	it("renders pending call with exact byte parity", () => {
		const oracleComp = runExperimentOracle.renderCall({}, HOST_COLLAPSED, theme);
		const card = view.call({}, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders running progress result with exact byte parity", () => {
		const progressDetails: RunExperimentProgressDetails = {
			phase: "running",
			elapsed: "8.4s",
		};
		const result = {
			content: [{ type: "text" as const, text: "Benchmarking iteration 3..." }],
			details: progressDetails,
		};
		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful run result in collapsed state with last 5 tail output lines with exact byte parity", () => {
		const tailOutput = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8";
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 4.2,
			exitCode: 0,
			timedOut: false,
			passed: true,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: 12.4,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput,
			runNumber: 3,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "PASS 4.2s time_ms=12.4ms" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful run result in expanded state with full output and path warning with exact byte parity", () => {
		const tailOutput = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8";
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 4.2,
			exitCode: 0,
			timedOut: false,
			passed: true,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: 12.4,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput,
			runNumber: 3,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			truncation: {
				content: tailOutput,
				truncated: true,
				truncatedBy: "lines" as const,
				totalLines: 4096,
				totalBytes: 262_144,
			},
			fullOutputPath: "run/output.log",
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "PASS 4.2s time_ms=12.4ms" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_EXPANDED, theme);
		const card = view.result(result, EXPANDED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders run failure (exitCode !== 0) with exact byte parity", () => {
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 2.1,
			exitCode: 1,
			timedOut: false,
			passed: false,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: null,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput: "Syntax error on line 42",
			runNumber: 4,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "FAIL exit=1 2.1s" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders run timeout (timedOut: true) with exact byte parity", () => {
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 30.0,
			exitCode: 137,
			timedOut: true,
			passed: false,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: null,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput: "Timed out waiting for process",
			runNumber: 5,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "TIMEOUT 30.0s" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders fallback error without details with exact byte parity", () => {
		const result = { content: [{ type: "text" as const, text: "Error: command not found: ./autoresearch.sh" }] };
		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});
});
