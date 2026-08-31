/**
 * A converted tool view draws the exact terminal bytes its origin/main renderer drew.
 *
 * WHY THIS SUITE EXISTS. Every tool in `CONVERTED_TOOLS` was migrated from an imperative TUI
 * Component renderer (`renderCall` and `renderResult` returning `Component`) to a host-agnostic
 * `ToolView` description (`ToolViewRenderer` returning `StatusRowView`, `TextBlockView`,
 * `HeadedBlockView`, `FramedBlockView` or `NoticeView`).
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
 * WHAT THIS SUITE DOES NOT CATCH. Nine legitimate differences are acknowledged and asserted as
 * explicit, reasoned exception cells, each pinning the exact bytes of both arms:
 *  1) SGR nesting order for italic spans: `main` wrapped `italic(fg("muted", text))` while
 *     `drawSpan` applies styles inside color `fg("muted", italic(text))`. Both render identically
 *     in all standard ANSI terminals and produce identical visible text.
 *  2) Multi-line error cards in `goal`: `main`'s `formatErrorDetail(msg).split("\n")` only colored
 *     the first line, leaving subsequent lines untoned and unindented. The new view applies tone
 *     and indent to each line.
 *  3) The `goal` report's section label, which `main` drew in a colour no other card's section
 *     label uses.
 *  4) The `set_cwd` call row: `main` built it with `new Text(text)`, whose default constructor
 *     arguments pad a row by one column horizontally and one row vertically, so the row drew with a
 *     blank row above and below it and a one-column indent. Every other tool renderer passes
 *     `0, 0`, and a view is drawn the same way, so the converted row loses that padding and draws
 *     in the column its siblings draw in. The cell pins the difference to the padding alone.
 *  5) A memory row at a width narrower than its clamp, where the host cuts the line span by span
 *     so the ellipsis inherits the span's colour instead of ending outside it.
 *  6) The `read_url` held-back note and 7) its truncation mark, which the host now words and tones
 *     rather than the tool.
 *  8) The `debug` result header, which colours the tool name and sets the action off after it
 *     where `main` concatenated both untoned, and 9) its held-back note, which draws in the dim
 *     its own expand hint already used instead of a lighter muted.
 * It also does not test tool execution logic (`execute()`), which is covered by tool-specific suites.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, RenderResultOptions } from "@veyyon/agent-core";
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
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { DapSessionSummary } from "@veyyon/coding-agent/debug/dap";
import type { ExtensionAPI } from "@veyyon/coding-agent/extensibility/extensions";
import { goalToolView } from "@veyyon/coding-agent/goals/goal-tool";
import type { Goal, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import {
	type MemoryViewResult,
	recallToolView,
	reflectToolView,
	retainToolView,
} from "@veyyon/coding-agent/tools/agent/memory-view";
import type { ResolveToolDetails } from "@veyyon/coding-agent/tools/agent/resolve";
import { type ResolveViewResult, resolveToolView } from "@veyyon/coding-agent/tools/agent/resolve-view";
import { formatExpandHint, PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import { SET_CWD_TOOL_NAME } from "@veyyon/coding-agent/tools/fs/reroot-hint";
import { type SetCwdToolDetails, setCwdToolView } from "@veyyon/coding-agent/tools/fs/set-cwd";
import type { DebugParams, DebugToolDetails } from "@veyyon/coding-agent/tools/shell/debug";
import { type DebugViewResult, debugToolView } from "@veyyon/coding-agent/tools/shell/debug-view";
import type { ReadUrlToolDetails } from "@veyyon/coding-agent/tools/web/fetch";
import { type ReadUrlViewResult, readUrlToolView } from "@veyyon/coding-agent/tools/web/fetch-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import type { FramedBlockView, LineToolView, ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import * as certifyArmsOracle from "./oracles/certify-arms-main-renderer";
import * as debugOracle from "./oracles/debug-main-renderer";
import * as fetchOracle from "./oracles/fetch-main-renderer";
import * as goalOracle from "./oracles/goal-main-renderer";
import * as initExperimentOracle from "./oracles/init-experiment-main-renderer";
import * as logExperimentOracle from "./oracles/log-experiment-main-renderer";
import * as memoryOracle from "./oracles/memory-main-renderer";
import * as resolveOracle from "./oracles/resolve-main-renderer";
import * as runExperimentOracle from "./oracles/run-experiment-main-renderer";
import * as setCwdOracle from "./oracles/set-cwd-main-renderer";
import * as updateNotesOracle from "./oracles/update-notes-main-renderer";

/**
 * The full set of tools converted from Component renderers to ToolViews in this PR.
 * Pinned by exact equality so a newly converted tool fails here until its oracle exists.
 */
export const CONVERTED_TOOLS = [
	"goal",
	"init_experiment",
	"update_notes",
	"certify_arms",
	"log_experiment",
	"run_experiment",
	"set_cwd",
	"retain",
	"recall",
	"reflect",
	"read_url",
	"resolve",
	"debug",
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
	// One cell asks what the cards draw with hyperlinks on, which is a setting rather than a theme.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	setAnsiPolicy(entryPolicy);
	resetSettingsForTest();
});

function lineView(view: ToolView): LineToolView {
	if (view.kind === "framedBlock" || view.kind === "headedBlock" || view.kind === "notice") {
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
			"set_cwd",
			"retain",
			"recall",
			"reflect",
			"read_url",
			"resolve",
			"debug",
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

		const cwdCall = setCwdOracle.renderCall({ path: "/repo" }, HOST_COLLAPSED, theme);
		expect(renderCompText(cwdCall).length).toBeGreaterThan(0);

		const urlCall = fetchOracle.renderReadUrlCall({ path: "https://example.com" }, HOST_COLLAPSED, theme);
		expect(renderCompText(urlCall).length).toBeGreaterThan(0);
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

describe("set_cwd tool differential", () => {
	const cwd = "/repo/packages/coding-agent";
	const previous = "/repo";

	function resultOf(details: SetCwdToolDetails | undefined): AgentToolResult<SetCwdToolDetails> {
		return { content: [{ type: "text", text: "cwd changed" }], details };
	}

	/**
	 * The oracle's rows around the migrated row, which is the one accepted difference here.
	 *
	 * `main`'s call row was `new Text(text)`, and `Text` defaults to one column of horizontal padding
	 * and one row of vertical padding, so the row drew with a blank row above it, a blank row below it
	 * and a one-column indent. Every other tool renderer in the tree passes `0, 0`, and `drawToolView`
	 * draws a one-line view the same way, so the converted row sits in the column its siblings sit in.
	 * Asserting this shape rather than string equality pins the difference to the padding alone: the
	 * content bytes, escapes included, still have to match.
	 */
	function paddedLike(rows: readonly string[]): string[] {
		return ["", ...rows.map(row => ` ${row}`), ""];
	}

	it("exception cell: the call row carries the same bytes without the default Text padding", () => {
		for (const path of [cwd, "relative/dir", "~/projects/veyyon"]) {
			const oracleComp = setCwdOracle.renderCall({ path }, HOST_COLLAPSED, theme);
			const card = setCwdToolView.renderCall({ path }, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(lineView(card), theme));
			expect(viewLines).toHaveLength(1);
			expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
		}
	});

	it("collapses the home directory and truncates a long path exactly as the renderer did", () => {
		// A path under the real home directory is the only input that tells `shortenPath` apart from
		// the identity, and the oracle calls it too, so the tilde is asserted on its own as well as
		// against the frozen bytes.
		const home = join(homedir(), "projects", "veyyon");
		const oracleHome = setCwdOracle.renderCall({ path: home }, HOST_COLLAPSED, theme);
		const homeLines = renderCompLines(
			drawToolView(lineView(setCwdToolView.renderCall({ path: home }, COLLAPSED)), theme),
		);
		expect(renderCompLines(oracleHome)).toEqual(paddedLike(homeLines));
		expect(stripVTControlCharacters(homeLines.join(""))).toBe(`${SET_CWD_TOOL_NAME} ~/projects/veyyon`);

		const long = `/repo/${"segment/".repeat(30)}leaf`;
		const oracleComp = setCwdOracle.renderCall({ path: long }, HOST_COLLAPSED, theme);
		const viewLines = renderCompLines(
			drawToolView(lineView(setCwdToolView.renderCall({ path: long }, COLLAPSED)), theme),
		);

		expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
		// Anti-vacuity: the bound is the one the renderer applied, so a view that dropped the
		// truncation would draw a longer row than this and fail the parity cell above.
		expect(stripVTControlCharacters(viewLines.join("")).length).toBeLessThanOrEqual(
			`${SET_CWD_TOOL_NAME} `.length + TRUNCATE_LENGTHS.TITLE,
		);
	});

	it("renders the placeholder call row when no path arrived", () => {
		for (const args of [{}, { path: 42 } as unknown as { path: string }]) {
			const oracleComp = setCwdOracle.renderCall(args, HOST_COLLAPSED, theme);
			const card = setCwdToolView.renderCall(args as { path: string }, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(lineView(card), theme));
			expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
			expect(stripVTControlCharacters(viewLines.join(""))).toBe(`${SET_CWD_TOOL_NAME} …`);
		}
	});

	it("renders a move, a no-op and a detail-less result with exact framed block parity", () => {
		const cases: Array<SetCwdToolDetails | undefined> = [
			{ previous, cwd, requested: cwd },
			{ previous: cwd, cwd, requested: "." },
			undefined,
		];
		const drawn: string[][] = [];
		for (const details of cases) {
			const res = resultOf(details);
			const oracleComp = setCwdOracle.renderResult(res, HOST_COLLAPSED, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(framedView(card), theme));
			expect(viewLines).toEqual(renderCompLines(oracleComp));
			drawn.push(viewLines);
		}
		// A no-op reads differently from a move, which is the defect the header text was changed for;
		// three identical frames would satisfy every parity cell above.
		expect(new Set(drawn.map(lines => lines.join("\n"))).size).toBe(3);
	});

	it("renders every rule-delta shape with exact framed block parity", () => {
		const deltas: Array<Pick<SetCwdToolDetails, "rulesApplied" | "rulesDropped">> = [
			{ rulesApplied: ["AGENTS.md"] },
			{ rulesDropped: ["CLAUDE.md"] },
			{ rulesApplied: ["AGENTS.md", "docs/AGENTS.md"] },
			{ rulesApplied: ["AGENTS.md"], rulesDropped: ["CLAUDE.md"] },
			{ rulesApplied: [], rulesDropped: [] },
		];
		const headers = new Set<string>();
		for (const delta of deltas) {
			const res = resultOf({ previous, cwd, requested: cwd, ...delta });
			const oracleComp = setCwdOracle.renderResult(res, HOST_COLLAPSED, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(framedView(card), theme));
			expect(viewLines).toEqual(renderCompLines(oracleComp));
			headers.add(stripVTControlCharacters(viewLines[0] ?? ""));
		}
		// Each side of the delta on its own, both sides together, plural against singular, and a delta
		// that reported nothing: five shapes draw five headers, so no two of them collapsed into one.
		expect(headers.size).toBe(5);
		expect(
			[...headers].filter(header => header.includes("rule file") && !header.includes("rule files")),
		).toHaveLength(2);
	});

	it("draws the same card in both disclosure states", () => {
		const res = resultOf({ previous, cwd, requested: cwd, rulesApplied: ["AGENTS.md"] });
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const oracleComp = setCwdOracle.renderResult(res, hostDisclosure, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, disclosure);
			expect(renderCompLines(drawToolView(framedView(card), theme))).toEqual(renderCompLines(oracleComp));
		}
	});
});

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

describe("read_url tool differential", () => {
	const details: ReadUrlToolDetails = {
		kind: "url",
		url: "https://example.com/docs",
		finalUrl: "https://example.com/docs",
		contentType: "text/html",
		method: "GET",
		truncated: false,
		notes: [],
	};
	const body = Array.from({ length: 9 }, (_, index) => `page line ${index + 1}`).join("\n");
	const page = { content: [{ type: "text", text: `fetched from example.com\n---\n\n${body}` }], details };
	const truncatedPage = {
		content: [{ type: "text", text: `---\n\n${body}` }],
		details: {
			...details,
			finalUrl: "https://example.com/docs/v2",
			truncated: true,
			notes: ["reader mode", "cached"],
			meta: {
				truncation: {
					direction: "head",
					truncatedBy: "lines",
					totalLines: 40,
					totalBytes: 4096,
					outputLines: 9,
					outputBytes: 107,
					artifactId: "abc123",
				},
			},
		} satisfies ReadUrlToolDetails,
	};

	function oracleLinesOf(result: ReadUrlViewResult, expanded: boolean, width = WIDTH): string[] {
		return renderCompLines(
			fetchOracle.renderReadUrlResult(result, expanded ? HOST_EXPANDED : HOST_COLLAPSED, theme),
			width,
		);
	}

	function viewLinesOf(result: ReadUrlViewResult, expanded: boolean, width = WIDTH): string[] {
		return renderCompLines(drawToolView(readUrlToolView.renderResult(result, { expanded }), theme), width);
	}

	/** The row a card writes for what it held back, which is the one row the two arms word differently. */
	function heldBackIndex(lines: readonly string[]): number {
		return lines.findIndex(line => stripVTControlCharacters(line).includes("more lines"));
	}

	it("draws a pending call for every shape of URL exactly as the renderer did", () => {
		const targets = [
			"https://example.com/docs",
			"www.example.com/guide",
			"https://example.com/a/very/long/path/that/keeps/going/past/the/fifty/column/budget/and/then/some",
			"https://example.com/page:10-20",
			"https://example.com/page:raw",
			"artifact://abc123",
			"",
		];
		for (const target of targets) {
			for (const raw of [false, true]) {
				const args = { path: target, raw };
				const oracleComp = fetchOracle.renderReadUrlCall(args, HOST_COLLAPSED, theme);
				const card = drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme);
				expect(renderCompLines(card)).toEqual(renderCompLines(oracleComp));
			}
		}
		// Anti-vacuity: the row really carries the target and the raw flag, so a view that dropped
		// either would not be comparing two identical blanks above.
		const row = stripVTControlCharacters(
			renderCompText(drawToolView(readUrlToolView.renderCall({ path: targets[0], raw: true }, COLLAPSED), theme)),
		);
		expect(row).toContain("example.com /docs");
		expect(row).toContain("raw");
	});

	it("draws a fetched page's panel, metadata and preview with exact byte parity", () => {
		for (const result of [page, truncatedPage]) {
			for (const expanded of [false, true]) {
				const oracleLines = oracleLinesOf(result, expanded);
				const viewLines = viewLinesOf(result, expanded);
				expect(viewLines).toHaveLength(oracleLines.length);
				const note = heldBackIndex(oracleLines);
				const truncatedNotice = oracleLines.findIndex(line =>
					stripVTControlCharacters(line).includes("Output truncated"),
				);
				for (let row = 0; row < oracleLines.length; row++) {
					// The two rows the exception cells below own, pinned there rather than skipped here.
					if (row === note || row === truncatedNotice) continue;
					expect(viewLines[row]).toBe(oracleLines[row]);
				}
			}
		}
	});

	it("holds back the same lines at the same disclosure caps as the renderer did", () => {
		// Anti-vacuity for the parity cell above: the two disclosure states are not the same card. The
		// collapsed preview stops at three of the nine lines and the expanded one reaches all nine, so
		// a view that ignored the context would draw one of them wrong.
		const collapsed = viewLinesOf(page, false).map(line => stripVTControlCharacters(line));
		const expanded = viewLinesOf(page, true).map(line => stripVTControlCharacters(line));
		expect(collapsed.filter(line => line.includes("page line "))).toHaveLength(3);
		expect(expanded.filter(line => line.includes("page line "))).toHaveLength(9);
		expect(collapsed.some(line => line.includes("… 6 more lines"))).toBe(true);
		expect(expanded.some(line => line.includes("more lines"))).toBe(false);
		// A page whose body is blank says so rather than drawing an empty preview, and holds nothing
		// back, so no gesture is offered for rows that are not there.
		const empty = viewLinesOf({ content: [{ type: "text", text: "---\n\n   \n" }], details }, false);
		expect(empty.map(line => stripVTControlCharacters(line))).toEqual(
			oracleLinesOf({ content: [{ type: "text", text: "---\n\n   \n" }], details }, false).map(line =>
				stripVTControlCharacters(line),
			),
		);
		expect(empty.some(line => stripVTControlCharacters(line).includes("(no content)"))).toBe(true);
		expect(empty.some(line => stripVTControlCharacters(line).includes("more lines"))).toBe(false);
	});

	it("exception cell: the held-back note is worded and toned by the host, not by the tool", () => {
		// `main` wrote the whole note in `muted` and wrapped the host's own expand hint inside that
		// colour; the host writes one note for every card that holds something back, in `dim`, with the
		// hint beside it rather than inside it. The words and the columns are the same, which is what
		// the plain-text equality pins; the bytes of both arms are pinned so the difference stays this
		// one row and this one role.
		const oracleLines = oracleLinesOf(page, false);
		const viewLines = viewLinesOf(page, false);
		const row = heldBackIndex(oracleLines);
		expect(row).toBeGreaterThan(0);
		expect(stripVTControlCharacters(viewLines[row] ?? "")).toBe(stripVTControlCharacters(oracleLines[row] ?? ""));
		const hint = formatExpandHint(theme, false, true);
		expect(oracleLines[row]).toContain(theme.fg("muted", `… 6 more lines ${hint}`));
		expect(viewLines[row]).toContain(`${theme.fg("dim", "… 6 more lines")} ${hint}`);
	});

	it("exception cell: the truncation mark is its own span, so the glyph and its words carry the tone separately", () => {
		// `main` coloured the glyph and the sentence in one wrap. A view states a glyph the host
		// resolves and the words beside it, so the same colour opens twice: identical on a screen, and
		// pinned here so the difference cannot widen to the words themselves.
		const oracleLines = oracleLinesOf(truncatedPage, false);
		const viewLines = viewLinesOf(truncatedPage, false);
		const row = oracleLines.findIndex(line => stripVTControlCharacters(line).includes("Output truncated"));
		expect(row).toBeGreaterThan(0);
		expect(stripVTControlCharacters(viewLines[row] ?? "")).toBe(stripVTControlCharacters(oracleLines[row] ?? ""));
		expect(oracleLines[row]).toContain(theme.fg("warning", `${theme.status.warning} Output truncated`));
		expect(viewLines[row]).toContain(
			`${theme.styledSymbol("status.warning", "warning")}${theme.fg("warning", " Output truncated")}`,
		);
	});

	it("draws a failed fetch exactly as the renderer did", () => {
		const failures: ReadUrlViewResult[] = [
			{ content: [{ type: "text", text: "Error: 404 Not Found" }], isError: true, details },
			{ content: [{ type: "text", text: "Error: connection reset\nafter two retries" }], isError: true, details },
			{ content: [{ type: "text", text: "" }], isError: true },
			{ content: [], isError: true },
			// A result with no details is a failure even when nothing set the flag: there is no page.
			{ content: [{ type: "text", text: "nothing came back" }] },
			{ content: [{ type: "text", text: "a\tfailure\twith\ttabs" }], isError: true, details },
		];
		for (const failure of failures) {
			expect(viewLinesOf(failure, false)).toEqual(oracleLinesOf(failure, false));
		}
		// Anti-vacuity: the failure card is a panel with the reason in it, not an empty frame, and a
		// tab never reaches the screen.
		const rows = viewLinesOf(failures[0]!, false).map(line => stripVTControlCharacters(line));
		expect(rows.some(line => line.includes("404 Not Found"))).toBe(true);
		expect(viewLinesOf(failures[5]!, false).join("\n")).not.toContain("\t");
	});

	it("carries the same OSC 8 targets the renderer carried, on the row and in the metadata", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const args = { path: "https://example.com/docs" };
			expect(renderCompLines(drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme))).toEqual(
				renderCompLines(fetchOracle.renderReadUrlCall(args, HOST_COLLAPSED, theme)),
			);
			const redirected = { ...truncatedPage, isError: false };
			const oracleLines = oracleLinesOf(redirected, false);
			const viewLines = viewLinesOf(redirected, false);
			const finalUrlRow = oracleLines.findIndex(line => stripVTControlCharacters(line).includes("Final URL:"));
			expect(finalUrlRow).toBeGreaterThan(0);
			expect(viewLines[finalUrlRow]).toBe(oracleLines[finalUrlRow]);
			// Anti-vacuity: with hyperlinks on the rows really do carry OSC 8, so the equality above is
			// not two plain strings agreeing.
			expect(viewLines[finalUrlRow]).toContain("\u001b]8;");
			expect(viewLines[finalUrlRow]).toContain("https://example.com/docs/v2");
			const callRow = renderCompText(drawToolView(readUrlToolView.renderCall(args, COLLAPSED), theme));
			expect(callRow).toContain("\u001b]8;");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});
});

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
describe("debug tool differential", () => {
	const snapshot: DapSessionSummary = {
		id: "dbg-1",
		adapter: "debugpy",
		cwd: "/repo",
		program: "scripts/job.py",
		status: "stopped",
		launchedAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-01T00:00:01.000Z",
		stopReason: "breakpoint",
		frameName: "main",
		source: { path: "/repo/scripts/job.py" },
		line: 42,
		column: 7,
		breakpointFiles: 1,
		breakpointCount: 1,
		functionBreakpointCount: 0,
		outputBytes: 128,
		outputTruncated: false,
		needsConfigurationDone: false,
	};

	const details: DebugToolDetails = { action: "stack_trace", success: true, snapshot };

	function oracleLinesOf(
		result: DebugViewResult,
		options: RenderResultOptions,
		args?: Partial<DebugParams>,
		width = WIDTH,
	): string[] {
		return renderCompLines(debugOracle.debugToolRenderer.renderResult(result, options, theme, args), width);
	}

	function viewLinesOf(
		result: DebugViewResult,
		context: ToolViewContext,
		args?: Partial<DebugParams>,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(debugToolView.renderResult(result, context, args), theme), width);
	}

	it("draws the call row for every target the summary names, with exact byte parity", () => {
		const calls: Array<Partial<DebugParams>> = [
			{},
			{ action: "launch", program: "/repo/scripts/job.py" },
			{ action: "set_breakpoint", file: "/repo/src/main.c", line: 42 },
			// A file with no line falls past the source branch, which is the pair the row needs.
			{ action: "set_breakpoint", file: "/repo/src/main.c" },
			{ action: "set_breakpoint", function: "main" },
			{ action: "evaluate", expression: "state.frames[0]" },
			{ action: "custom_request", command: "threads" },
			{ action: "read_memory", memory_reference: "0x7ffd" },
			{ action: "set_instruction_breakpoint", instruction_reference: "0x1000" },
			{ action: "remove_data_breakpoint", data_id: "watch-1" },
			{ action: "set_data_breakpoint", name: "counter" },
			// Empty strings fall through every branch, so the row is the action alone.
			{ action: "pause", program: "", function: "", name: "" },
			{
				action: "stack_trace",
				expression: `an expression far past the row's budget ${"and more of it ".repeat(12)}`,
			},
		];
		for (const args of calls) {
			const drawn = renderCompText(drawToolView(debugToolView.renderCall(args, COLLAPSED), theme));
			expect(drawn).toBe(renderCompText(debugOracle.debugToolRenderer.renderCall(args, HOST_COLLAPSED, theme)));
		}
		// Anti-vacuity: the row states the action with its underscores read as words, and the target
		// beside it, so the parity above is not two identical stubs.
		const row = stripVTControlCharacters(
			renderCompText(
				drawToolView(
					debugToolView.renderCall({ action: "set_breakpoint", file: "/repo/src/main.c", line: 42 }, COLLAPSED),
					theme,
				),
			),
		);
		expect(row).toContain("set breakpoint");
		expect(row).toContain("main.c:42");
	});

	it("fills the same panel the renderer filled, below the header, at every width and disclosure", () => {
		const results: Array<{ result: DebugViewResult; holdsBack: boolean }> = [
			{
				result: { content: [{ type: "text", text: "Session dbg-1\nAdapter: debugpy" }], details },
				holdsBack: false,
			},
			// No snapshot: the card is the output section alone.
			{
				result: { content: [{ type: "text", text: "ok" }], details: { action: "continue", success: true } },
				holdsBack: false,
			},
			// No text content at all, which is the "No output" line the card falls back to.
			{ result: { content: [], details }, holdsBack: false },
			{
				result: { content: [{ type: "text", text: "adapter not found" }], details, isError: true },
				holdsBack: false,
			},
			// More lines than either preview shows, which is the held-back note in both states.
			{
				result: {
					content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
					details,
				},
				holdsBack: true,
			},
			// A tab and a line past the column budget, which the card de-tabs and cuts.
			{
				result: {
					content: [{ type: "text", text: `col\tumn\n${"x".repeat(TRUNCATE_LENGTHS.LINE + 40)}` }],
					details,
				},
				holdsBack: false,
			},
		];
		for (const { result, holdsBack } of results) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLinesOf(result, context, undefined, width);
					const oracle = oracleLinesOf(result, options, undefined, width);
					// The same rows in the same order at every width, note and all: the header is the
					// one row whose words changed, and it is pinned in its own cell.
					expect(drawn.slice(1).map(line => stripVTControlCharacters(line).trimEnd())).toEqual(
						oracle.slice(1).map(line => stripVTControlCharacters(line).trimEnd()),
					);
					// A card that holds nothing back matches byte for byte; the note's colour is the
					// only other difference, and it is pinned in its own cell too.
					if (!holdsBack) expect(drawn.slice(1)).toEqual(oracle.slice(1));
				}
			}
		}
		// Anti-vacuity: the rows compared above are the session lines and the adapter's own output,
		// not a frame with nothing in it.
		const panel = viewLinesOf(results[0]!.result, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(panel.some(line => line.includes("Location: /repo/scripts/job.py:42:7"))).toBe(true);
		expect(panel.some(line => line.includes("Adapter: debugpy"))).toBe(true);
		expect(panel.some(line => line.includes("Output"))).toBe(true);
	});

	it("exception cell: the header colours its title and sets the action off, where main concatenated both", () => {
		const result: DebugViewResult = { content: [{ type: "text", text: "ok" }], details };
		const oracleHeader = oracleLinesOf(result, HOST_COLLAPSED)[0] ?? "";
		const viewHeader = viewLinesOf(result, COLLAPSED)[0] ?? "";
		// This theme draws `tool.debug` as nothing, which is why main's row opened on a blank column:
		// it concatenated an empty glyph, a space and an untoned title. The row now states the title in
		// the tool colour and sets the action off with the separator every other tool header uses, and
		// drops the column the empty glyph left behind.
		expect(theme.symbol("tool.debug")).toBe("");
		expect(stripVTControlCharacters(oracleHeader).trimEnd()).toBe("▏  Debug stack trace");
		expect(stripVTControlCharacters(viewHeader).trimEnd()).toBe("▏ Debug: stack trace");
		expect(viewHeader).toContain(theme.fg("accent", "Debug"));
		expect(viewHeader).toContain(theme.fg("muted", "stack trace"));
	});

	it("exception cell: the held-back note draws in the dim its expand hint already used", () => {
		const result: DebugViewResult = {
			content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
			details,
		};
		const note = (lines: string[]): string => lines.find(line => line.includes("more line")) ?? "";
		const oracleNote = note(oracleLinesOf(result, HOST_COLLAPSED));
		const viewNote = note(viewLinesOf(result, COLLAPSED));
		const rail = viewNote.slice(0, viewNote.indexOf("\u001b[38;2", 1));
		expect(stripVTControlCharacters(oracleNote)).toBe(stripVTControlCharacters(viewNote));
		expect(oracleNote).toBe(
			`${rail}${theme.fg("muted", `… 17 more lines ${formatExpandHint(theme, false, true)}`)}`.trimEnd(),
		);
		expect(viewNote).toBe(
			`${rail}${theme.fg("dim", "… 17 more lines")} ${formatExpandHint(theme, false, true)}`.trimEnd(),
		);
	});

	it("reports a result still arriving as running, and the settled one as done", () => {
		const result: DebugViewResult = { content: [{ type: "text", text: "ok" }], details };
		const running = viewLinesOf(result, { expanded: false, partial: true })[0] ?? "";
		const settled = viewLinesOf(result, COLLAPSED)[0] ?? "";
		const oracleRunning = oracleLinesOf(result, { expanded: false, isPartial: true })[0] ?? "";
		// The running arm draws the glyph main drew for it, and the settled arm draws none, which is
		// what this theme's blank `tool.debug` emblem means. Without `partial` in the context the two
		// would be the same row, and every update of a live session would report success.
		const glyph = (line: string): string =>
			stripVTControlCharacters(line)
				.replace(/^\s*▏\s?/u, "")
				.trimEnd()
				.slice(0, 1);
		expect(glyph(running)).toBe(glyph(oracleRunning));
		expect(glyph(running)).not.toBe(glyph(settled));
		expect(
			stripVTControlCharacters(settled)
				.replace(/^\s*▏\s?/u, "")
				.startsWith("Debug"),
		).toBe(true);
	});
});
