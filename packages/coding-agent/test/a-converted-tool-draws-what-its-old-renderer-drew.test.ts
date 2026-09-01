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
 * WHAT THIS SUITE DOES NOT CATCH. Thirty-five legitimate differences are acknowledged and asserted as
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
 * 10) The `ssh` command preview, windowed by the rows it occupies rather than by its own line
 *     count, 11) its result frame, which states the outcome on the rail and leaves the remote's
 *     output on the terminal's ground where `main` filled every row with the outcome plate,
 *     12) its truncation notice, a warning-toned line rather than a bracketed aside, and 13) its
 *     collapsed output window, which spends one of its rows on the note it writes.
 * 14) A `todo` task row, whose mark and words are two spans a host draws from its own tables, so
 *     the terminal restates the same colour on each where `main` painted the whole row in one run,
 *     15) the collapsed row's separators, written into the run beside them rather than each into a
 *     run of its own, and 16) an empty board, which opens no zero-width colour run for a title and
 *     an emblem it does not draw.
 * 17) The question under an `inspect_image` call row, which main drew after the zero-width colour
 *     runs its single `Text` closed, 18) the answer panel, which states the outcome on the rail
 *     where main asked for the legacy muted edge by hand, 19) its header, which appends the model
 *     and the media type as the row's own metadata rather than joining them on with an unstyled
 *     dot, and 20) a card with no answer, which keeps that metadata on the row where main hung it
 *     on a second row beneath.
 * 21) The `search_tool_bm25` matches, which are a list the host marks and lays out: a branch on
 *     each row where main drew a dim bullet, the summary on the row rather than indented under it,
 *     and the server and the score set off by spaces rather than by a dot the tool wrote itself.
 *     22) Its held-back count, which closes the list on the last branch and leaves the expand
 *     gesture to the host, where main wrote the bracketed hint into the row. 23) Its card with no
 *     matches and 24) its card with no details, whose message the host indents under a header it
 *     cuts, where main opened a plain text block that wrapped the header and started the message in
 *     column zero behind the colour runs the wrap had closed.
 * 25) The `ast_edit` held-back groups, whose count closes the card in the dim the host writes every
 *     card's held-back note in, with the expand gesture the host offers, where main wrote the same
 *     sentence in muted and offered nothing. 26) Its multi-line error card, where main coloured the
 *     whole message and then split the coloured string, so the run opened on the first row and
 *     closed on the last: the second row started inside a run it never opened and lost the
 *     two-column indent. Each row now opens and closes its own run and carries its own indent.
 * 27) The `file_search` call row, its failure row and its text-only empty row, which main built with
 *     `new Text(text, 1, 0)`: the pad indents each one column past every other tool's row, and a
 *     view is drawn with no pad, so the row moves left and nothing else about it changes.
 * 28) Its rail, which main left to the block's own default -- dim on a settled card and warning on a
 *     truncated one -- where the host's reduction quiets every rail but a failure's, as the twelve
 *     renderers that asked for `borderMuted` by hand already drew. The outcome stays in the words on
 *     the rows, which are byte-identical, so nothing the warning rail said is lost.
 * 29) Its held-back count, which closes the list in the same dim main wrote it in and adds the expand
 *     gesture the host offers on every other card, where main wrote the count alone.
 * 30) Its empty detailed card, whose rows carry their own two-column indent and open only the colour
 *     runs they use, where main joined pre-coloured strings into one `Text` and left each row in
 *     column zero behind the zero-width runs its neighbours had closed.
 * 31) Its directory rows, which draw the path alone where main opened a colour run for a folder glyph
 *     the preset does not draw and closed it without a character between.
 * 32) The `text_search` call row, its failure row and its text-only empty row, which main built with
 *     `new Text(text, 1, 0)`, and 33) its card with no matches, whose head row keeps that pad while
 *     every row under it moves two columns in, where main joined the header and the message into one
 *     `Text` and left the message in column zero.
 * 34) Its rail, quieted for the reason `file_search`'s is: main took the block's own default, dim on a
 *     settled card and warning on a truncated one, and the host quiets every rail but a failure's,
 *     leaving the outcome in the words on the rows, which are byte-identical.
 * 35) Its held-back count, which the host closes the card with in the same dim main wrote it in, plus
 *     the expand gesture, where main wrote the count alone. The unit is main's: matches for an
 *     ordinary search, files for a paths-only one, and rows when the output marked no match line.
 * Two branches are unobservable rather than untested. A `file_search` head row whose pattern arrived
 * empty draws the same bytes whether the view states the empty description or omits it, because the
 * terminal draws nothing for either, so only a host that reads the view could tell them apart; the
 * cells sweep the empty pattern and the absent one at every width, and the frames agree. And the row
 * a collapsed `ast_edit` card reserves for
 * its held-back note changes nothing at the current budget, since the smallest group the tool writes
 * is three rows and a second group costs seven. Both arms reserve it identically, and the cell
 * asserts the arithmetic, so raising `PREVIEW_LIMITS.COLLAPSED_LINES` turns the suite red instead of
 * leaving the branch silently uncovered.
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
import { LocalProtocolHandler } from "@veyyon/coding-agent/internal-urls/local-protocol";
import {
	createIrcMessageCard,
	type IrcMessageCard,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/irc-message";
import type { TruncationResult } from "@veyyon/coding-agent/session/streaming-output";
import type { IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import type { SymbolKey } from "@veyyon/coding-agent/theme/symbols";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { IrcDetails } from "@veyyon/coding-agent/tools/agent/irc";
import { type IrcViewArgs, type IrcViewResult, ircToolView } from "@veyyon/coding-agent/tools/agent/irc-view";
import {
	type MemoryViewResult,
	recallToolView,
	reflectToolView,
	retainToolView,
} from "@veyyon/coding-agent/tools/agent/memory-view";
import type { ResolveToolDetails } from "@veyyon/coding-agent/tools/agent/resolve";
import { type ResolveViewResult, resolveToolView } from "@veyyon/coding-agent/tools/agent/resolve-view";
import {
	TODO_STRIKE_HOLD_FRAMES,
	TODO_STRIKE_TOTAL_FRAMES,
	type TodoPhase,
	type TodoRenderArgs,
} from "@veyyon/coding-agent/tools/agent/todo";
import { type TodoViewResult, todoToolView } from "@veyyon/coding-agent/tools/agent/todo-view";
import { formatGroupedFiles } from "@veyyon/coding-agent/tools/core/grouped-file-output";
import { formatFullOutputReference } from "@veyyon/coding-agent/tools/core/output-meta";
import { formatTruncationMetaNotice, type TruncationMeta } from "@veyyon/coding-agent/tools/core/output-notice";
import {
	formatCodeFrameLine,
	formatExpandHint,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
	previewWindowRows,
	replaceTabs,
	TRUNCATE_LENGTHS,
} from "@veyyon/coding-agent/tools/core/render-utils";
import type { InspectImageToolDetails } from "@veyyon/coding-agent/tools/fs/inspect-image";
import {
	type InspectImageViewArgs,
	type InspectImageViewResult,
	inspectImageToolView,
} from "@veyyon/coding-agent/tools/fs/inspect-image-view";
import { SET_CWD_TOOL_NAME } from "@veyyon/coding-agent/tools/fs/reroot-hint";
import { type SetCwdToolDetails, setCwdToolView } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { type WriteViewArgs, type WriteViewResult, writeToolView } from "@veyyon/coding-agent/tools/fs/write-view";
import type { AstEditToolDetails } from "@veyyon/coding-agent/tools/search/ast-edit";
import {
	type AstEditViewArgs,
	type AstEditViewResult,
	astEditToolView,
} from "@veyyon/coding-agent/tools/search/ast-edit-view";
import type { FileSearchDetails, FileSearchRenderArgs } from "@veyyon/coding-agent/tools/search/file-search";
import { type FileSearchViewResult, fileSearchToolView } from "@veyyon/coding-agent/tools/search/file-search-view";
import type {
	SearchToolBm25Details,
	SearchToolBm25Match,
	SearchToolBm25Params,
} from "@veyyon/coding-agent/tools/search/search-tool-bm25";
import {
	type SearchToolBm25ViewResult,
	searchToolBm25ToolView,
} from "@veyyon/coding-agent/tools/search/search-tool-bm25-view";
import {
	COLLAPSED_TEXT_LIMIT,
	EXPANDED_TEXT_LIMIT,
	type TextSearchDetails,
	type TextSearchRenderArgs,
} from "@veyyon/coding-agent/tools/search/text-search";
import { type TextSearchViewResult, textSearchToolView } from "@veyyon/coding-agent/tools/search/text-search-view";
import type { DebugParams, DebugToolDetails } from "@veyyon/coding-agent/tools/shell/debug";
import { type DebugViewResult, debugToolView } from "@veyyon/coding-agent/tools/shell/debug-view";
import { type SshViewArgs, type SshViewResult, sshToolView } from "@veyyon/coding-agent/tools/shell/ssh-view";
import type { ReadUrlToolDetails } from "@veyyon/coding-agent/tools/web/fetch";
import { type ReadUrlViewResult, readUrlToolView } from "@veyyon/coding-agent/tools/web/fetch-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { getStateBgColor } from "@veyyon/coding-agent/tui/utils";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import type {
	FramedBlockView,
	LineToolView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewStatus,
} from "@veyyon/view";
import { TODO_STATUSES } from "@veyyon/wire";
import * as astEditOracle from "./oracles/ast-edit-main-renderer";
import * as certifyArmsOracle from "./oracles/certify-arms-main-renderer";
import * as debugOracle from "./oracles/debug-main-renderer";
import * as fetchOracle from "./oracles/fetch-main-renderer";
import * as fileSearchOracle from "./oracles/file-search-main-renderer";
import * as goalOracle from "./oracles/goal-main-renderer";
import * as initExperimentOracle from "./oracles/init-experiment-main-renderer";
import * as inspectImageOracle from "./oracles/inspect-image-main-renderer";
import * as ircOracle from "./oracles/irc-main-renderer";
import * as logExperimentOracle from "./oracles/log-experiment-main-renderer";
import * as memoryOracle from "./oracles/memory-main-renderer";
import * as resolveOracle from "./oracles/resolve-main-renderer";
import * as runExperimentOracle from "./oracles/run-experiment-main-renderer";
import * as searchToolBm25Oracle from "./oracles/search-tool-bm25-main-renderer";
import * as setCwdOracle from "./oracles/set-cwd-main-renderer";
import * as sshOracle from "./oracles/ssh-main-renderer";
import * as textSearchOracle from "./oracles/text-search-main-renderer";
import * as todoOracle from "./oracles/todo-main-renderer";
import * as updateNotesOracle from "./oracles/update-notes-main-renderer";
import * as writeOracle from "./oracles/write-main-renderer";

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
	"ssh",
	"todo",
	"inspect_image",
	"search_tool_bm25",
	"ast_edit",
	"irc",
	"write",
	"file_search",
	"text_search",
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
			"ssh",
			"todo",
			"inspect_image",
			"search_tool_bm25",
			"ast_edit",
			"irc",
			"write",
			"file_search",
			"text_search",
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

describe("ssh tool differential", () => {
	const args: SshViewArgs = { host: "router", command: "uptime" };
	/**
	 * The card the host asks for when nothing is streaming.
	 *
	 * `partial: false` is what `viewToolRenderer` passes on from `RenderResultOptions.isPartial`, so a
	 * cell comparing against `HOST_COLLAPSED` states it rather than leaving it undefined: an omitted
	 * `partial` is a call site with nothing to stream, which is a different question.
	 */
	const CALL_COLLAPSED: ToolViewContext = { expanded: false, partial: false };
	const CALL_EXPANDED: ToolViewContext = { expanded: true, partial: false };

	function oracleLinesOf(
		result: SshViewResult,
		options: RenderResultOptions,
		callArgs: SshViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(sshOracle.sshMainRenderer.renderResult(result, options, theme, callArgs), width);
	}

	function viewLinesOf(
		result: SshViewResult,
		context: ToolViewContext,
		callArgs: SshViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(sshToolView.renderResult(result, context, callArgs), theme), width);
	}

	/** The rows with every escape stripped, which leaves the plate out of the comparison. */
	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	it("draws the pending call frame the renderer drew, at every width and disclosure", () => {
		const calls: SshViewArgs[] = [
			{},
			{ host: "router" },
			{ host: "router", command: "uptime" },
			{ host: "router", command: "set -e\ncat > /etc/hosts <<'EOF'\n# hosts\nEOF" },
			{ host: "router", command: "col\tumn" },
			// A command that wraps past the viewport is the one case the two arms answer differently,
			// pinned in its own cell below.
			{ host: "router", command: `wide ${"x".repeat(200)}` },
		];
		for (const callArgs of calls) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40]) {
					const drawn = renderCompLines(drawToolView(sshToolView.renderCall(callArgs, context), theme), width);
					const oracle = renderCompLines(sshOracle.sshMainRenderer.renderCall(callArgs, options, theme), width);
					expect(unstyled(drawn)).toEqual(unstyled(oracle));
				}
			}
		}
		// Anti-vacuity: the frame carries the host and the command under a prompt, not an empty box.
		const rows = unstyled(renderCompLines(drawToolView(sshToolView.renderCall(args, CALL_COLLAPSED), theme)));
		expect(rows.some(row => row.includes("SSH"))).toBe(true);
		expect(rows.some(row => row.includes("[router]"))).toBe(true);
		expect(rows.some(row => row.includes("$ uptime"))).toBe(true);
	});

	it("exception cell: a wrapped command is windowed by the rows it occupies, not by its line count", () => {
		const callArgs: SshViewArgs = { host: "router", command: `wide ${"x".repeat(200)}` };
		const narrow = 12;
		const oracle = unstyled(
			renderCompLines(sshOracle.sshMainRenderer.renderCall(callArgs, HOST_COLLAPSED, theme), narrow),
		);
		const drawn = unstyled(
			renderCompLines(drawToolView(sshToolView.renderCall(callArgs, CALL_COLLAPSED), theme), narrow),
		);
		// Main capped the section at a number of the tool's OWN lines, and one command line is one
		// line however many rows it wraps to, so a single long command filled the terminal it was
		// supposed to fit inside. The host counts the rows the section occupies after wrapping, so the
		// same command spends a window and says how much of itself it dropped.
		expect(oracle.length).toBeGreaterThan(drawn.length);
		// The note is read across the rows it wraps into, past the rail every framed row starts with:
		// at twelve columns "earlier lines" is two rows of the card.
		const body = (rows: readonly string[]): string => rows.map(row => row.replace(/^▏\s*/u, "")).join(" ");
		expect(body(oracle)).not.toContain("earlier line");
		expect(body(drawn)).toContain("earlier line");
		// The end of the command is what both arms keep, so the window cut the front and nothing else.
		expect(drawn.at(-1)).toBe(oracle.at(-1));
	});

	it("draws the settled and failed result frames the renderer drew", () => {
		const results: SshViewResult[] = [
			{ content: [{ type: "text", text: "" }] },
			{ content: [{ type: "text", text: "load average: 0.1" }] },
			{ content: [{ type: "text", text: "col\tumn\nsecond" }] },
			{ content: [{ type: "text", text: "permission denied" }], isError: true },
		];
		for (const result of results) {
			for (const [context, options] of [
				[CALL_COLLAPSED, HOST_COLLAPSED],
				[CALL_EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					expect(unstyled(viewLinesOf(result, context, args, width))).toEqual(
						unstyled(oracleLinesOf(result, options, args, width)),
					);
				}
			}
		}
		// Anti-vacuity: the compared rows are the command, the output label and the remote's own line.
		const rows = unstyled(viewLinesOf(results[1]!, CALL_COLLAPSED));
		expect(rows.some(row => row.includes("$ uptime"))).toBe(true);
		expect(rows.some(row => row.includes("Output"))).toBe(true);
		expect(rows.some(row => row.includes("load average: 0.1"))).toBe(true);
	});

	it("reports a result still arriving as pending, and the settled one with the ssh emblem", () => {
		const result: SshViewResult = { content: [{ type: "text", text: "streaming" }] };
		const running = unstyled(viewLinesOf(result, { expanded: false, partial: true }))[0] ?? "";
		const settled = unstyled(viewLinesOf(result, CALL_COLLAPSED))[0] ?? "";
		const oracleRunning = unstyled(oracleLinesOf(result, { expanded: false, isPartial: true }))[0] ?? "";
		expect(running).toBe(oracleRunning);
		// Without `partial` in the context both rows would be the settled one, and a live session
		// would report every update as a completed command.
		expect(running).not.toBe(settled);
		expect(settled).toContain("SSH");
	});

	it("windows the command by the rows the terminal has, keeping the end and stating the rest", () => {
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_unused, index) => `step_${index}`).join("\n");
		const callArgs: SshViewArgs = { host: "router", command };
		const rows = unstyled(viewLinesOf({ content: [] }, CALL_COLLAPSED, callArgs));
		const text = rows.join("\n");
		expect(text).toContain(`step_${total - 1}`);
		expect(text).toContain("earlier line");
		expect(text).not.toContain("step_0");
		// The window is the host's arithmetic, so the section spends no more rows than it was given.
		const commandRows = rows.filter(row => /step_\d+|earlier line/.test(row));
		expect(commandRows.length).toBeLessThanOrEqual(previewWindowRows());
		// Expanding drops the window rather than widening it.
		const expanded = unstyled(viewLinesOf({ content: [] }, CALL_EXPANDED, callArgs)).join("\n");
		expect(expanded).toContain("$ step_0");
		expect(expanded).not.toContain("earlier line");
	});

	it("exception cell: the frame states its outcome on the rail alone, and leaves the body unplated", () => {
		const result: SshViewResult = { content: [{ type: "text", text: "load average: 0.1" }] };
		const plate = theme.getBgAnsi(getStateBgColor("success"));
		// Main filled every row with the success plate, which is the treatment a card whose body is a
		// verdict asks for; an ssh body is the remote host's own output, so the card now states the
		// outcome once, on the rail, and leaves the transcript on the terminal's ground. Every other
		// cell here compares the arms with escapes stripped, which is what makes this the one pinned
		// difference between them.
		expect(oracleLinesOf(result, HOST_COLLAPSED).some(line => line.includes(plate))).toBe(true);
		expect(viewLinesOf(result, CALL_COLLAPSED).some(line => line.includes(plate))).toBe(false);
	});

	it("exception cell: the truncation notice is a warning line, not a bracketed aside", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 400,
			totalBytes: 40_960,
			outputLines: 20,
			outputBytes: 2_048,
		};
		const result: SshViewResult = {
			content: [{ type: "text", text: "output" }],
			details: { meta: { truncation } },
		};
		const message = formatTruncationMetaNotice(truncation);
		expect(message.length).toBeGreaterThan(0);
		const notice = (lines: readonly string[]): string => unstyled(lines).find(line => line.includes(message)) ?? "";
		const oracleNotice = notice(oracleLinesOf(result, HOST_COLLAPSED));
		const viewNotice = notice(viewLinesOf(result, CALL_COLLAPSED));
		// Same words in both arms. The brackets main drew around them are the theme's, which a tool
		// cannot name, so the line arrives as a warning-toned run and the host draws it plainly.
		// The rail and its indent are the host's two columns, which every row of a framed card carries.
		expect(viewNotice.trimEnd().endsWith(message)).toBe(true);
		expect(oracleNotice).toContain(theme.format.bracketLeft);
		expect(viewNotice).not.toContain(theme.format.bracketLeft);
	});

	it("exception cell: the collapsed output window spends its own row on the note it writes", () => {
		const text = Array.from({ length: 40 }, (_unused, index) => `out ${index}`).join("\n");
		const result: SshViewResult = { content: [{ type: "text", text }] };
		const outputRows = (lines: readonly string[]): string[] =>
			unstyled(lines).filter(row => /out \d+|earlier line/.test(row));
		const oracle = outputRows(oracleLinesOf(result, HOST_COLLAPSED));
		const drawn = outputRows(viewLinesOf(result, CALL_COLLAPSED));
		// Main showed `OUTPUT_COLLAPSED` lines AND a note above them, so the section drew one row more
		// than the bound it counted against; the host's window counts the note as one of the rows it
		// was given, and words it the way every other windowed section is worded.
		expect(oracle.length).toBe(PREVIEW_LIMITS.OUTPUT_COLLAPSED + 1);
		expect(drawn.length).toBe(PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		expect(oracle.at(-1)).toBe(drawn.at(-1));
		expect(oracle[0]).toContain("earlier lines, showing");
		expect(drawn[0]).toContain("earlier lines");
		expect(drawn[0]).not.toContain("showing");
	});
});

describe("todo tool differential", () => {
	const board: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [
				{
					name: "Foundation",
					tasks: [
						{ content: "scaffold the crate", status: "completed" },
						{ content: "wire the workspace", status: "in_progress" },
					],
				},
				{
					name: "Auth",
					tasks: [
						{ content: "port the credential store", status: "pending" },
						{ content: "drop the old flow", status: "abandoned" },
					],
				},
			],
			completedTasks: [{ phase: "Foundation", content: "scaffold the crate" }],
		},
	};
	const singlePhase: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [{ name: "Work", tasks: [{ content: "one task", status: "pending" }] }],
		},
	};
	const finished: TodoViewResult = {
		content: [{ type: "text", text: "board" }],
		details: {
			storage: "session",
			phases: [{ name: "Work", tasks: [{ content: "one task", status: "completed" }] }],
		},
	};
	const emptyBoard: TodoViewResult = {
		content: [{ type: "text", text: "No todos" }],
		details: { storage: "session", phases: [] },
	};
	const failed: TodoViewResult = { content: [{ type: "text", text: "todo: unknown op" }], isError: true };

	/** Every board the card can be handed, named so a failing cell says which one broke. */
	const BOARDS: ReadonlyArray<readonly [string, TodoViewResult]> = [
		["four tasks over two phases", board],
		["one phase, which is not named", singlePhase],
		["a board with nothing open", finished],
		["a board with no tasks at all", emptyBoard],
		["a write that failed", failed],
	];

	function oracleLines(result: TodoViewResult, options: RenderResultOptions, width = WIDTH): string[] {
		// Main's renderer declared `content` required and a view declares it optional, which is the
		// tool's own shape: the board comes from `details`, and the text is only the failure message.
		const forOracle = { ...result, content: result.content ?? [] };
		return renderCompLines(todoOracle.todoToolRenderer.renderResult(forOracle, options, theme), width);
	}

	function viewLines(result: TodoViewResult, context: ToolViewContext, width = WIDTH): string[] {
		return renderCompLines(drawToolView(todoToolView.renderResult(result, context), theme, context.frame), width);
	}

	/** The rows with every escape stripped, which leaves the run boundaries out of the comparison. */
	function unstyled(lines: readonly string[]): string[] {
		return lines.map(line => stripVTControlCharacters(line).trimEnd());
	}

	/**
	 * Every attribute the card is painted with, once each.
	 *
	 * The arms differ in where a run starts and stops and nowhere else, so the SET of attributes the
	 * card carries is the part of the styling that is still a claim: a task drawn in the wrong colour,
	 * or with the strike dropped, changes it, while restating a colour on a second span does not.
	 *
	 * Read over the card rather than row by row, because which row a separator's dim run lands on is
	 * one of the run-boundary differences: at twelve columns the collapsed row wraps, and main's
	 * separator run wraps with it while the host's separator travels inside the run beside it.
	 */
	function attributes(lines: readonly string[]): string[] {
		return [...new Set(lines.flatMap(line => line.match(/\x1b\[[\d;]*m/gu) ?? []))].sort();
	}

	/** How many characters of a row the strike covers, read off the SGR 9 runs the row carries. */
	function struckChars(line: string): number {
		let total = 0;
		for (const run of line.matchAll(/\x1b\[9m(.*?)\x1b\[29m/gu)) {
			total += [...stripVTControlCharacters(run[1] ?? "")].length;
		}
		return total;
	}

	it("draws the pending call row the renderer drew, byte for byte, at every width", () => {
		const calls: TodoRenderArgs[] = [
			{} as TodoRenderArgs,
			{ op: "init", items: ["a", "b"] } as TodoRenderArgs,
			{ op: "done", task: "scaffold the crate" } as TodoRenderArgs,
			{ op: "append", phase: "Auth", items: ["x"] } as TodoRenderArgs,
			// The two malformed deltas of #2005: a non-string op, and a legacy batch cut mid-JSON.
			{ op: 1 } as unknown as TodoRenderArgs,
			{ ops: '[{"op":"init"' } as unknown as TodoRenderArgs,
		];
		for (const args of calls) {
			for (const frame of [undefined, 3]) {
				for (const width of [WIDTH, 40]) {
					const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: frame };
					const drawn = renderCompLines(
						drawToolView(todoToolView.renderCall(args, { expanded: false, partial: true, frame }), theme, frame),
						width,
					);
					expect(drawn).toEqual(
						renderCompLines(todoOracle.todoToolRenderer.renderCall(args, options, theme), width),
					);
				}
			}
		}
		// Anti-vacuity: the row names the tool and the operation it is carrying.
		const row = unstyled(
			renderCompLines(
				drawToolView(
					todoToolView.renderCall({ op: "done", task: "scaffold the crate" } as TodoRenderArgs, {
						expanded: false,
						partial: true,
					}),
					theme,
				),
			),
		).join("\n");
		expect(row).toContain("Todo");
		expect(row).toContain("done");
		expect(row).toContain("scaffold the crate");
	});

	it("draws every board the renderer drew, at every width, disclosure and frame", () => {
		for (const [name, result] of BOARDS) {
			for (const expanded of [false, true]) {
				for (const partial of [false, true]) {
					for (const frame of [undefined, 1, 4, TODO_STRIKE_TOTAL_FRAMES + 8]) {
						for (const width of [WIDTH, 40, 12]) {
							const context: ToolViewContext = { expanded, partial, frame };
							const options: RenderResultOptions = { expanded, isPartial: partial, spinnerFrame: frame };
							const drawn = viewLines(result, context, width);
							const oracle = oracleLines(result, options, width);
							expect({ name, rows: unstyled(drawn) }).toEqual({ name, rows: unstyled(oracle) });
							expect({ name, paint: attributes(drawn) }).toEqual({ name, paint: attributes(oracle) });
						}
					}
				}
			}
		}
		// Anti-vacuity: an opened board is the phases, their tasks and the state marks, not an empty frame.
		const opened = unstyled(viewLines(board, { expanded: true, partial: false })).join("\n");
		expect(opened).toContain("Foundation");
		expect(opened).toContain("Auth");
		expect(opened).toContain("scaffold the crate");
		expect(opened).toContain("drop the old flow");
		expect(opened).toContain(theme.checkbox.progress);
	});

	it("draws the failed write byte for byte, plate and all", () => {
		for (const width of [WIDTH, 40, 12]) {
			expect(viewLines(failed, { expanded: false, partial: false }, width)).toEqual(
				oracleLines(failed, HOST_COLLAPSED, width),
			);
		}
		expect(unstyled(viewLines(failed, { expanded: false, partial: false })).join("\n")).toContain("todo: unknown op");
	});

	it("sweeps the completion strike the renderer swept, and settles where it settled", () => {
		const taskRow = (rows: readonly string[]): string => rows.find(row => row.includes("scaffold the crate")) ?? "";
		const covered = (frame: number | undefined): { view: number; oracle: number } => ({
			view: struckChars(taskRow(viewLines(board, { expanded: true, partial: false, frame }))),
			oracle: struckChars(taskRow(oracleLines(board, { expanded: true, isPartial: false, spinnerFrame: frame }))),
		});
		const full = [..."scaffold the crate"].length;
		// The hold: the sweep has not started, so the words are struck nowhere yet.
		expect(covered(TODO_STRIKE_HOLD_FRAMES)).toEqual({ view: 0, oracle: 0 });
		// The sweep advances one arm exactly as far as the other, frame by frame.
		let previous = 0;
		for (let frame = TODO_STRIKE_HOLD_FRAMES + 1; frame <= TODO_STRIKE_TOTAL_FRAMES; frame++) {
			const { view, oracle } = covered(frame);
			expect(view).toBe(oracle);
			expect(view).toBeGreaterThanOrEqual(previous);
			previous = view;
		}
		// It terminates: the last frame of the window is the whole task, and a surface that keeps
		// counting past the window stays there rather than wrapping back to the start of the sweep.
		expect(previous).toBe(full);
		expect(covered(TODO_STRIKE_TOTAL_FRAMES + 40)).toEqual({ view: full, oracle: full });
		// A task closed before this card was drawn carries no frame and is struck end to end.
		expect(covered(undefined)).toEqual({ view: full, oracle: full });
		// A task this write did not close is never swept, whatever frame the surface is on.
		const abandoned = (frame: number): number =>
			struckChars(
				viewLines(board, { expanded: true, partial: false, frame }).find(row =>
					row.includes("drop the old flow"),
				) ?? "",
			);
		expect(abandoned(TODO_STRIKE_HOLD_FRAMES + 1)).toBe([..."drop the old flow"].length);
	});

	it("marks every status in the vocabulary the way the renderer marked it, and an unknown one as open", () => {
		// The board keeps a pending task beside the one under test so it stays open: a board whose
		// every task has closed collapses to the done line and has no task row left to read.
		const boardWith = (status: string): TodoViewResult => ({
			content: [{ type: "text", text: "board" }],
			details: {
				storage: "session",
				phases: [
					{
						name: "Work",
						tasks: [
							{ content: "the task", status: status as TodoPhase["tasks"][number]["status"] },
							{ content: "still open", status: "pending" },
						],
					},
				],
			},
		});
		const taskRow = (rows: readonly string[]): string => rows.find(row => row.includes("the task")) ?? "";
		const drawnRow = (status: string): string =>
			taskRow(viewLines(boardWith(status), { expanded: true, partial: false }));
		const oracleRow = (status: string): string => taskRow(oracleLines(boardWith(status), HOST_EXPANDED));

		// Swept from the vocabulary the wire package owns, not from a list written here, and pinned by
		// exact equality: a status added to it arrives with no mark of its own and reds this until one
		// is recorded.
		const marks: Record<string, string> = {};
		for (const status of TODO_STATUSES) {
			const drawn = stripVTControlCharacters(drawnRow(status)).trimEnd();
			expect({ status, row: drawn }).toEqual({
				status,
				row: stripVTControlCharacters(oracleRow(status)).trimEnd(),
			});
			marks[status] = drawn.slice(drawn.indexOf("the task") - 2, drawn.indexOf("the task") - 1);
		}
		expect(marks).toEqual({
			pending: theme.checkbox.unchecked,
			in_progress: theme.checkbox.progress,
			completed: theme.checkbox.checked,
			abandoned: theme.checkbox.unchecked,
		});

		// A status this build has no case for is open work, so it is marked and toned as open and never
		// struck. The last three are keys a record lookup answers off `Object.prototype`, which is how a
		// mark table hands back a function where a glyph was expected.
		for (const foreign of ["cancelled", "blocked", "toString", "constructor", "__proto__"]) {
			const drawn = drawnRow(foreign);
			expect(stripVTControlCharacters(drawn).trimEnd()).toBe(stripVTControlCharacters(oracleRow(foreign)).trimEnd());
			expect(stripVTControlCharacters(drawn)).toContain(`${theme.checkbox.unchecked} the task`);
			expect(struckChars(drawn)).toBe(0);
			expect(attributes([drawn])).toEqual(attributes([oracleRow(foreign)]));
		}
	});
	it("exception cell: a task row states its colour once per span, where main stated it once per row", () => {
		const rowOf = (rows: readonly string[]): string => rows.find(row => row.includes("wire the workspace")) ?? "";
		const drawn = rowOf(viewLines(board, { expanded: true, partial: false }));
		const oracle = rowOf(oracleLines(board, HOST_EXPANDED));
		const accent = theme.fg("accent", "x").replace("x", "").replace("\x1b[39m", "");
		// Main coloured the mark, the gap and the words as one run. A view names the mark and the
		// words as two spans, because a host that is not a terminal draws the mark from its own table,
		// so the terminal restates the same colour on each. Same glyph, same colour, same words.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(oracle.split(accent).length - 1).toBe(1);
		expect(drawn.split(accent).length - 1).toBe(2);
		expect(drawn).toContain(theme.checkbox.progress);
	});

	it("exception cell: the collapsed row's separators sit in the run beside them, not in one of their own", () => {
		const drawn = viewLines(board, { expanded: false, partial: false })[0] ?? "";
		const oracle = oracleLines(board, HOST_COLLAPSED)[0] ?? "";
		const dim = theme.fg("dim", "x").replace("x", "").replace("\x1b[39m", "");
		// Both rows read the same. Main drew each separator dot as its own dim run around each
		// metadatum; the host writes the dots into the run it is already drawing, so the row carries
		// fewer runs for the same bytes on screen.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(drawn.split(dim).length).toBeLessThan(oracle.split(dim).length);
		expect(stripVTControlCharacters(drawn)).toContain("4 tasks · 1 done · Foundation");
	});

	it("exception cell: a board with no tasks opens no empty colour runs", () => {
		const bodyRow = (rows: readonly string[]): string => rows.find(row => row.includes("No todos")) ?? "";
		const drawn = bodyRow(viewLines(emptyBoard, { expanded: true, partial: false }));
		const oracle = bodyRow(oracleLines(emptyBoard, HOST_EXPANDED));
		// Main's status line opened and closed a colour for a title it had already drawn and for an
		// emblem this card does not carry, leaving two zero-width runs before the text. The host emits
		// a run only for a span that has something in it.
		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
		expect(/\x1b\[[\d;]+m\x1b\[39m/u.test(oracle)).toBe(true);
		expect(/\x1b\[[\d;]+m\x1b\[39m/u.test(drawn)).toBe(false);
		expect(stripVTControlCharacters(drawn)).toContain("No todos");
	});
});

describe("inspect_image tool differential", () => {
	const details: InspectImageToolDetails = {
		model: "openai/gpt-4o",
		imagePath: "/repo/shots/error.png",
		mimeType: "image/png",
	};
	const args: InspectImageViewArgs = { path: "/repo/shots/error.png", question: "What error text is visible?" };
	/** The block's rail glyph, read after the theme is loaded rather than while the file is read. */
	const rail = (): string => theme.symbol("block.rail");

	function oracleLines(
		result: InspectImageViewResult,
		options: RenderResultOptions,
		callArgs: InspectImageViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(
			inspectImageOracle.inspectImageToolRenderer.renderResult(result, options, theme, callArgs),
			width,
		);
	}

	function viewLines(
		result: InspectImageViewResult,
		context: ToolViewContext,
		callArgs: InspectImageViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(inspectImageToolView.renderResult(result, context, callArgs), theme), width);
	}

	/**
	 * One drawn row with the settled rail repainted in the colour main asked for.
	 *
	 * The rail is the one byte every row of the panel differs by, and it is pinned in its own cell
	 * below. Swapping it here leaves the rest of the row — every span, tone, cut and note — compared
	 * byte for byte instead of stripped to its letters.
	 */
	function onMainsRail(line: string): string {
		const drawn = theme.fg("dim", rail());
		return line.startsWith(drawn) ? `${theme.fg("borderMuted", rail())}${line.slice(drawn.length)}` : line;
	}

	/**
	 * The settled row both arms build: the emblem this theme draws for the tool, the title, the image.
	 *
	 * The emblem is read from the theme rather than written out, since a theme that draws none leaves
	 * the row opening on its title and both arms drop the column with it.
	 */
	function inspectTitle(pathText: string): string {
		const emblem = theme.styledSymbol("tool.inspectImage", "accent");
		const named = `${theme.fg("accent", "Inspect")}: ${theme.fg("muted", pathText)}`;
		return emblem ? `${emblem} ${named}` : named;
	}

	const answered: InspectImageViewResult = {
		content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
		details,
	};

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: InspectImageViewArgs[] = [
			{},
			{ path: "/repo/shots/error.png" },
			{ path: `${homedir()}/shots/error.png` },
			{ path: "" },
		];
		for (const callArgs of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(inspectImageToolView.renderCall(callArgs, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						inspectImageOracle.inspectImageToolRenderer.renderCall(callArgs, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: a path outside the home directory stays, and one inside it is shortened, so
		// the rows compared above carry a description rather than an empty column.
		const inRepo = renderCompLines(
			drawToolView(lineView(inspectImageToolView.renderCall({ path: "/repo/shots/error.png" }, COLLAPSED)), theme),
		);
		const inHome = renderCompLines(
			drawToolView(
				lineView(inspectImageToolView.renderCall({ path: `${homedir()}/shots/error.png` }, COLLAPSED)),
				theme,
			),
		);
		expect(stripVTControlCharacters(inRepo.join(""))).toContain("Inspect: /repo/shots/error.png");
		expect(stripVTControlCharacters(inHome.join(""))).toContain("Inspect: ~/shots/error.png");
	});

	it("exception cell: the question under a call row opens no empty colour runs", () => {
		const question = "What error text is visible?";
		const drawn = renderCompLines(drawToolView(inspectImageToolView.renderCall(args, COLLAPSED), theme));
		const oracle = renderCompLines(
			inspectImageOracle.inspectImageToolRenderer.renderCall(args, HOST_COLLAPSED, theme),
		);
		const asked = `${theme.fg("dim", "Question:")} ${theme.fg("accent", question)}`;
		const emptyRuns = `${theme.fg("muted", "")}${theme.fg("accent", "")}${theme.fg("muted", "")}`;
		// Main built the two rows as one `Text`, whose wrapping closed the colours the header above had
		// opened, leaving three zero-width runs between the indent and the question. The host emits a
		// run only for a span with something in it, so the question draws in the same colours with
		// fewer bytes.
		expect(drawn[1]).toBe(`  ${asked}`);
		expect(oracle[1]).toBe(`  ${emptyRuns}${asked}`);
		expect(stripVTControlCharacters(drawn[1] ?? "")).toBe(stripVTControlCharacters(oracle[1] ?? ""));
		expect(drawn[0]).toBe(oracle[0]);
	});

	it("fills the panel main filled, row for row, at every width and disclosure", () => {
		const results: InspectImageViewResult[] = [
			answered,
			{ content: [{ type: "text", text: "one line" }], details },
			// More lines than either window shows, which is the held-back note in both states.
			{
				content: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n") }],
				details,
			},
			// A tab and a line past the column budget, which the card de-tabs and cuts at 120 columns.
			{ content: [{ type: "text", text: `col\tumn\n${"x".repeat(200)}` }], details },
			// Trailing blank lines the model ended on, which neither card frames.
			{ content: [{ type: "text", text: "answer\n\n\n" }], details },
			// The answer with nothing said about how it was produced.
			{ content: [{ type: "text", text: "answer" }] },
		];
		for (const result of results) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLines(result, context, args, width);
					const oracle = oracleLines(result, options, args, width);
					// Every row below the header, byte for byte, once the rail carries the colour main
					// asked for: the answer, the question above it, the blank row between them, the cut
					// at 120 columns and the note saying what was held back.
					expect(drawn.slice(1).map(onMainsRail)).toEqual(oracle.slice(1));
					// The header differs by the separator between the row and its metadata alone, which is
					// pinned in its own cell.
					expect(stripVTControlCharacters(drawn[0] ?? "").replaceAll(" · ", " ")).toBe(
						stripVTControlCharacters(oracle[0] ?? "").replaceAll(" · ", " "),
					);
				}
			}
		}
		// Anti-vacuity: the rows compared above are the model's answer and the question that led to
		// it, and the windows are the four rows a collapsed card shows and the sixteen an expanded one
		// shows, not a frame with nothing in it.
		const long: InspectImageViewResult = {
			content: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n") }],
			details,
		};
		const collapsed = viewLines(long, COLLAPSED).map(line => stripVTControlCharacters(line));
		const expanded = viewLines(long, EXPANDED).map(line => stripVTControlCharacters(line));
		expect(collapsed.filter(line => /line \d+$/u.test(line))).toHaveLength(4);
		expect(expanded.filter(line => /line \d+$/u.test(line))).toHaveLength(16);
		expect(collapsed.at(-1)).toContain("… 20 more lines");
		expect(expanded.at(-1)).toContain("… 8 more lines");
		const asked = viewLines(answered, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(asked.some(line => line.includes("Question: What error text is visible?"))).toBe(true);
	});

	it("exception cell: the panel states the outcome on its rail where main kept the legacy muted edge", () => {
		// Vacuity guard: on a theme where the two colours resolve to the same bytes this cell would
		// pass without comparing anything.
		expect(theme.getColorHex("dim")).not.toBe(theme.getColorHex("borderMuted"));
		const drawn = viewLines(answered, COLLAPSED);
		const oracle = oracleLines(answered, HOST_COLLAPSED);
		// A settled card of fetched data now says so on the rail, in the colour every framed view uses
		// for a success, where main asked for the muted edge by hand. The row count and every other
		// byte are unchanged.
		expect(drawn.every(line => line.startsWith(theme.fg("dim", rail())))).toBe(true);
		expect(oracle.every(line => line.startsWith(theme.fg("borderMuted", rail())))).toBe(true);
		expect(drawn).toHaveLength(oracle.length);
		// The failing card is the control: its rail states the failure in both arms, so the outcome
		// moved onto the rail for a success and nothing else changed.
		const failed: InspectImageViewResult = {
			content: [{ type: "text", text: "no such file" }],
			details,
			isError: true,
		};
		expect(viewLines(failed, COLLAPSED).every(line => line.startsWith(theme.fg("error", rail())))).toBe(true);
		expect(oracleLines(failed, HOST_COLLAPSED).every(line => line.startsWith(theme.fg("error", rail())))).toBe(true);
	});

	it("exception cell: the header carries the model and the type as the row's own metadata", () => {
		const title = inspectTitle("/repo/shots/error.png");
		const meta = theme.fg("dim", `openai/gpt-4o${theme.sep.dot}image/png`);
		// Main joined the header and its metadata with an unstyled dot; the host appends the row's
		// metadata the way it appends every other row's, which is a space and the same dim run. The
		// words, their colours and their order are the ones main drew.
		expect(viewLines(answered, COLLAPSED)[0]).toBe(`${theme.fg("dim", rail())} ${title} ${meta}`);
		expect(oracleLines(answered, HOST_COLLAPSED)[0]).toBe(
			`${theme.fg("borderMuted", rail())} ${title}${theme.sep.dot}${meta}`,
		);
	});

	it("exception cell: a card with no answer keeps the model and the type on its row", () => {
		const empty: InspectImageViewResult = { content: [], details };
		const title = inspectTitle("/repo/shots/error.png");
		const meta = theme.fg("dim", `openai/gpt-4o${theme.sep.dot}image/png`);
		// Nothing to frame in either arm. Main hung the model and the type on a second row of their
		// own, at column zero, under a row that had already said what was inspected; the row carries
		// them itself, which is where every other converted card puts the same detail.
		expect(viewLines(empty, COLLAPSED)).toEqual([`${title} ${meta}`]);
		expect(oracleLines(empty, HOST_COLLAPSED)).toEqual([
			title,
			`${theme.fg("accent", "")}${theme.fg("muted", "")}${meta}`,
		]);
		// A card told nothing about the request is one row in both arms, so the second row above is
		// the metadata and not a blank the frame left behind.
		const bare: InspectImageViewResult = { content: [] };
		expect(viewLines(bare, COLLAPSED)).toEqual(oracleLines(bare, HOST_COLLAPSED));
		expect(stripVTControlCharacters(viewLines(bare, COLLAPSED).join(""))).toBe("Inspect: /repo/shots/error.png");
	});

	it("draws the failure card main drew, sanitising the same text, at every width and disclosure", () => {
		const failures: InspectImageViewResult[] = [
			{ content: [{ type: "text", text: "no such file" }], details, isError: true },
			// The prefix and the padding the shared sanitiser strips.
			{ content: [{ type: "text", text: "Error:   the model refused\t" }], details, isError: true },
			// A home path in the message, which is shortened before it reaches the card.
			{
				content: [{ type: "text", text: `cannot read ${homedir()}/shots/error.png` }],
				details,
				isError: true,
			},
			// Past the line budget, which is cut rather than wrapped into the frame.
			{ content: [{ type: "text", text: "x".repeat(TRUNCATE_LENGTHS.LINE + 40) }], details, isError: true },
			// A failure that said nothing, which both cards fall back to wording themselves.
			{ content: [], details, isError: true },
			// A failure before the request was described at all.
			{ content: [{ type: "text", text: "no such file" }], isError: true },
		];
		for (const result of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					expect(viewLines(result, context, args, width)).toEqual(oracleLines(result, options, args, width));
				}
			}
		}
		// Anti-vacuity: the cards compared above carry the failure text, shortened and cut, under a
		// header that names the image.
		const homePath = viewLines(failures[2]!, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(homePath.some(line => line.includes("cannot read ~/shots/error.png"))).toBe(true);
		expect(homePath.some(line => line.includes(homedir()))).toBe(false);
		const silent = viewLines(failures[4]!, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(silent.some(line => line.includes("inspection failed"))).toBe(true);
	});
});

describe("search_tool_bm25 tool differential", () => {
	/** A ranked match, with the server name on every other row so both meta shapes are drawn. */
	function match(index: number): SearchToolBm25Match {
		return {
			name: `tool_${index}`,
			label: `tool ${index}`,
			description: `what tool ${index} does`,
			...(index % 2 === 0 ? { server_name: "local" } : {}),
			schema_keys: ["a"],
			score: 1 - index / 10,
		};
	}

	function details(count: number, overrides: Partial<SearchToolBm25Details> = {}): SearchToolBm25Details {
		return {
			query: "keep track of what is left",
			limit: 8,
			total_tools: 41,
			activated_tools: ["todo"],
			also_matched: [],
			active_selected_tools: ["read", "bash"],
			tools: Array.from({ length: count }, (_, index) => match(index)),
			...overrides,
		};
	}

	function found(count: number, overrides: Partial<SearchToolBm25Details> = {}): SearchToolBm25ViewResult {
		return { content: [{ type: "text", text: "{}" }], details: details(count, overrides) };
	}

	function viewLines(result: SearchToolBm25ViewResult, context: ToolViewContext, width = WIDTH): string[] {
		return renderCompLines(drawToolView(searchToolBm25ToolView.renderResult(result, context), theme), width);
	}

	function oracleLines(result: SearchToolBm25ViewResult, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(searchToolBm25Oracle.searchToolBm25Renderer.renderResult(result, options, theme), width);
	}

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: SearchToolBm25Params[] = [
			{ query: "todo" },
			{ query: "todo", limit: 3 },
			{ query: "   " },
			{ query: "" },
			{ query: "tab\tseparated words" },
			{ query: "x".repeat(200), limit: 40 },
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(searchToolBm25ToolView.renderCall(args, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						searchToolBm25Oracle.searchToolBm25Renderer.renderCall(args, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the rows compared above carry the query, the limit when one was asked for, and
		// the words a card with no query falls back to.
		const asked = stripVTControlCharacters(
			renderCompLines(
				drawToolView(lineView(searchToolBm25ToolView.renderCall({ query: "todo", limit: 3 }, COLLAPSED)), theme),
			).join(""),
		);
		expect(asked).toContain("Tool Discovery: todo");
		expect(asked).toContain("limit:3");
		const blank = renderCompLines(
			drawToolView(lineView(searchToolBm25ToolView.renderCall({ query: "   " }, COLLAPSED)), theme),
		).join("");
		expect(stripVTControlCharacters(blank)).toContain("(empty query)");
	});

	it("heads the settled card with the row main headed it with, and frames it the same way", () => {
		for (const count of [1, 2, 5, 7, 12]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLines(found(count), context, width);
					const oracle = oracleLines(found(count), options, width);
					expect(drawn[0]).toBe(oracle[0]);
					// The frame is the one main asked for by hand: a muted edge on every row and no plate
					// behind the body, which is what a listing draws.
					const edge = theme.fg("borderMuted", theme.symbol("block.rail"));
					expect(drawn.every(line => line.startsWith(edge))).toBe(true);
					expect(oracle.every(line => line.startsWith(edge))).toBe(true);
				}
			}
		}
		// Anti-vacuity: the header compared above states the query, the match count and the inventory
		// it searched, rather than a bare tool name.
		const header = stripVTControlCharacters(viewLines(found(7), COLLAPSED)[0] ?? "");
		expect(header).toContain("Tool Discovery: keep track of what is left");
		expect(header).toContain("7 matches");
		expect(header).toContain("41 total");
	});

	it("shows every match main showed, with the same words, scores and cuts", () => {
		const long: SearchToolBm25Details = details(3, {
			tools: [
				{
					name: "verbose",
					label: "l".repeat(120),
					description: "d".repeat(200),
					server_name: "remote",
					schema_keys: [],
					score: 0.5,
				},
				{ name: "tabbed", label: "ta\tbbed", description: "sum\tmary", schema_keys: [], score: 0.25 },
				{ name: "silent", label: "silent", description: "   ", schema_keys: [], score: 0 },
			],
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			const drawn = viewLines({ content: [], details: long }, context, 200).map(line =>
				stripVTControlCharacters(line),
			);
			const oracle = oracleLines({ content: [], details: long }, options, 200).map(line =>
				stripVTControlCharacters(line),
			);
			const words = (lines: string[]): string =>
				lines
					.join(" ")
					.replaceAll(/[▏•│├└─\s]+/gu, " ")
					.replaceAll(" · ", " ")
					.trim();
			// Same labels, same server, same three-decimal scores, same summaries, cut at the same two
			// budgets: only the rows they sit on differ, which the exception cells below pin.
			expect(words(drawn)).toBe(words(oracle));
			const label = truncateToWidth("l".repeat(120), 72);
			const summary = truncateToWidth("d".repeat(200), 96);
			expect(words(drawn)).toContain(`${label} remote score 0.500 ${summary}`);
			expect(words(drawn)).toContain("ta bbed score 0.250 sum mary");
			// A match whose summary is blank contributes no summary to either arm.
			expect(words(drawn)).toContain("silent score 0.000");
			expect(words(drawn)).not.toContain("silent score 0.000  ");
		}
	});

	it("exception cell: the matches are a list the host marks, one row per tool", () => {
		const drawn = viewLines(found(2), COLLAPSED);
		const oracle = oracleLines(found(2), HOST_COLLAPSED);
		const edge = `${theme.fg("borderMuted", theme.symbol("block.rail"))} `;
		// The host marks each item with a branch and lays the summary out on the row; main drew a dim
		// bullet and indented the summary onto a row of its own, and wrote the separator between the
		// server and the score itself.
		expect(drawn.slice(1)).toEqual([
			`${edge} ${theme.fg("dim", theme.tree.branch)} ${theme.fg("accent", "tool 0")}${theme.fg("muted", " local")}${theme.fg("dim", " score 1.000")}${theme.fg("muted", " what tool 0 does")}`,
			`${edge} ${theme.fg("dim", theme.tree.last)} ${theme.fg("accent", "tool 1")}${theme.fg("dim", " score 0.900")}${theme.fg("muted", " what tool 1 does")}`,
		]);
		expect(oracle.slice(1)).toEqual([
			`${edge} ${theme.fg("dim", theme.format.bullet)} ${theme.fg("accent", "tool 0")} ${theme.fg("muted", "local")}${theme.fg("dim", theme.sep.dot)}${theme.fg("dim", "score 1.000")}`,
			`${edge}   ${theme.fg("muted", "what tool 0 does")}`,
			`${edge} ${theme.fg("dim", theme.format.bullet)} ${theme.fg("accent", "tool 1")} ${theme.fg("dim", "score 0.900")}`,
			`${edge}   ${theme.fg("muted", "what tool 1 does")}`,
		]);
	});

	it("exception cell: the held-back count closes the list and leaves the gesture to the host", () => {
		const collapsed = viewLines(found(7), COLLAPSED);
		const oracle = oracleLines(found(7), HOST_COLLAPSED);
		const edge = `${theme.fg("borderMuted", theme.symbol("block.rail"))} `;
		// Five of seven in both arms, and the same count held back. Main wrote the count and the
		// expand hint into a row of its own; the host writes the count on the branch that closes the
		// list, and offers the gesture the way it offers every other card's.
		expect(collapsed).toHaveLength(7);
		expect(oracle).toHaveLength(12);
		expect(collapsed.at(-1)).toBe(
			`${edge} ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "… 2 more tools")}`,
		);
		expect(oracle.at(-1)).toBe(
			`${edge} ${theme.fg("muted", "… 2 more tools")} ${formatExpandHint(theme, false, true)}`,
		);
		// Expanded, neither arm holds anything back, so the list closes on its last match instead.
		const expanded = viewLines(found(7), EXPANDED).map(line => stripVTControlCharacters(line));
		expect(expanded.filter(line => /tool \d+ /u.test(line))).toHaveLength(7);
		expect(expanded.some(line => line.includes("more tools"))).toBe(false);
		expect(oracleLines(found(7), HOST_EXPANDED).some(line => line.includes("more tools"))).toBe(false);
	});

	it("exception cell: a card with no matches indents its message under a header the host cuts", () => {
		for (const [total, message] of [
			[41, "No matching tools found."],
			[0, "No discoverable tools are currently loaded."],
		] as const) {
			const empty = found(0, { total_tools: total });
			const drawn = viewLines(empty, COLLAPSED);
			const oracle = oracleLines(empty, HOST_COLLAPSED);
			// Same warning row and the same sentence in both arms. Main opened a plain text block, so
			// the header wrapped onto a second row and the message started in column zero behind the
			// zero-width runs the wrap had closed; the host cuts the header to the width it has and
			// indents the message under it.
			expect(drawn).toHaveLength(2);
			expect(drawn[1]).toBe(`  ${theme.fg("muted", message)}`);
			expect(oracle).toHaveLength(3);
			expect(stripVTControlCharacters(oracle[2] ?? "")).toBe(message);
			// Given room for the whole row, both arms head the card with the same bytes; at eighty
			// columns main wrapped that row and the host cuts it, which is the difference this pins.
			expect(viewLines(empty, COLLAPSED, 400)[0]).toBe(oracleLines(empty, HOST_COLLAPSED, 400)[0]);
			expect(stripVTControlCharacters(drawn[0] ?? "")).toHaveLength(WIDTH);
		}
	});

	it("exception cell: a card with no details reports the text main reported, indented", () => {
		const cases: Array<{ result: SearchToolBm25ViewResult; text: string }> = [
			{ result: { content: [{ type: "text", text: "discovery off" }] }, text: "discovery off" },
			{ result: { content: [] }, text: "Tool discovery completed" },
			{ result: { content: [{ type: "image" }] }, text: "Tool discovery completed" },
			{
				result: { content: [{ type: "text", text: "x".repeat(TRUNCATE_LENGTHS.LINE + 40) }], isError: true },
				text: truncateToWidth("x".repeat(TRUNCATE_LENGTHS.LINE + 40), TRUNCATE_LENGTHS.LINE),
			},
		];
		for (const { result, text } of cases) {
			const drawn = viewLines(result, COLLAPSED, 400);
			const oracle = oracleLines(result, HOST_COLLAPSED, 400);
			expect(drawn[0]).toBe(oracle[0]);
			expect(drawn[1]).toBe(`  ${theme.fg("dim", text)}`);
			expect(stripVTControlCharacters(oracle[1] ?? "")).toBe(text);
		}
		// A multi-line report keeps every line in both arms, each cut at the same budget.
		const many: SearchToolBm25ViewResult = { content: [{ type: "text", text: "first\nsecond\nthird" }] };
		expect(viewLines(many, COLLAPSED, 400).map(line => stripVTControlCharacters(line).trim())).toEqual([
			"! Tool Discovery",
			"first",
			"second",
			"third",
		]);
		expect(oracleLines(many, HOST_COLLAPSED, 400).map(line => stripVTControlCharacters(line).trim())).toEqual([
			"! Tool Discovery",
			"first",
			"second",
			"third",
		]);
	});
});

describe("ast_edit tool differential", () => {
	/**
	 * One file's frame the way the tool writes it: one `formatCodeFrameLine` row per side of the
	 * change, whose marker rides in the gutter the card swaps for a space, which is what decides the
	 * tone of the row. A one-column line number keeps the marker in column zero, as the tool's own
	 * gutter does for a single-digit line.
	 */
	function frame(start: number): string[] {
		return [
			formatCodeFrameLine("-", start, `const before = foo(${start});`, 1),
			formatCodeFrameLine("+", start, `const after = bar(${start});`, 1),
		];
	}

	/**
	 * The display half of the tool's own grouped output for `files`, built by the formatter the tool
	 * builds it with, so the fixture cannot drift from the shape a card splits on: a `#` per nesting
	 * level, and a blank row before every directory header, which is the only place a change group
	 * ends. Trailing notices follow the body after a blank row, where the tool appends them.
	 */
	function grouped(files: string[], notices: string[] = []): string {
		const body = formatGroupedFiles(files, file => {
			const lines = frame(files.indexOf(file) + 1);
			return { headerSuffix: " (1)", modelLines: lines, displayLines: lines };
		}).display;
		return notices.length === 0 ? body.join("\n") : [...body, "", ...notices].join("\n");
	}

	/** `files` files under one `src/` directory: one directory header, one group, nothing held back. */
	function display(files: number, notices: string[] = []): string {
		return grouped(
			Array.from({ length: files }, (_unused, index) => `src/file-${index}.ts`),
			notices,
		);
	}

	/** `count` directories of `filesPer` files: the card splits this into `count` change groups. */
	function dirs(count: number, filesPer: number): string {
		return grouped(
			Array.from({ length: count }, (_unused, dir) =>
				Array.from({ length: filesPer }, (_ignored, file) => `pkg-${dir}/file-${file}.ts`),
			).flat(),
		);
	}

	function details(overrides: Partial<AstEditToolDetails> = {}): AstEditToolDetails {
		return {
			totalReplacements: 4,
			filesTouched: 2,
			filesSearched: 37,
			applied: false,
			limitReached: false,
			scopePath: "src",
			cwd: "/repo",
			searchPath: "/repo/src",
			displayContent: display(2),
			...overrides,
		};
	}

	function result(overrides: Partial<AstEditToolDetails> = {}): AstEditViewResult {
		return { content: [{ type: "text", text: "model facing" }], details: details(overrides) };
	}

	const ARGS: AstEditViewArgs = { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src"] };

	function viewLines(
		value: AstEditViewResult,
		context: ToolViewContext,
		width = WIDTH,
		args: AstEditViewArgs | undefined = ARGS,
	): string[] {
		return renderCompLines(drawToolView(astEditToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: AstEditViewResult,
		options: RenderResultOptions,
		width = WIDTH,
		args: AstEditViewArgs | undefined = ARGS,
	): string[] {
		return renderCompLines(astEditOracle.astEditToolRenderer.renderResult(value, options, theme, args), width);
	}

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: AstEditViewArgs[] = [
			{ ops: [{ pat: "foo($A)", out: "bar($A)" }] },
			{ ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src", "test"] },
			{
				ops: [
					{ pat: "a()", out: "b()" },
					{ pat: "c()", out: "d()" },
				],
				paths: ["src"],
			},
			// A pattern is source text: multi-line and tab-indented, which the row collapses.
			{ ops: [{ pat: "class $_ {\n\tmethod() { $$$B }\n}", out: "x" }] },
			{ ops: [] },
			{},
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(astEditToolView.renderCall(args, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						astEditOracle.astEditToolRenderer.renderCall(args, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the rows compared above carry the pattern with its whitespace collapsed, the
		// scope, and the rewrite count when more than one op was sent.
		const one = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(astEditToolView.renderCall(ARGS, COLLAPSED)), theme), 200).join(""),
		);
		expect(one).toContain("AST Edit: foo($A)");
		expect(one).toContain("in src");
		const many = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(
						astEditToolView.renderCall(
							{
								ops: [
									{ pat: "a()", out: "b()" },
									{ pat: "c()", out: "d()" },
								],
							},
							COLLAPSED,
						),
					),
					theme,
				),
				200,
			).join(""),
		);
		expect(many).toContain("2 rewrites");
		const folded = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(astEditToolView.renderCall({ ops: [{ pat: "class $_ {\n\tm() { $$$B }\n}" }] }, COLLAPSED)),
					theme,
				),
				200,
			).join(""),
		);
		expect(folded).toContain("class $_ { m() { $$$B } }");
		expect(folded).not.toContain("\t");
	});

	it("draws the settled card byte for byte wherever it holds nothing back", () => {
		const cases: Array<Partial<AstEditToolDetails>> = [
			// One group, so a collapsed card shows it whole and keeps nothing back.
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1) },
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1), limitReached: true },
			{ totalReplacements: 2, filesTouched: 1, displayContent: display(1), scopePath: undefined },
			{
				totalReplacements: 2,
				filesTouched: 1,
				displayContent: display(1),
				parseErrors: ["a.ts: unexpected token"],
				parseErrorsTotal: 1,
			},
			{ totalReplacements: 1, filesTouched: 1, displayContent: display(1), filesSearched: 0 },
			// A directory header at the scope's own depth, which the card tones and links as a
			// directory rather than as a file.
			{
				totalReplacements: 2,
				filesTouched: 1,
				displayContent: grouped(["deep/nested/leaf.ts"]),
			},
		];
		for (const overrides of cases) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(viewLines(result(overrides), context, width)).toEqual(
						oracleLines(result(overrides), options, width),
					);
				}
			}
		}
		// Every group of a many-group card is byte-identical once expanded, which is where nothing is
		// held back and the whole body is compared.
		for (const width of [200, WIDTH, 40]) {
			const many = result({ displayContent: dirs(9, 1), totalReplacements: 18, filesTouched: 9 });
			expect(viewLines(many, EXPANDED, width)).toEqual(oracleLines(many, HOST_EXPANDED, width));
		}
		// Anti-vacuity: the compared card carries the header's counts and badge, the edited text with
		// its diff markers, and the file header as a hyperlink resolved against the edit's base.
		const drawn = viewLines(result(), EXPANDED, 200);
		const header = stripVTControlCharacters(drawn[0] ?? "");
		expect(header).toContain("AST Edit: foo($A)");
		expect(header).toContain("4 replacements");
		expect(header).toContain("2 files");
		expect(header).toContain("in src");
		expect(header).toContain("searched 37");
		expect(header).toContain("proposed");
		expect(header).not.toContain("limit reached");
		const body = drawn.join("\n");
		expect(stripVTControlCharacters(body)).toContain("-1 const before = foo(1);");
		expect(stripVTControlCharacters(body)).toContain("+1 const after = bar(1);");
		// The file header names the file the change came from, toned as a header below the scope root,
		// and its span carries the resolved path so a host that can open a file has one.
		expect(body).toContain(theme.fg("dim", "## file-0.ts (1)"));
		expect(body).toContain(theme.fg("accent", "# src/"));
		const view = framedView(astEditToolView.renderResult(result(), EXPANDED, ARGS));
		const files = view.sections
			.flatMap(section => section.lines)
			.flatMap(line => line.map(span => span.file))
			.filter((file): file is string => file !== undefined);
		expect(files).toContain("/repo/src/file-0.ts");
		expect(files).toContain("/repo/src");
		// The cap rides on the header only when it was reached, in both arms alike.
		const capped = result({ totalReplacements: 2, filesTouched: 1, displayContent: display(1), limitReached: true });
		expect(stripVTControlCharacters(viewLines(capped, COLLAPSED, 200)[0] ?? "")).toContain("limit reached");
	});

	it("says beside the changes what main said: the cap it hit and what would not parse", () => {
		const value = result({
			totalReplacements: 2,
			filesTouched: 1,
			displayContent: display(1),
			limitReached: true,
			parseErrors: ["a.ts: unexpected token", "b.ts: unexpected token"],
			parseErrorsTotal: 5,
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			expect(viewLines(value, context, 200)).toEqual(oracleLines(value, options, 200));
		}
		// Anti-vacuity: the two asides are there, in the warning tone, below the change lines rather
		// than instead of them.
		const lines = viewLines(value, EXPANDED, 200).map(line => stripVTControlCharacters(line));
		expect(lines.filter(line => line.includes("limit reached; narrow path"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("5 parse issues"))).toHaveLength(1);
		expect(lines.some(line => line.includes("-1 const before = foo(1);"))).toBe(true);
		expect(viewLines(value, EXPANDED, 200).at(-1)).toContain(theme.fg("warning", "5 parse issues"));
	});

	it("drops the trailing notices the tool wrote, in both arms", () => {
		const value = result({
			totalReplacements: 2,
			filesTouched: 1,
			displayContent: display(1, ["Safety cap reached: narrow the path", "Parse issues: 2 files"]),
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			const drawn = viewLines(value, context, 200);
			expect(drawn).toEqual(oracleLines(value, options, 200));
			// Neither arm lists the tool's own trailing notices as a change group, and the change it
			// does list is still there, so the filter is not simply dropping everything.
			const flat = stripVTControlCharacters(drawn.join("\n"));
			expect(flat).not.toContain("Safety cap reached");
			expect(flat).not.toContain("Parse issues: 2 files");
			expect(flat).toContain("## file-0.ts (1)");
			expect(flat).toContain("-1 const before = foo(1);");
		}
	});

	it("reports a result that replaced nothing as the row main reported, framing only parse issues", () => {
		const none: Partial<AstEditToolDetails> = { totalReplacements: 0, filesTouched: 0, displayContent: "" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [WIDTH, 200, 40]) {
				// No parse issues: a lone row in both arms, not a frame around nothing.
				expect(viewLines(result(none), context, width)).toEqual(oracleLines(result(none), options, width));
				// Parse issues: the same bulleted list under the same warning row, capped and counted
				// identically.
				const withErrors = result({
					...none,
					parseErrors: Array.from({ length: 6 }, (_, index) => `file-${index}.ts: unexpected token`),
					parseErrorsTotal: 11,
				});
				expect(viewLines(withErrors, context, width)).toEqual(oracleLines(withErrors, options, width));
				// More issues than the cap: both arms list PARSE_ERRORS_LIMIT of them and count the
				// rest, so a card that stopped capping would draw rows main never drew.
				const overCap = result({
					...none,
					parseErrors: Array.from({ length: PARSE_ERRORS_LIMIT + 2 }, (_, index) => `file-${index}.ts: bad`),
					parseErrorsTotal: PARSE_ERRORS_LIMIT + 9,
				});
				expect(viewLines(overCap, context, width)).toEqual(oracleLines(overCap, options, width));
			}
		}
		// A row is a row: the arm with no parse issues draws one line and opens no frame at all.
		expect(viewLines(result(none), COLLAPSED, 200)).toHaveLength(1);
		// Anti-vacuity: the row says nothing was replaced and how much was searched, and the framed
		// arm lists the capped errors and the count it held back.
		const row = stripVTControlCharacters(viewLines(result(none), COLLAPSED, 200).join("\n"));
		expect(row).toContain("0 replacements");
		expect(row).toContain("searched 37");
		const framed = stripVTControlCharacters(
			viewLines(
				result({ ...none, parseErrors: ["a.ts: bad", "b.ts: bad"], parseErrorsTotal: 7 }),
				COLLAPSED,
				200,
			).join("\n"),
		);
		expect(framed).toContain("- a.ts: bad");
		expect(framed).toContain("… 5 more");
		const capped = stripVTControlCharacters(
			viewLines(
				result({
					...none,
					parseErrors: Array.from({ length: PARSE_ERRORS_LIMIT + 2 }, (_, index) => `file-${index}.ts: bad`),
					parseErrorsTotal: PARSE_ERRORS_LIMIT + 2,
				}),
				COLLAPSED,
				200,
			).join("\n"),
		);
		expect(capped.split("\n").filter(line => line.includes(": bad"))).toHaveLength(PARSE_ERRORS_LIMIT);
		expect(capped).toContain("… 2 more");
	});

	it("exception cell: the held-back groups close the card the way the host closes every card", () => {
		// Nine directories, so the card has nine groups to budget and holds most of them back.
		const value = result({ displayContent: dirs(9, 1), totalReplacements: 18, filesTouched: 9 });
		for (const width of [200, WIDTH, 40]) {
			const drawn = viewLines(value, COLLAPSED, width);
			const oracle = oracleLines(value, HOST_COLLAPSED, width);
			// Same rows, same groups shown, same count held back: the sentence on the last row is the
			// only difference. Main wrote it in muted with no gesture; the host writes it in dim and
			// offers the expand hint every other card offers.
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 8 more changes"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(oracle.at(-1)).toContain(theme.fg("muted", "… 8 more changes"));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// Two groups, the budget fitting one: the second is held back and worded singular.
		const pair = result({ displayContent: dirs(2, 1), totalReplacements: 4, filesTouched: 2 });
		expect(viewLines(pair, COLLAPSED, 200).at(-1)).toContain(theme.fg("dim", "… 1 more change"));
		expect(oracleLines(pair, HOST_COLLAPSED, 200).at(-1)).toContain(theme.fg("muted", "… 1 more change"));
		// The row the note reserves cannot change what a card shows at the current budget: the
		// smallest group the tool writes is a root-level file header and the two sides of one change,
		// so a second group costs 3 + 1 + 3 rows and overruns COLLAPSED_CHANGE_LIMIT whether or not
		// the note's row is reserved. Raising the budget makes that arithmetic reachable and this
		// suite blind to it, which is what this assertion goes red for.
		expect(PREVIEW_LIMITS.COLLAPSED_LINES * 2).toBeLessThan(3 + 1 + 3);
		// Expanded, neither arm holds anything back and neither writes the sentence.
		expect(stripVTControlCharacters(viewLines(value, EXPANDED, 200).join("\n"))).not.toContain("more changes");
		expect(stripVTControlCharacters(oracleLines(value, HOST_EXPANDED, 200).join("\n"))).not.toContain("more changes");
	});

	it("exception cell: an error card tones every line, where main coloured the block once", () => {
		// One line is the case the string form got right, so that arm is byte-identical.
		for (const width of [200, WIDTH, 40]) {
			const single: AstEditViewResult = {
				content: [{ type: "text", text: "pattern did not parse" }],
				isError: true,
			};
			expect(viewLines(single, COLLAPSED, width)).toEqual(oracleLines(single, HOST_COLLAPSED, width));
		}
		const many: AstEditViewResult = { content: [{ type: "text", text: "first\nsecond" }], isError: true };
		const drawn = viewLines(many, COLLAPSED, 200);
		const oracle = oracleLines(many, HOST_COLLAPSED, 200);
		// Main coloured the whole message and split the coloured string, so the run opened on the
		// first row and closed on the last: the first row ends INSIDE the colour, and the second row
		// starts inside it, without the two-column indent, and closes a run it never opened. Each row
		// here opens and closes its own run and carries its own indent.
		expect(drawn[1]).toContain(`${theme.fg("error", "first")} `);
		expect(oracle[1]).not.toContain(theme.fg("error", "first"));
		expect(drawn[2]).toContain(`  ${theme.fg("error", "second")}`);
		expect(stripVTControlCharacters(oracle[2] ?? "").trimEnd()).toBe(`${theme.symbol("block.rail")}  second`);
		expect(oracle[2]).not.toContain(theme.fg("error", "second"));
		// The same two sentences in the same order in both arms; the indent and the run boundaries are
		// the whole of the difference.
		const words = (lines: readonly string[]): string[] =>
			lines.map(line => stripVTControlCharacters(line).replace(theme.symbol("block.rail"), "").trim());
		expect(words(drawn)).toEqual(words(oracle));
		expect(stripVTControlCharacters(drawn[2] ?? "").trimEnd()).toBe(`${theme.symbol("block.rail")}    second`);
		// A failure with no text at all still names the failure in both arms, byte for byte.
		const bare: AstEditViewResult = { content: [], isError: true };
		expect(viewLines(bare, COLLAPSED, 200)).toEqual(oracleLines(bare, HOST_COLLAPSED, 200));
		expect(stripVTControlCharacters(viewLines(bare, COLLAPSED, 200).join("\n"))).toContain("Unknown error");
	});
});

describe("irc tool differential", () => {
	/** The rail glyph, read when a cell runs rather than when the file loads: the theme starts empty. */
	const rail = (): string => theme.symbol("block.rail");
	const TS_NOW = Date.now() - 30_000;

	/**
	 * A card with the block's own width padding removed.
	 *
	 * Every irc card states its direction in a word where main drew an arrow, so the longest row of
	 * the two arms differs by a column or two and the block pads every other row to match it. The
	 * padding sits between the content and the background reset, so `trimEnd` never reaches it. It is
	 * the host's layout rather than either renderer's bytes, so both arms are compared without it.
	 */
	function fitted(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +(\x1b\[49m)$/, "$1"));
	}

	/** Main coloured the rail from the block's state; a view takes the settled edge on every card but a failure. */
	function railAs(color: ThemeColor, lines: readonly string[]): string[] {
		return lines.map(line => line.replace(theme.fg("borderMuted", rail()), theme.fg(color, rail())));
	}

	/** Main drew the direction as an arrow inside the title's colour run; a view states it in words. */
	function arrows(lines: readonly string[]): string[] {
		return lines.map(line =>
			line.replace("IRC to ", `IRC ${theme.nav.selected} `).replace("IRC from ", `IRC ${theme.nav.back} `),
		);
	}

	/** The four marks a roster row opens with, each with the tone both arms draw it in. */
	const PEER_MARKS: ReadonlyArray<readonly [SymbolKey, ThemeColor]> = [
		["status.running", "accent"],
		["status.enabled", "success"],
		["status.shadowed", "muted"],
		["status.aborted", "error"],
	];

	/**
	 * A roster row whose mark and status word share one colour run again.
	 *
	 * The host draws the mark from its own symbol table and the word from the tool's span, so the
	 * terminal closes the run after the glyph and opens an identical one for the word. Main wrote both
	 * into a single `theme.fg`, so undoing the split is dropping the reset that meets the reopen.
	 */
	function marks(lines: readonly string[]): string[] {
		return lines.map(line => {
			let out = line;
			for (const [key, color] of PEER_MARKS) {
				const glyph = theme.symbol(key);
				const styled = theme.styledSymbol(key, color);
				const open = styled.slice(0, styled.indexOf(glyph));
				const close = styled.slice(styled.indexOf(glyph) + glyph.length);
				out = out.split(`${glyph}${close}${open}`).join(glyph);
			}
			return out;
		});
	}

	/** Main joined a peer's kind to its parent with the terminal's own separator glyph; a view states two words. */
	function dots(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(" of ", `${theme.sep.dot}of `));
	}

	/** The view's bytes with the two host decisions above undone, which is what main drew. */
	function asMain(color: ThemeColor, lines: readonly string[]): string[] {
		return fitted(arrows(railAs(color, lines)));
	}

	function viewLines(value: IrcViewResult, context: ToolViewContext, args?: IrcViewArgs, width = WIDTH): string[] {
		return renderCompLines(drawToolView(ircToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: IrcViewResult,
		options: RenderResultOptions,
		args?: IrcViewArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(ircOracle.ircToolRenderer.renderResult(value, options, theme, args), width);
	}

	function message(overrides: Partial<IrcMessage> = {}): IrcMessage {
		return {
			id: "7181122334455667789",
			from: "AuthLoader",
			to: "Main",
			body: "session-store rename is merged.",
			ts: TS_NOW,
			...overrides,
		};
	}

	/** A roster row, read off the tool's own details rather than restated here. */
	type IrcPeer = NonNullable<IrcDetails["peers"]>[number];

	function peer(overrides: Partial<IrcPeer> = {}): IrcPeer {
		return {
			id: "AuthLoader",
			displayName: "task",
			kind: "sub",
			status: "running",
			parentId: "Main",
			unread: 0,
			lastActivity: TS_NOW,
			...overrides,
		};
	}

	function result(details: IrcDetails, overrides: Partial<IrcViewResult> = {}): IrcViewResult {
		return { content: [{ type: "text", text: "" }], details, ...overrides };
	}

	const SEND_ARGS: IrcViewArgs = {
		op: "send",
		to: "AuthLoader",
		message: "Are you done with auth.ts?",
		await: true,
	};

	it("draws the pending call row with the direction in words and the settled edge", () => {
		const calls: IrcViewArgs[] = [
			SEND_ARGS,
			{ op: "send", to: "all", message: "a\nb\nc", replyTo: "7181122334455667791" },
			{ op: "send" },
			{ op: "wait", from: "AuthLoader", timeoutMs: 120_000 },
			{ op: "wait" },
			{ op: "inbox", peek: true },
			{ op: "list" },
			{},
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(drawToolView(ircToolView.renderCall(args, context), theme), width);
					const oracle = renderCompLines(ircOracle.ircToolRenderer.renderCall(args, options, theme), width);
					// A pending call keeps main's accent rail once the host's settled edge is undone,
					// and every other byte of the row is main's, held-back note aside.
					const held = drawn.some(line => stripVTControlCharacters(line).includes("more line"));
					if (!held) expect(asMain("accent", drawn)).toEqual(fitted(oracle));
				}
			}
		}
		// Anti-vacuity: the row carries the peer, the direction and the call's own metadata, and a
		// send's message preview rides under it.
		const row = stripVTControlCharacters(
			renderCompLines(drawToolView(ircToolView.renderCall(SEND_ARGS, COLLAPSED), theme), 200).join("\n"),
		);
		expect(row).toContain("IRC to AuthLoader");
		expect(row).toContain("await reply");
		expect(row).toContain("Are you done with auth.ts?");
		const wait = stripVTControlCharacters(
			renderCompLines(
				drawToolView(ircToolView.renderCall({ op: "wait", timeoutMs: 120_000 }, COLLAPSED), theme),
				200,
			).join("\n"),
		);
		expect(wait).toContain("IRC from anyone");
		expect(wait).toContain("timeout 2m");
	});

	it("draws a settled send card byte for byte, rail and direction aside", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "revived" }],
			waited: message({ body: "go ahead, auth.ts is yours." }),
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH, 40]) {
				expect(asMain("dim", viewLines(value, context, SEND_ARGS, width))).toEqual(
					fitted(oracleLines(value, options, SEND_ARGS, width)),
				);
			}
		}
		// Anti-vacuity: the card carries the outcome on the row, the message that was sent, the peer
		// that answered and the answer itself.
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, SEND_ARGS, 200).join("\n"));
		expect(drawn).toContain("IRC to AuthLoader");
		expect(drawn).toContain("revived");
		expect(drawn).toContain("Are you done with auth.ts?");
		expect(drawn).toContain(`${theme.nav.back} AuthLoader`);
		expect(drawn).toContain("go ahead, auth.ts is yours.");
	});

	it("draws an awaited send that timed out the way main drew it, on the settled edge", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "injected" }],
			waited: null,
		});
		for (const width of [200, WIDTH, 40]) {
			// Main coloured the rail with the warning the plate already carries; the view leaves the
			// edge settled and states the outcome once, on the plate.
			expect(asMain("warning", viewLines(value, COLLAPSED, SEND_ARGS, width))).toEqual(
				fitted(oracleLines(value, HOST_COLLAPSED, SEND_ARGS, width)),
			);
		}
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, SEND_ARGS, 200).join("\n"));
		expect(drawn).toContain("no reply");
		expect(drawn).toContain("No reply yet");
		// The warning is on the plate in both arms, and only main also put it on the rail.
		expect(viewLines(value, COLLAPSED, SEND_ARGS, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		expect(oracleLines(value, HOST_COLLAPSED, SEND_ARGS, 200)[0]).toContain(theme.fg("warning", rail()));
	});

	it("draws a send that delivered nothing the way main drew it", () => {
		const failed = result(
			{ op: "send", from: "Main" },
			{ content: [{ type: "text", text: '`to` is required for op="send".' }], isError: true },
		);
		for (const width of [200, WIDTH, 40]) {
			// A failure keeps main's rail as well as its text: the error edge is the one the host
			// draws too, so these rows are identical without any normalisation but the direction.
			expect(fitted(arrows(viewLines(failed, COLLAPSED, { op: "send" }, width)))).toEqual(
				fitted(oracleLines(failed, HOST_COLLAPSED, { op: "send" }, width)),
			);
		}
		const empty = result(
			{ op: "send", from: "Main", to: "all" },
			{ content: [{ type: "text", text: "No peers to broadcast to." }] },
		);
		for (const width of [200, WIDTH, 40]) {
			expect(asMain("warning", viewLines(empty, COLLAPSED, { op: "send", to: "all" }, width))).toEqual(
				fitted(oracleLines(empty, HOST_COLLAPSED, { op: "send", to: "all" }, width)),
			);
		}
		expect(stripVTControlCharacters(viewLines(failed, COLLAPSED, { op: "send" }, 200).join("\n"))).toContain(
			'`to` is required for op="send".',
		);
		expect(
			stripVTControlCharacters(viewLines(empty, COLLAPSED, { op: "send", to: "all" }, 200).join("\n")),
		).toContain("No peers to broadcast to.");
	});

	it("draws every wait card the way main drew it, rail and direction aside", () => {
		const cases: Array<[IrcDetails, ThemeColor, ViewStatus, Partial<IrcViewResult>]> = [
			[{ op: "wait", from: "Main", waited: message() }, "dim", "success", {}],
			[{ op: "wait", from: "Main", waited: message({ replyTo: "7181122334455667791" }) }, "dim", "success", {}],
			[
				{ op: "wait", from: "Main", waited: null },
				"warning",
				"warning",
				{ content: [{ type: "text", text: "No message from AuthLoader within 2m." }] },
			],
		];
		for (const [details, rail, state, overrides] of cases) {
			// The outcome the card REPORTS is pinned on the view: a settled plate and a warning plate
			// draw the same rows here, so a card that reported the wrong one would say nothing to the
			// terminal and the wrong thing to every other host.
			expect(framedView(ircToolView.renderResult(result(details, overrides), COLLAPSED)).state).toBe(state);
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const value = result(details, overrides);
					expect(asMain(rail, viewLines(value, context, { op: "wait", from: "AuthLoader" }, width))).toEqual(
						fitted(oracleLines(value, options, { op: "wait", from: "AuthLoader" }, width)),
					);
				}
			}
		}
		const drawn = stripVTControlCharacters(
			viewLines(
				result({ op: "wait", from: "Main", waited: message({ replyTo: "1" }) }),
				COLLAPSED,
				{ op: "wait" },
				200,
			).join("\n"),
		);
		expect(drawn).toContain("IRC from AuthLoader");
		expect(drawn).toContain("reply");
		expect(drawn).toContain("session-store rename is merged.");
	});

	it("draws every inbox and peer card the way main drew it, rail and badges aside", () => {
		const inbox = result({
			op: "inbox",
			from: "Main",
			inbox: [
				message({ from: "AuthLoader", body: "bus landed." }),
				message({ from: "RateLimiter", body: "receipts carry outcome." }),
			],
		});
		const empty = result(
			{ op: "inbox", from: "Main", inbox: [] },
			{ content: [{ type: "text", text: "Inbox empty." }] },
		);
		// Peers with no parent, so the row carries no separator and the two arms are the same length at
		// every width.
		const peers = result({
			op: "list",
			from: "Main",
			peers: [
				peer({ id: "AuthLoader", parentId: undefined, activity: "auditing the token refresh path" }),
				peer({ id: "Solo", status: "idle", parentId: undefined }),
			],
		});
		const noPeers = result({ op: "list", from: "Main", peers: [] });
		for (const [value, args] of [
			[inbox, { op: "inbox", peek: true } as IrcViewArgs],
			[empty, { op: "inbox" } as IrcViewArgs],
			[peers, { op: "list" } as IrcViewArgs],
			[noPeers, { op: "list" } as IrcViewArgs],
		] as const) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(asMain("dim", marks(viewLines(value, context, args, width)))).toEqual(
						fitted(oracleLines(value, options, args, width)),
					);
				}
			}
		}
		// A peer WITH a parent is compared where neither arm wraps: the separator the host dropped
		// shortens the row by two columns, so a narrow terminal breaks the two arms at different words
		// and no normalisation of the drawn rows can undo that. The separator itself is the exception
		// cell below.
		const parented = result({
			op: "list",
			from: "Main",
			peers: [peer({ id: "AuthLoader", activity: "auditing the token refresh path" })],
		});
		expect(asMain("dim", marks(dots(viewLines(parented, COLLAPSED, { op: "list" }, 200))))).toEqual(
			fitted(oracleLines(parented, HOST_COLLAPSED, { op: "list" }, 200)),
		);
		// Anti-vacuity: the inbox lists each sender over its body, and a roster row carries the peer's
		// mark, its id, its role and what it is doing.
		const drawn = stripVTControlCharacters(viewLines(inbox, COLLAPSED, { op: "inbox", peek: true }, 200).join("\n"));
		expect(drawn).toContain("2 messages");
		expect(drawn).toContain("AuthLoader");
		expect(drawn).toContain("bus landed.");
		const roster = stripVTControlCharacters(viewLines(peers, COLLAPSED, { op: "list" }, 200).join("\n"));
		expect(roster).toContain(`${theme.status.running} running`);
		expect(roster).toContain("auditing the token refresh path");
		// The tool's own emblem and the outcome the card reports are pinned on the VIEW rather than on
		// its bytes: the terminal draws `tool.irc` as an empty run in a build without the glyph, and a
		// settled card's plate and its rail read the same as a warning's here, so a card that lost
		// either would draw the same rows and say something else to every other host.
		for (const [value, args] of [
			[inbox, { op: "inbox", peek: true } as IrcViewArgs],
			[empty, { op: "inbox" } as IrcViewArgs],
			[peers, { op: "list" } as IrcViewArgs],
		] as const) {
			const view = framedView(ircToolView.renderResult(value, COLLAPSED, args));
			expect(view.header.emblem).toBe("tool.irc");
			expect(view.state).toBe("success");
		}
		// A roster with no peers reports itself with the info mark instead, which is main's icon too.
		const none = framedView(ircToolView.renderResult(noPeers, COLLAPSED, { op: "list" }));
		expect(none.header.status).toBe("info");
		expect(none.header.emblem).toBeUndefined();
	});

	it("exception cell: a peer's kind and its parent are two words where main joined them with a dot", () => {
		const value = result({ op: "list", from: "Main", peers: [peer()] });
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, { op: "list" }, 200).join("\n"));
		const oracle = stripVTControlCharacters(oracleLines(value, HOST_COLLAPSED, { op: "list" }, 200).join("\n"));
		// The dot is the terminal's own separator glyph, which a tool cannot name: the row states the
		// two facts and the host spaces them.
		expect(drawn).toContain("sub of Main");
		expect(oracle).toContain(`sub${theme.sep.dot}of Main`);
		// A peer with no parent reads the same in both arms, so the difference is the separator alone.
		const solo = result({ op: "list", from: "Main", peers: [peer({ parentId: undefined })] });
		expect(asMain("dim", marks(viewLines(solo, COLLAPSED, { op: "list" }, 200)))).toEqual(
			fitted(oracleLines(solo, HOST_COLLAPSED, { op: "list" }, 200)),
		);
	});

	it("exception cell: a badge is the word in its tone, without the brackets main drew", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "all",
			receipts: [
				{ to: "AuthLoader", outcome: "woken" },
				{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' },
			],
		});
		const args: IrcViewArgs = { op: "send", to: "all", message: "heads up" };
		const drawn = viewLines(value, COLLAPSED, args, 200);
		const oracle = oracleLines(value, HOST_COLLAPSED, args, 200);
		expect(drawn).toHaveLength(oracle.length);
		// Same rows in the same order, and the same words in the same tones: the bracket pair and the
		// dash before a failure's reason are chrome the tool wrote and the host now owns.
		expect(stripVTControlCharacters(drawn[2] ?? "")).toContain("AuthLoader woken");
		expect(stripVTControlCharacters(oracle[2] ?? "")).toContain(
			`AuthLoader ${theme.format.bracketLeft}woken${theme.format.bracketRight}`,
		);
		expect(drawn[2]).toContain(theme.fg("success", "woken"));
		expect(drawn[3]).toContain(theme.fg("error", "failed"));
		expect(stripVTControlCharacters(drawn[3] ?? "")).toContain('failed unknown agent "RateLimiter"');
		expect(stripVTControlCharacters(oracle[3] ?? "")).toContain(
			`${theme.format.bracketRight} ${theme.format.dash} unknown agent "RateLimiter"`,
		);
		// The reason a delivery failed keeps the failure tone main gave it; only the dash is gone.
		expect(drawn[3]).toContain(theme.fg("error", 'unknown agent "RateLimiter"'));
		expect(oracle[3]).toContain(theme.fg("error", `${theme.format.dash} unknown agent "RateLimiter"`));
		// The unread badge on a roster row is the same decision.
		const unread = result({ op: "list", from: "Main", peers: [peer({ unread: 2, status: "parked" })] });
		const roster = viewLines(unread, COLLAPSED, { op: "list" }, 200);
		expect(roster.join("")).toContain(theme.fg("warning", "2 unread"));
		expect(stripVTControlCharacters(oracleLines(unread, HOST_COLLAPSED, { op: "list" }, 200).join(""))).toContain(
			`${theme.format.bracketLeft}2 unread${theme.format.bracketRight}`,
		);
	});

	it("exception cell: a peer's mark and its word are two runs where main painted one", () => {
		const value = result({ op: "list", from: "Main", peers: [peer({ status: "wedged", parentId: undefined })] });
		const drawn = viewLines(value, COLLAPSED, { op: "list" }, 200);
		const oracle = oracleLines(value, HOST_COLLAPSED, { op: "list" }, 200);
		// The mark comes from the host's symbol table and the word from the tool, so the terminal
		// restates the same colour on each; main wrote both into one run. An unknown status still
		// draws the aborted mark in the error tone in both arms.
		expect(drawn[1]).toContain(theme.styledSymbol("status.aborted", "error"));
		expect(drawn[1]).toContain(theme.fg("error", " wedged"));
		expect(oracle[1]).toContain(theme.fg("error", `${theme.status.aborted} wedged`));
		expect(stripVTControlCharacters(drawn[1] ?? "")).toEqual(stripVTControlCharacters(oracle[1] ?? ""));
	});

	it("exception cell: every hold-back is the host's sentence with the host's gesture", () => {
		// A body longer than the collapsed budget, in the card that shows one.
		const long = result({
			op: "wait",
			from: "Main",
			waited: message({ body: Array.from({ length: 6 }, (_unused, i) => `reply line ${i + 1}`).join("\n") }),
		});
		const drawnBody = viewLines(long, COLLAPSED, { op: "wait" }, 200);
		const oracleBody = oracleLines(long, HOST_COLLAPSED, { op: "wait" }, 200);
		expect(drawnBody).toHaveLength(oracleBody.length);
		expect(drawnBody.at(-1)).toContain(theme.fg("dim", "… 4 more lines"));
		expect(drawnBody.at(-1)).toContain(formatExpandHint(theme, false, true));
		expect(oracleBody.at(-1)).toContain(theme.fg("dim", "… +4 more lines"));
		expect(stripVTControlCharacters(oracleBody.at(-1) ?? "")).not.toContain("expand");
		// A body longer than the EXPANDED budget still holds lines back, and there the host offers no
		// gesture, because there is nothing further to disclose: the sentence stands alone.
		const huge = result({
			op: "wait",
			from: "Main",
			waited: message({ body: Array.from({ length: 20 }, (_unused, i) => `reply line ${i + 1}`).join("\n") }),
		});
		const drawnHuge = viewLines(huge, EXPANDED, { op: "wait" }, 200);
		expect(drawnHuge.at(-1)).toContain(theme.fg("dim", "… 8 more lines"));
		expect(stripVTControlCharacters(drawnHuge.at(-1) ?? "")).not.toContain("expand");
		expect(oracleLines(huge, HOST_EXPANDED, { op: "wait" }, 200).at(-1)).toContain(
			theme.fg("dim", "… +8 more lines"),
		);
		// Expanded, the same body fits and neither arm says anything about it.
		expect(stripVTControlCharacters(viewLines(long, EXPANDED, { op: "wait" }, 200).join("\n"))).not.toContain(
			"more lines",
		);
		// A roster longer than the collapsed item budget.
		const roster = result({
			op: "list",
			from: "Main",
			peers: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 4 }, (_unused, i) =>
				peer({ id: `Agent_${i + 1}`, status: "idle" }),
			),
		});
		const drawnRoster = viewLines(roster, COLLAPSED, { op: "list" }, 200);
		expect(drawnRoster).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(drawnRoster.at(-1)).toContain(theme.fg("dim", "… 4 more peers"));
		expect(drawnRoster.at(-1)).toContain(formatExpandHint(theme, false, true));
		expect(oracleLines(roster, HOST_COLLAPSED, { op: "list" }, 200).at(-1)).toContain(
			theme.fg("dim", "… 4 more peers"),
		);
		// Expanded, every peer is drawn and both arms agree byte for byte again.
		expect(asMain("dim", marks(dots(viewLines(roster, EXPANDED, { op: "list" }, 200))))).toEqual(
			fitted(oracleLines(roster, HOST_EXPANDED, { op: "list" }, 200)),
		);
		// The recipients of a broadcast are the third hold-back, worded by the same host sentence.
		const broadcast = result({
			op: "send",
			from: "Main",
			to: "all",
			receipts: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 4 }, (_unused, i) => ({
				to: `Agent_${i + 1}`,
				outcome: "woken" as const,
			})),
		});
		const drawnBroadcast = viewLines(broadcast, COLLAPSED, { op: "send", to: "all", message: "heads up" }, 200);
		expect(drawnBroadcast.at(-1)).toContain(theme.fg("dim", "… 4 more recipients"));
		expect(drawnBroadcast.at(-1)).toContain(formatExpandHint(theme, false, true));
		// A single held-back item is worded singular, which is the host's plural rule rather than the
		// tool's.
		const one = result({
			op: "list",
			from: "Main",
			peers: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1 }, (_unused, i) =>
				peer({ id: `Agent_${i + 1}`, status: "idle" }),
			),
		});
		expect(stripVTControlCharacters(viewLines(one, COLLAPSED, { op: "list" }, 200).at(-1) ?? "")).toContain(
			"… 1 more peer ",
		);
	});

	it("exception cell: an error card tones every line, where main coloured the block once", () => {
		// A failure with one line is byte-identical, rail included: the error edge is the host's too.
		for (const width of [200, WIDTH, 40]) {
			const single: IrcViewResult = { content: [{ type: "text", text: "bus unavailable" }], isError: true };
			expect(fitted(viewLines(single, COLLAPSED, { op: "inbox" }, width))).toEqual(
				fitted(oracleLines(single, HOST_COLLAPSED, { op: "inbox" }, width)),
			);
			const listing: IrcViewResult = {
				content: [{ type: "text", text: "registry unavailable" }],
				details: { op: "list", from: "Main" },
				isError: true,
			};
			expect(fitted(viewLines(listing, COLLAPSED, { op: "list" }, width))).toEqual(
				fitted(oracleLines(listing, HOST_COLLAPSED, { op: "list" }, width)),
			);
		}
		const many: IrcViewResult = { content: [{ type: "text", text: "boom\nsecond line" }], isError: true };
		const drawn = viewLines(many, COLLAPSED, undefined, 200);
		const oracle = oracleLines(many, HOST_COLLAPSED, undefined, 200);
		expect(drawn[1]).toContain(`  ${theme.fg("error", "boom")}`);
		expect(drawn[2]).toContain(`  ${theme.fg("error", "second line")}`);
		expect(oracle[2]).not.toContain(theme.fg("error", "second line"));
		expect(stripVTControlCharacters(oracle[2] ?? "").trimEnd()).toBe(`${rail()}  second line`);
		expect(stripVTControlCharacters(drawn[2] ?? "").trimEnd()).toBe(`${rail()}    second line`);
		// A result with neither details nor an op reports the same settled row in both arms.
		const done: IrcViewResult = { content: [{ type: "text", text: "Done." }] };
		expect(asMain("dim", viewLines(done, COLLAPSED, undefined, 200))).toEqual(
			fitted(oracleLines(done, HOST_COLLAPSED, undefined, 200)),
		);
	});

	it("draws a partial result as the pending card, where main framed it pending too", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "woken" }],
		});
		const drawn = renderCompLines(
			drawToolView(ircToolView.renderResult(value, { expanded: false, partial: true }, SEND_ARGS), theme),
			200,
		);
		const oracle = renderCompLines(
			ircOracle.ircToolRenderer.renderResult(value, { expanded: false, isPartial: true }, theme, SEND_ARGS),
			200,
		);
		expect(asMain("accent", drawn)).toEqual(fitted(oracle));
	});

	it("draws the transcript card for live traffic exactly as main drew it", () => {
		const cards: IrcMessageCard[] = [
			{ kind: "incoming", from: "AuthLoader", body: "bus landed.", timestamp: TS_NOW },
			{ kind: "autoreply", to: "AuthLoader", body: "on it.", replyTo: "1", timestamp: TS_NOW },
			{ kind: "relay", from: "AuthLoader", to: "RateLimiter", body: "receipts carry outcome." },
			{ kind: "incoming", body: "" },
			{
				kind: "incoming",
				from: "AuthLoader",
				body: Array.from({ length: 6 }, (_unused, i) => `line ${i + 1}`).join("\n"),
				timestamp: TS_NOW,
			},
		];
		for (const card of cards) {
			for (const expanded of [false, true]) {
				for (const width of [200, WIDTH, 40]) {
					const moved = renderCompLines(
						createIrcMessageCard(card, () => expanded, theme),
						width,
					);
					const oracle = renderCompLines(
						ircOracle.createIrcMessageCard(card, () => expanded, theme),
						width,
					);
					expect(moved).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the card the move is compared on carries the direction, the peer and the body.
		const drawn = stripVTControlCharacters(
			renderCompLines(
				createIrcMessageCard(cards[0]!, () => false, theme),
				200,
			).join("\n"),
		);
		expect(drawn).toContain(`IRC ${theme.nav.back} AuthLoader`);
		expect(drawn).toContain("bus landed.");
	});
});

describe("write tool differential", () => {
	const PATH = "src/app.ts";
	const RESOLVED = "/repo/src/app.ts";
	const FILE = Array.from({ length: 20 }, (_unused, index) => `const value${index + 1} = ${index + 1};`).join("\n");
	const ARGS: WriteViewArgs = { path: PATH, content: FILE };

	/**
	 * A card with the block's own width padding removed.
	 *
	 * The head row of a settled card states its metadata as entries the host separates, so the two
	 * arms' longest rows differ by a column or two and the block pads every other row to match. The
	 * padding sits between the content and the background reset, so `trimEnd` never reaches it, and it
	 * is the host's layout rather than either renderer's bytes.
	 */
	function fitted(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +(\x1b\[49m)$/, "$1"));
	}

	function result(overrides: Partial<WriteViewResult> = {}): WriteViewResult {
		return {
			content: [{ type: "text", text: `Wrote ${RESOLVED}` }],
			details: { resolvedPath: RESOLVED },
			...overrides,
		};
	}

	function viewLines(
		value: WriteViewResult,
		context: ToolViewContext,
		width = WIDTH,
		args: WriteViewArgs | undefined = ARGS,
	): string[] {
		return fitted(renderCompLines(drawToolView(writeToolView.renderResult(value, context, args), theme), width));
	}

	function oracleLines(
		value: WriteViewResult,
		options: RenderResultOptions,
		width = WIDTH,
		args: WriteViewArgs | undefined = ARGS,
	): string[] {
		return fitted(
			renderCompLines(writeOracle.mainWriteToolRenderer.renderResult(value, options, theme, args), width),
		);
	}

	it("draws the failed card byte for byte, at every width and disclosure", () => {
		const failures: WriteViewResult[] = [
			{ content: [{ type: "text", text: "EACCES: permission denied, open 'src/app.ts'" }], isError: true },
			{ content: [{ type: "text", text: "" }], isError: true },
			{ content: [{ type: "text", text: "Error:   \tspaced\tmessage" }], isError: true },
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(viewLines(value, context, width)).toEqual(oracleLines(value, options, width));
				}
			}
		}
		// Anti-vacuity: the compared card names the tool and the file, marks the failure, and carries
		// the message indented under the header rather than an empty frame.
		const drawn = viewLines(failures[0]!, COLLAPSED, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Write: src/app.ts");
		expect(flat).toContain("  EACCES: permission denied");
		expect(drawn.join("\n")).toContain(theme.fg("error", "EACCES: permission denied, open 'src/app.ts'"));
		// A message with no text still says something, in both arms alike.
		expect(stripVTControlCharacters(viewLines(failures[1]!, COLLAPSED, 200).join("\n"))).toContain("Unknown error");
	});

	it("draws the file's rows byte for byte: the gutter, the highlighting and the tabs", () => {
		const files = [
			FILE,
			// A tab-indented file: the gutter is the host's and the tab is replaced, in both arms.
			"function f() {\n\treturn 1;\n}",
			// Past the three-digit gutter, where a width derived from the line count would shift rows.
			Array.from({ length: 1200 }, (_unused, index) => `line ${index + 1}`).join("\n"),
			"",
		];
		for (const content of files) {
			const args: WriteViewArgs = { path: PATH, content };
			for (const width of [200, WIDTH, 40]) {
				// Expanded: nothing is held back, so every row of the card below the header is the file
				// and is compared whole.
				expect(viewLines(result(), EXPANDED, width, args).slice(1)).toEqual(
					oracleLines(result(), HOST_EXPANDED, width, args).slice(1),
				);
				// Collapsed: the same rows, minus the held-back note the host words differently.
				expect(viewLines(result(), COLLAPSED, width, args).slice(1, -1)).toEqual(
					oracleLines(result(), HOST_COLLAPSED, width, args).slice(1, -1),
				);
			}
		}
		// Anti-vacuity: the rows compared carry the gutter and the file's own text, and a collapsed
		// card stops at the preview budget where an expanded one does not.
		const collapsed = stripVTControlCharacters(viewLines(result(), COLLAPSED, 200).join("\n"));
		expect(collapsed).toContain("  1 const value1 = 1;");
		expect(collapsed).toContain("  6 const value6 = 6;");
		expect(collapsed).not.toContain("  7 const value7 = 7;");
		expect(stripVTControlCharacters(viewLines(result(), EXPANDED, 200).join("\n"))).toContain(
			" 20 const value20 = 20;",
		);
	});

	it("draws the compiler's diagnostics byte for byte, grouped and capped as main grouped them", () => {
		const messages = [
			"src/app.ts:12:5 [error] [ts] Type 'string' is not assignable to type 'number' (2322)",
			"src/app.ts:3:1 [warning] [biome] unused import",
			"src/other.ts:8:2 [info] consider a narrower type",
			"src/other.ts:8:2 [hint] a hint with no code",
			"a line the grammar does not match [error] raw",
			"a note the grammar does not match",
		];
		const cases: Array<{ errored: boolean; summary: string; messages: string[] }> = [
			{ errored: true, summary: "2 errors, 1 warning", messages },
			{ errored: false, summary: "1 warning", messages: messages.slice(1, 3) },
			{ errored: true, summary: "", messages: messages.slice(0, 1) },
			// Past the collapsed cap, where both arms count what they kept back.
			{
				errored: true,
				summary: "9 errors",
				messages: Array.from({ length: 9 }, (_unused, index) => `src/app.ts:${index + 1}:1 [error] boom`),
			},
		];
		for (const diagnostics of cases) {
			const value = result({ details: { resolvedPath: RESOLVED, diagnostics } });
			for (const width of [200, WIDTH]) {
				// The diagnostics rows sit below the file's rows; the expanded arm holds nothing back,
				// so every row below the header is compared.
				expect(viewLines(value, EXPANDED, width).slice(1)).toEqual(
					oracleLines(value, HOST_EXPANDED, width).slice(1),
				);
			}
		}
		// Anti-vacuity: the compared rows carry the diagnostics header with its summary, the file each
		// group belongs to, the location, the message, the code, and the severity tone.
		const value = result({ details: { resolvedPath: RESOLVED, diagnostics: cases[0]! } });
		const drawn = viewLines(value, EXPANDED, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Diagnostics (2 errors, 1 warning)");
		expect(flat).toContain("src/other.ts");
		expect(flat).toContain(":12:5 Type 'string' is not assignable to type 'number' (2322)");
		expect(drawn.join("\n")).toContain(theme.fg("error", "Type 'string' is not assignable to type 'number'"));
		// The worst comes first inside a file: the error on line 12 above the warning on line 3.
		const rows = drawn.map(row => stripVTControlCharacters(row));
		expect(rows.findIndex(row => row.includes(":12:5"))).toBeLessThan(
			rows.findIndex(row => row.includes(":3:1 unused import")),
		);
		// A collapsed card keeps five of them back and says so, which is the one row the two arms
		// word differently and is compared in its own cell below.
		expect(stripVTControlCharacters(viewLines(value, COLLAPSED, 200).at(-1) ?? "")).toContain("… 1 more");
	});

	it("states the file's length and its execute bit as row metadata, where main wrote them into the description", () => {
		const value = result({ details: { resolvedPath: RESOLVED, madeExecutable: true } });
		const drawn = viewLines(value, EXPANDED, 200)[0]!;
		const oracle = oracleLines(value, HOST_EXPANDED, 200)[0]!;
		expect(drawn).not.toEqual(oracle);
		// Main wrote the separator and both facts into the description, so the dot before the count
		// was the tool's and the success colour sat inside the row's muted run.
		expect(oracle).toContain(`${theme.fg("dim", " · 20 lines")}`);
		expect(oracle).toContain(theme.fg("success", "made executable!"));
		// The view states two facts and no separator; the host joins them with its own and draws the
		// pair in the dim it gives every row's trailing detail.
		expect(drawn).toContain(theme.fg("dim", `20 lines${theme.sep.dot}${theme.fg("success", "made executable!")}`));
		// The visible words are the same words, in the same order, on the same row.
		expect(stripVTControlCharacters(drawn)).toContain("20 lines");
		expect(stripVTControlCharacters(drawn)).toContain("made executable!");
		expect(stripVTControlCharacters(drawn).indexOf("20 lines")).toBeLessThan(
			stripVTControlCharacters(drawn).indexOf("made executable!"),
		);
		// The file's rows below it are untouched by the difference.
		expect(viewLines(value, EXPANDED, 200).slice(1)).toEqual(oracleLines(value, HOST_EXPANDED, 200).slice(1));
	});

	it("words the held-back count as the host words every card's, where main nested the gesture inside its own run", () => {
		const drawn = viewLines(result(), COLLAPSED, 200).at(-1)!;
		const oracle = oracleLines(result(), HOST_COLLAPSED, 200).at(-1)!;
		expect(drawn).not.toEqual(oracle);
		// The same sentence either way: the count, the unit, and the gesture the reader uses.
		expect(stripVTControlCharacters(drawn)).toEqual(stripVTControlCharacters(oracle));
		expect(stripVTControlCharacters(drawn)).toContain("… 14 more lines");
		expect(stripVTControlCharacters(drawn)).toContain("expand");
		// Main opened one dim run over the whole sentence and nested the gesture's own run inside it;
		// the host writes the count in dim and closes it before the gesture beside it.
		expect(oracle).toContain(theme.fg("dim", `… 14 more lines ${formatExpandHint(theme, false, true)}`));
		expect(drawn).toContain(`${theme.fg("dim", "… 14 more lines")} ${formatExpandHint(theme, false, true)}`);
	});

	it("windows the streaming preview by the rows it occupies, where main windowed it by its own line count", () => {
		const args: WriteViewArgs = { path: PATH, content: FILE };
		const drawn = renderCompLines(
			drawToolView(writeToolView.renderCall(args, { expanded: false, partial: true, frame: 0 }), theme, 0),
			WIDTH,
		);
		const oracle = renderCompLines(
			writeOracle.mainWriteToolRenderer.renderCall(
				args,
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				theme,
			),
			WIDTH,
		);
		expect(drawn).not.toEqual(oracle);
		// Main cut the file to its last twelve LINES and wrote a bracketed count of the rest; the host
		// cuts it to the twelve ROWS it was given, spends one of them on the note, and offers the
		// expand gesture the tool no longer words.
		expect(stripVTControlCharacters(oracle.join("\n"))).toContain("… (8 earlier lines)");
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain("… 9 earlier lines");
		expect(stripVTControlCharacters(drawn.join("\n"))).toContain("expand");
		// Both arms follow the streaming edge and both say the card is still arriving.
		for (const arm of [drawn, oracle]) {
			const flat = stripVTControlCharacters(arm.join("\n"));
			expect(flat).toContain(" 20 const value20 = 20;");
			expect(flat).toContain("… (streaming)");
			expect(flat).not.toContain("  1 const value1 = 1;");
		}
		// Expanded, neither arm windows anything, and the rows below the header are byte-identical.
		const wholeDrawn = renderCompLines(
			drawToolView(writeToolView.renderCall(args, { expanded: true, partial: true, frame: 0 }), theme, 0),
			WIDTH,
		);
		const wholeOracle = renderCompLines(
			writeOracle.mainWriteToolRenderer.renderCall(
				args,
				{ expanded: true, isPartial: true, spinnerFrame: 0 },
				theme,
			),
			WIDTH,
		);
		expect(wholeDrawn).toEqual(wholeOracle);
	});

	it("states one language for the call row and the settled card, where main resolved two", () => {
		const args: WriteViewArgs = { path: "notes", content: "hello\n" };
		const call = framedView(writeToolView.renderCall(args, { expanded: true, partial: true, frame: 0 })).header;
		const settled = framedView(writeToolView.renderResult(result(), EXPANDED, args)).header;
		// An extensionless file names no language. Main resolved the call row's to `text` and the
		// settled card's to nothing at all, so a host with language glyphs drew a different badge on
		// each card and the glyph changed under the reader when the write settled. The view states one
		// language for both, empty because the file names one the tool cannot tell — which is a file a
		// host may still mark, and not the same claim as a row that names no file.
		expect(call.language).toEqual("");
		expect(settled.language).toEqual("");
		expect(call.language).not.toBeUndefined();
		// A file whose language IS named states that language on both cards.
		const known = framedView(writeToolView.renderCall(ARGS, { expanded: true, partial: true, frame: 0 })).header;
		expect(known.language).toEqual("typescript");
		expect(framedView(writeToolView.renderResult(result(), EXPANDED, ARGS)).header.language).toEqual("typescript");
		// The bundled preset ships no language glyphs, so `langBadge` is empty for every language and
		// neither arm's drawn row can show this difference. That is what the field claim is for, and
		// what this cell does NOT catch is a host that reads `language` and draws the wrong glyph.
		expect(theme.langBadge("typescript")).toEqual("");
		// With no badge to draw, the call row the host draws is byte for byte the row main drew.
		expect(
			renderCompLines(
				drawToolView(writeToolView.renderCall(ARGS, { expanded: true, partial: true, frame: 0 }), theme, 0),
				200,
			)[0]!,
		).toEqual(
			renderCompLines(
				writeOracle.mainWriteToolRenderer.renderCall(
					ARGS,
					{ expanded: true, isPartial: true, spinnerFrame: 0 },
					theme,
				),
				200,
			)[0]!,
		);
	});

	it("leaves no blank rows between a partial result's progress line and the file, where main left two", () => {
		const value = result({ content: [{ type: "text", text: "Writing 4096 bytes to src/app.ts..." }] });
		const partial = { expanded: true, partial: true, frame: 0 } as const;
		const hostPartial: RenderResultOptions = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const drawn = fitted(
			renderCompLines(drawToolView(writeToolView.renderResult(value, partial, ARGS), theme, 0), 200),
		);
		const oracle = fitted(
			renderCompLines(writeOracle.mainWriteToolRenderer.renderResult(value, hostPartial, theme, ARGS), 200),
		);
		// A row of the frame and nothing else: no letter and no digit anywhere on it.
		const wordless = (row: string): boolean => !/[\p{L}\p{N}]/u.test(stripVTControlCharacters(row));
		// Main's progress text and its preview were one string, and the preview opened with the blank
		// pair that the leading-blank trim only reaches at the top of a card, so the gap survived in
		// the middle of one. Sections carry no such padding.
		expect(oracle.filter(wordless)).toHaveLength(2);
		expect(drawn.filter(wordless)).toHaveLength(0);
		// Below the head row, every row either arm draws is the same row: the progress line, then the
		// file as far as it has arrived.
		expect(drawn.slice(1)).toEqual(oracle.filter(row => !wordless(row)).slice(1));
		// The head row differs only in who writes the separator before the length. Main wrote it into
		// the description; the view states the length as row metadata and the host spaces it, exactly
		// as it spaces every other tool's.
		expect(stripVTControlCharacters(oracle[0]!)).toContain(`src/app.ts${theme.sep.dot}20 lines`);
		expect(stripVTControlCharacters(drawn[0]!)).toContain("src/app.ts 20 lines");
		// Anti-vacuity: the progress line leads the card, the file follows it, and the row states the
		// length of what has arrived without claiming the execute bit that settling decides.
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("Writing 4096 bytes to src/app.ts...");
		expect(flat).toContain("  1 const value1 = 1;");
		expect(flat).not.toContain("made executable");
	});
});

describe("file_search tool differential", () => {
	const rail = (): string => theme.symbol("block.rail");

	/**
	 * The oracle's rail run rewritten to the colour the host's reduction paints.
	 *
	 * Main's file search asked `framedBlock` for no rail colour, so it took the block's own default:
	 * `dim` on a settled card and `warning` on a truncated one. A view names no colour at all and the
	 * reduction in `draw-tool-view.ts` quiets every rail but a failure's, which is what the twelve
	 * renderers that passed `borderMuted` by hand already drew. Swapping the run here leaves every
	 * other byte of the row to be compared.
	 */
	function quietRail(lines: readonly string[], from: ThemeColor = "dim"): string[] {
		return lines.map(line => line.replace(theme.fg(from, rail()), theme.fg("borderMuted", rail())));
	}

	/** Main's `new Text(text, 1, 0)` indent, dropped: the pad is the whole of the difference. */
	function unpad(lines: readonly string[]): string[] {
		return lines.map(line => (line.startsWith(" ") ? line.slice(1) : line));
	}

	/**
	 * The spaces a frame pads a row with, dropped.
	 *
	 * A framed block sizes itself to its widest row, so a card whose widest row is the held-back note
	 * is one hint wider in the arm that offers the gesture. Every row of it then carries one more
	 * space before the block closes its ground. The pad is the width's doing rather than the row's, so
	 * a cell that pins the width separately compares the rows without it.
	 */
	function withoutFramePad(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +\u001b\[49m$/, "\u001b[49m"));
	}

	/**
	 * Every colour sequence that paints nothing, removed.
	 *
	 * Main joined pre-coloured strings into one `Text`, so a row carries the runs its neighbours
	 * opened and closed with no character between them, and the absent folder glyph opens one more.
	 * Nothing on any terminal draws differently for them. A pass over the row is exact where a regex
	 * is not: an open followed straight by a reset paints nothing, and a reset with no open before it
	 * closes nothing, and both appear here because the joined runs nest.
	 */
	function withoutEmptyRuns(lines: readonly string[]): string[] {
		const sequence = /\u001b\[(?:38;2;\d+;\d+;\d+|39)m/g;
		return lines.map(line => {
			let out = "";
			let cursor = 0;
			let open: string | undefined;
			for (const match of line.matchAll(sequence)) {
				const text = line.slice(cursor, match.index);
				cursor = match.index + match[0].length;
				if (text.length > 0) {
					// The pending open painted something, so it and the text stay.
					out += `${open ?? ""}${text}`;
					open = undefined;
				}
				if (match[0] === "\u001b[39m") {
					// A reset closes the open it follows, or nothing at all.
					if (text.length > 0) out += match[0];
					open = undefined;
					continue;
				}
				open = match[0];
			}
			return `${out}${open ?? ""}${line.slice(cursor)}`;
		});
	}

	function viewLines(
		value: FileSearchViewResult,
		context: ToolViewContext,
		args: FileSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(fileSearchToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: FileSearchViewResult,
		options: RenderResultOptions,
		args: FileSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		// The oracle took the tool's whole result shape, where a view narrows it to what a card reads:
		// the content of a result that carries none is the empty list the tool would have sent.
		const whole = { content: value.content ?? [], details: value.details, isError: value.isError };
		return renderCompLines(fileSearchOracle.fileSearchRenderer.renderResult(whole, options, theme, args), width);
	}

	/** A result the tool described with details, which is the card that frames a list. */
	function detailed(details: Partial<FileSearchDetails>): FileSearchViewResult {
		return { content: [{ type: "text", text: "" }], details: { fileCount: 0, files: [], ...details } };
	}

	const FILES = [
		"src/",
		"src/index.ts",
		"src/util.ts",
		"docs/",
		"docs/a.md",
		"README.md",
		"x/y.rs",
		"z.json",
		"q.py",
		"w.go",
		"e.rb",
	];

	it("exception cell: draws the pending call row in the column its siblings draw in", () => {
		const calls: Array<FileSearchRenderArgs | undefined> = [
			{ input: "src/**/*.ts" },
			{ input: "src/**/*.ts", limit: 50 },
			{ input: "src/**/*.ts", limit: 1 },
			{ input: "*" },
			// A pattern the model sent empty, and a call with no arguments at all: both rows say what
			// the search covers rather than naming nothing, which is the case a `??` in place of the
			// `||` changes.
			{ input: "" },
			{},
			undefined,
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				// Widths where the row fits: the wrap boundary is the pad's business, and a row cut
				// at width 12 wraps one column earlier in the padded arm, which is the same
				// difference counted twice rather than a second one.
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(
						drawToolView(lineView(fileSearchToolView.renderCall(args ?? {}, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						fileSearchOracle.fileSearchRenderer.renderCall(args ?? {}, options, theme),
						width,
					);
					// Main built the row with `new Text(text, 1, 0)`, whose one-column horizontal pad
					// indents it past every other tool's row. A view is drawn with no pad at all, so
					// the row moves one column left and nothing else about it changes.
					expect(unpad(oracle)).toEqual(drawn);
				}
			}
		}
		// The pad is real in one arm and absent in the other, so the cell above is not comparing two
		// unpadded rows.
		const padded = renderCompLines(
			fileSearchOracle.fileSearchRenderer.renderCall({ input: "*" }, HOST_COLLAPSED, theme),
			200,
		);
		expect(padded[0]!.startsWith(" ")).toBe(true);
		const flush = renderCompLines(
			drawToolView(lineView(fileSearchToolView.renderCall({ input: "*" }, COLLAPSED)), theme),
			200,
		);
		expect(flush[0]!.startsWith(" ")).toBe(false);
		// Anti-vacuity: the compared row carries the tool's title, the pattern the model asked for,
		// and the cap when one was sent, and a call with no pattern still says what it searches.
		const one = stripVTControlCharacters(flush.join(""));
		expect(one).toContain("Search files: *");
		const capped = stripVTControlCharacters(
			renderCompLines(
				drawToolView(lineView(fileSearchToolView.renderCall({ input: "src/**", limit: 50 }, COLLAPSED)), theme),
				200,
			).join(""),
		);
		expect(capped).toContain("Search files: src/**");
		expect(capped).toContain("limit:50");
		const bare = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(fileSearchToolView.renderCall({}, COLLAPSED)), theme), 200).join(""),
		);
		expect(bare).toContain("Search files: *");
	});

	it("exception cell: names a failure in main's words, one column left of them", () => {
		const failures: FileSearchViewResult[] = [
			{ content: [{ type: "text", text: "boom went the glob" }], isError: true },
			{ content: [], details: { error: "bad pattern" } as FileSearchDetails },
			// A failure the tool reported with neither a message nor details: both arms name it.
			{ content: [], isError: true },
			// Both channels at once: the details win in both arms.
			{
				content: [{ type: "text", text: "content text" }],
				details: { error: "details error" } as FileSearchDetails,
				isError: true,
			},
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "*" }, width))).toEqual(
						viewLines(value, context, { input: "*" }, width),
					);
				}
			}
		}
		// Anti-vacuity: the row says which failure it was, in the error tone, and the details beat the
		// content text rather than being appended to it.
		const drawn = viewLines(failures[3]!, COLLAPSED, { input: "*" }, 200);
		expect(drawn[0]).toContain(theme.fg("error", "Error: details error"));
		expect(stripVTControlCharacters(drawn.join(""))).not.toContain("content text");
		expect(stripVTControlCharacters(viewLines(failures[2]!, COLLAPSED, { input: "*" }, 200).join(""))).toContain(
			"Unknown error",
		);
	});

	it("exception cell: states a text-only empty answer where main stated it", () => {
		const empties: FileSearchViewResult[] = [
			{ content: [{ type: "text", text: "No files found matching" }] },
			{ content: [{ type: "text", text: "No files matching *.zig" }] },
			{ content: [{ type: "text", text: "   " }] },
			{ content: [] },
		];
		for (const value of empties) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "*.zig" }, width))).toEqual(
						viewLines(value, context, { input: "*.zig" }, width),
					);
				}
			}
		}
		// Anti-vacuity: one row, the warning mark, and the words main wrote -- not a frame around
		// nothing and not the tool's own sentence.
		const drawn = viewLines(empties[0]!, COLLAPSED, { input: "*.zig" }, 200);
		expect(drawn).toHaveLength(1);
		expect(drawn[0]).toContain(theme.fg("muted", "No files found"));
		expect(stripVTControlCharacters(drawn[0] ?? "")).not.toContain("matching");
	});

	it("lists the lines of a text-only result byte for byte inside the rail the host quiets", () => {
		const lines = Array.from({ length: 12 }, (_unused, index) => `out/f${index}.ts`);
		const value: FileSearchViewResult = { content: [{ type: "text", text: lines.join("\n") }] };
		const args: FileSearchRenderArgs = { input: "out/**" };
		for (const width of [200, WIDTH, 40]) {
			// Expanded holds nothing back, so every row of the body is compared.
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
			// Collapsed shows the same rows and holds the same count back; only the note differs.
			const drawn = viewLines(value, COLLAPSED, args, width);
			const oracle = quietRail(oracleLines(value, HOST_COLLAPSED, args, width));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Exception: main wrote the count with no gesture; the host writes the same count in the
			// same dim and offers the expand hint it offers on every other card.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 4 more files"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 4 more files"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// The rail is the block's default in one arm and the host's quiet edge in the other, so the
		// swap above is not comparing two identical runs.
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("dim", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row counts what was found, the collapsed body stops at the shared
		// cap, and expanding reveals the rest.
		const collapsed = viewLines(value, COLLAPSED, args, 200);
		expect(stripVTControlCharacters(collapsed[0] ?? "")).toContain("12 files");
		expect(collapsed).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(stripVTControlCharacters(collapsed.join("\n"))).not.toContain("out/f8.ts");
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("out/f11.ts");
		expect(expanded).not.toContain("more files");
		// A block with blank rows in it and one path too long for the frame: both arms drop the blanks
		// and cut the long row at the same column, so a card that listed a blank row or wrapped the
		// long one would draw rows main never drew.
		const ragged: FileSearchViewResult = {
			content: [
				{
					type: "text",
					text: ["out/a.ts", "", "   ", "out/b.ts", `out/${"deep/".repeat(30)}leaf.ts`, ""].join("\n"),
				},
			],
		};
		for (const width of [200, WIDTH, 40]) {
			expect(quietRail(oracleLines(ragged, HOST_EXPANDED, args, width))).toEqual(
				viewLines(ragged, EXPANDED, args, width),
			);
		}
		const raggedRows = viewLines(ragged, EXPANDED, args, WIDTH);
		expect(stripVTControlCharacters(raggedRows[0] ?? "")).toContain("3 files");
		expect(raggedRows).toHaveLength(4);
		expect(stripVTControlCharacters(raggedRows.join("\n"))).not.toContain("leaf.ts");
	});

	it("lists a detailed result byte for byte apart from the rail and the runs main left in it", () => {
		const value = detailed({ fileCount: FILES.length, files: FILES, cwd: "/repo", scopePath: "src" });
		const args: FileSearchRenderArgs = { input: "**/*" };
		for (const width of [200, WIDTH, 40]) {
			expect(withoutEmptyRuns(quietRail(oracleLines(value, HOST_EXPANDED, args, width)))).toEqual(
				withoutEmptyRuns(viewLines(value, EXPANDED, args, width)),
			);
			const drawn = withoutEmptyRuns(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutEmptyRuns(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 3 more files"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 3 more files"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
		}
		// The run the normalization removes is real, and it is main's alone: main opened a colour for a
		// folder glyph this preset does not draw and closed it with no character between.
		const rawDirectory = oracleLines(value, HOST_EXPANDED, args, 200)[1] ?? "";
		expect(rawDirectory).toContain(`${theme.fg("accent", "")}${theme.fg("accent", "src/")}`);
		expect(viewLines(value, EXPANDED, args, 200)[1]).toContain(theme.fg("accent", "src/"));
		expect(viewLines(value, EXPANDED, args, 200)[1]).not.toContain(
			`${theme.fg("accent", "")}${theme.fg("accent", "src/")}`,
		);
		// Anti-vacuity: the head row counts the files and states the scope, a directory row is toned
		// and indented as a directory and a file row as output, and the order the tool sent is the
		// order drawn.
		const drawn = viewLines(value, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("11 files");
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("in src");
		expect(drawn[2]).toContain(theme.fg("toolOutput", "src/index.ts"));
		const words = drawn.slice(1).map(row => stripVTControlCharacters(row).replace(rail(), "").trim());
		expect(words).toEqual(FILES);
		// One row over the cap: the count is worded singular in both arms, so a card that always said
		// `files` would say what main did not.
		const oneOver = detailed({
			fileCount: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1,
			files: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1 }, (_unused, index) => `src/f${index}.ts`),
			cwd: "/repo",
		});
		// The frame sizes itself to its widest row, and here that row is the note: the hint the host
		// adds makes the view's frame wider by exactly the hint, so the rows are compared without the
		// padding that width decides and the width itself is pinned below.
		const oneOverDrawn = withoutFramePad(withoutEmptyRuns(viewLines(oneOver, COLLAPSED, args, 200)));
		const oneOverOracle = withoutFramePad(
			withoutEmptyRuns(quietRail(oracleLines(oneOver, HOST_COLLAPSED, args, 200))),
		);
		expect(oneOverDrawn.slice(0, -1)).toEqual(oneOverOracle.slice(0, -1));
		expect(oneOverDrawn.at(-1)).toContain(theme.fg("dim", "… 1 more file"));
		// A frame is rectangular in both arms, and the note is the row it sizes itself to here: the
		// view's carries the gesture, main's carries the count alone. How many columns that costs is
		// the block's arithmetic over its widest row, which is why the rows above are compared without
		// the pad rather than against a hint-sized delta.
		const widths = (rows: readonly string[]): Set<number> =>
			new Set(rows.map(row => stripVTControlCharacters(row).length));
		const drawnRows = viewLines(oneOver, COLLAPSED, args, 200);
		expect(widths(drawnRows).size).toBe(1);
		expect(widths(oracleLines(oneOver, HOST_COLLAPSED, args, 200)).size).toBe(1);
		expect(stripVTControlCharacters(drawnRows.at(-1) ?? "")).toContain("… 1 more file ▸ Ctrl+O expand");
		expect(oneOverOracle.at(-1)).toContain(theme.fg("dim", "… 1 more file"));
		expect(stripVTControlCharacters(oneOverOracle.at(-1) ?? "")).not.toContain("expand");
	});

	it("states for a second host which outcome the card framed, and what each row points at", () => {
		const args: FileSearchRenderArgs = { input: "**/*" };
		// The state is the card's own claim rather than a colour: on this preset a warning frame and a
		// success frame draw the same quiet rail and the same ground, so a host that reads the view --
		// a browser, an export -- is the only reader that can tell them apart.
		const settled = detailed({ fileCount: 2, files: ["src/a.ts", "src/b.ts"], cwd: "/repo" });
		const cut = detailed({ fileCount: 2, files: ["src/a.ts"], cwd: "/repo", truncated: true });
		expect(framedView(fileSearchToolView.renderResult(settled, EXPANDED, args)).state).toBe("success");
		expect(framedView(fileSearchToolView.renderResult(cut, EXPANDED, args)).state).toBe("warning");
		// A row states the language of the file it names, and states it empty for a path whose language
		// this build cannot tell, so a host with a badge draws one for the first and nothing for the
		// second rather than dropping the field on both.
		const mixed = detailed({ fileCount: 2, files: ["src/a.ts", "notes.unknownext"], cwd: "/repo" });
		const sections = framedView(fileSearchToolView.renderResult(mixed, EXPANDED, args)).sections;
		const rows = sections[0]?.lines ?? [];
		expect(rows[0]?.at(-1)).toMatchObject({ language: "typescript", file: "/repo/src/a.ts" });
		expect(rows[1]?.at(-1)).toMatchObject({ language: "", file: "/repo/notes.unknownext" });
		// With hyperlinks on, the rows carry the OSC 8 targets main's own list carried, resolved
		// against the search's base rather than the process's.
		settings.override("tui.hyperlinks", "always");
		try {
			for (const width of [200, WIDTH]) {
				expect(withoutEmptyRuns(quietRail(oracleLines(mixed, HOST_EXPANDED, args, width)))).toEqual(
					withoutEmptyRuns(viewLines(mixed, EXPANDED, args, width)),
				);
			}
			const drawn = viewLines(mixed, EXPANDED, args, 200);
			expect(drawn[1]).toContain("\u001b]8;");
			expect(drawn[1]).toContain("/repo/src/a.ts");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("exception cell: an empty detailed answer indents its rows and opens no run it does not use", () => {
		const cases: Array<{ details: Partial<FileSearchDetails>; args: FileSearchRenderArgs | undefined }> = [
			{ details: {}, args: { input: "*.zig" } },
			// No pattern at all, and a pattern the model sent empty: the head row states for each what
			// main stated, which is the case a `??` in place of the `||` changes.
			{ details: {}, args: undefined },
			{ details: {}, args: { input: "" } },
			{ details: { truncated: true }, args: { input: "~/.cache/*" } },
			{ details: { missingPaths: ["nope/"] }, args: { input: "*" } },
			{ details: { missingPaths: ["a/", "b/"], truncated: true }, args: { input: "*" } },
			{ details: { truncated: true, resultLimitReached: 200 }, args: { input: "*" } },
		];
		for (const { details, args } of cases) {
			const value = detailed(details);
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					const drawn = withoutEmptyRuns(viewLines(value, context, args, width));
					const oracle = withoutEmptyRuns(unpad(oracleLines(value, options, args, width)));
					expect(drawn).toHaveLength(oracle.length);
					// The head row is the same row one column left. Every row under it is the same
					// row indented two columns under that head, where main left it in column zero
					// behind the runs its single `Text` had closed.
					expect(drawn[0]).toBe(oracle[0]);
					for (let row = 1; row < oracle.length; row++) {
						expect(drawn[row]).toBe(`  ${oracle[row]}`);
					}
				}
			}
		}
		// The runs the normalization removes are main's: its body row opens the colours of every
		// neighbouring run before the mark it draws, and the view's row opens only its own.
		const rawEmpty = oracleLines(detailed({}), HOST_COLLAPSED, { input: "*.zig" }, 200);
		expect(rawEmpty[1]).toContain(`${theme.fg("toolTitle", "")}${theme.fg("muted", "")}`);
		expect(viewLines(detailed({}), COLLAPSED, { input: "*.zig" }, 200)[1]).not.toContain(theme.fg("muted", ""));
		// Anti-vacuity: the card says which kind of empty it is, and says separately what the scan
		// never reached and what it cut.
		const timedOut = stripVTControlCharacters(
			viewLines(detailed({ truncated: true }), COLLAPSED, { input: "~/.cache/*" }, 200).join("\n"),
		);
		expect(timedOut).toContain("No matches before timeout (scan incomplete)");
		expect(timedOut).toContain("timed out");
		// A card with no rows states the incomplete scan on its head row and writes no reason note, in
		// both arms: the reasons belong to a card that listed something, which the truncation cell
		// below covers. A note here would be a row main never drew.
		expect(timedOut).not.toContain("truncated:");
		expect(
			stripVTControlCharacters(
				viewLines(detailed({ truncated: true, resultLimitReached: 200 }), COLLAPSED, { input: "*" }, 200).join(
					"\n",
				),
			),
		).not.toContain("limit 200 results");
		const missing = viewLines(detailed({ missingPaths: ["nope/"] }), COLLAPSED, { input: "*" }, 200);
		expect(missing.at(-1)).toContain(theme.fg("warning", "skipped missing: nope/"));
		expect(stripVTControlCharacters(missing.join("\n"))).toContain("No files found");
	});

	it("exception cell: says on the rows what a truncated scan cut, leaving the rail quiet", () => {
		const value = detailed({
			fileCount: 200,
			files: ["src/a.ts", "src/b.ts"],
			cwd: "/repo",
			truncated: true,
			resultLimitReached: 200,
			truncation: {
				content: "src/a.ts\nsrc/b.ts",
				truncated: true,
				truncatedBy: "lines",
				totalLines: 200,
				totalBytes: 4096,
				artifactId: "art_9",
			} as TruncationResult & { artifactId: string },
			missingPaths: ["gone/"],
		});
		const args: FileSearchRenderArgs = { input: "src/**" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH] as const) {
				// Main painted the whole rail in warning because the block derives its edge from the
				// state. The host keeps the quiet edge and the card states the outcome in the words on
				// its rows, which are byte-identical.
				expect(quietRail(oracleLines(value, options, args, width), "warning")).toEqual(
					viewLines(value, context, args, width),
				);
			}
		}
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("warning", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row marks the truncation, and the notes name every reason the tool
		// learned, in the order it learned them, plus the path it never reached.
		const drawn = viewLines(value, EXPANDED, args, 200);
		const flat = stripVTControlCharacters(drawn.join("\n"));
		expect(flat).toContain("200 files");
		expect(flat).toContain("truncated: limit 200 results, line limit, ");
		expect(flat).toContain("art_9");
		expect(flat).toContain("skipped missing: gone/");
		// The whole sentence is one warning run rather than a row whose first clause happens to be
		// toned, and the card writes it once.
		const note = `truncated: limit 200 results, line limit, ${formatFullOutputReference("art_9")}`;
		expect(drawn.filter(row => row.includes(theme.fg("warning", note)))).toHaveLength(1);
	});

	it("cuts a path that outruns the frame where main cut it, instead of wrapping it onto a second row", () => {
		const long = "src/very/deep/nested/directory/structure/that/is/exceptionally/long/and/overflows/index.ts";
		const value = detailed({ fileCount: 1, files: [long], cwd: "/repo" });
		const args: FileSearchRenderArgs = { input: "src/**" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [WIDTH, 60, 40, 20] as const) {
				expect(quietRail(oracleLines(value, options, args, width))).toEqual(viewLines(value, context, args, width));
			}
		}
		// Anti-vacuity: the row is cut rather than wrapped, so the card is two rows and the tail of
		// the path is absent. A wrapped row would make it three and carry `index.ts`.
		const drawn = viewLines(value, EXPANDED, args, WIDTH);
		expect(drawn).toHaveLength(2);
		expect(stripVTControlCharacters(drawn.join("\n"))).not.toContain("index.ts");
		expect(stripVTControlCharacters(drawn[1] ?? "")).toContain("src/very/deep/nested");
		// Wide enough for the whole path: the same row carries it entire, so the cut above is the
		// width's doing and not the card's.
		expect(stripVTControlCharacters(viewLines(value, EXPANDED, args, 200)[1] ?? "")).toContain(long);
	});
});

describe("text_search tool differential", () => {
	const rail = (): string => theme.symbol("block.rail");

	/** Main's `new Text(text, 1, 0)` indent, dropped: the pad is the whole of the difference. */
	function unpad(lines: readonly string[]): string[] {
		return lines.map(line => (line.startsWith(" ") ? line.slice(1) : line));
	}

	/** The oracle's rail run rewritten to the colour the host's reduction paints. */
	function quietRail(lines: readonly string[], from: ThemeColor = "dim"): string[] {
		return lines.map(line => line.replace(theme.fg(from, rail()), theme.fg("borderMuted", rail())));
	}

	/** The spaces a frame pads a row with, dropped, for a card the host's hint made wider. */
	function withoutFramePad(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +\u001b\[49m$/, "\u001b[49m"));
	}

	/**
	 * The expand gesture the host closes a held-back note with, dropped.
	 *
	 * Exception 35 is the gesture alone, so a cell that is about the COUNT compares the rest of the
	 * row: main wrote the same count in the same dim and offered nothing after it. Pair with
	 * `withoutFramePad`, since dropping the gesture leaves the row shorter than the frame padded it.
	 */
	function withoutExpandHint(lines: readonly string[]): string[] {
		const hint = ` ${formatExpandHint(theme, false, true)}`;
		return lines.map(line => line.replace(hint, ""));
	}
	/**
	 * Every colour sequence that paints nothing, removed.
	 *
	 * Main joined pre-coloured strings into one `Text`, so a row carries the runs its neighbours opened
	 * and closed with no character between them. Nothing on any terminal draws differently for them,
	 * and a pass over the row is exact where a regex is not: an open followed straight by a reset
	 * paints nothing, and a reset with no open before it closes nothing.
	 */
	function withoutEmptyRuns(lines: readonly string[]): string[] {
		const sequence = /\u001b\[(?:38;2;\d+;\d+;\d+|39)m/g;
		return lines.map(line => {
			let out = "";
			let cursor = 0;
			let open: string | undefined;
			for (const match of line.matchAll(sequence)) {
				const text = line.slice(cursor, match.index);
				cursor = match.index + match[0].length;
				if (text.length > 0) {
					out += `${open ?? ""}${text}`;
					open = undefined;
				}
				if (match[0] === "\u001b[39m") {
					if (text.length > 0) out += match[0];
					open = undefined;
					continue;
				}
				open = match[0];
			}
			return `${out}${open ?? ""}${line.slice(cursor)}`;
		});
	}

	function viewLines(
		value: TextSearchViewResult,
		context: ToolViewContext,
		args: TextSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(textSearchToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: TextSearchViewResult,
		options: RenderResultOptions,
		args: TextSearchRenderArgs | undefined,
		width = WIDTH,
	): string[] {
		// The oracle took the tool's whole result shape, where a view narrows it to what a card reads:
		// the content of a result that carries none is the empty list the tool would have sent.
		const whole = { content: value.content ?? [], details: value.details, isError: value.isError };
		return renderCompLines(textSearchOracle.textSearchRenderer.renderResult(whole, options, theme, args), width);
	}

	/** A result the tool described with counts, which is the card that frames grouped output. */
	function detailed(details: Partial<TextSearchDetails>): TextSearchViewResult {
		return { content: [{ type: "text", text: "" }], details: { matchCount: 0, fileCount: 0, ...details } };
	}

	/**
	 * A call whose arguments have not arrived.
	 *
	 * `TextSearchRenderArgs` states the pattern, and a streamed call row is drawn before the model has
	 * sent one, so both arms are asked for the row of a call with nothing in it. The cast is the point
	 * of the case rather than a way around the type.
	 */
	const NO_ARGS = {} as TextSearchRenderArgs;

	/** Two files under one directory, which is the shape the tool writes for a multi-file search. */
	const GROUPED = [
		"# src/",
		"## a.ts",
		" 11│const before = 1;",
		"*12│const needle = true;",
		" 13│const after = 3;",
		"",
		"## b.ts",
		"*7│const needle = 2;",
	].join("\n");

	it("exception cell: draws the pending call row in the column its siblings draw in", () => {
		const calls: Array<TextSearchRenderArgs | undefined> = [
			{ input: "needle" },
			{ input: "needle", path: "src" },
			// Two scopes arrive as the JSON-encoded string the tool's own schema takes, since `path` is
			// one string and `toPathList` is what splits it.
			{ input: "needle", path: '["src", "docs"]' },
			{ input: "needle", case: false },
			{ input: "needle", gitignore: false },
			{ input: "needle", skip: 5 },
			// `skip: 0` is not a narrowing, so neither arm says it.
			{ input: "needle", skip: 0 },
			{ input: "needle", path: "src", case: false, gitignore: false, skip: 2 },
			// A pattern the model sent empty, and a call with no arguments at all: both rows say what
			// the search is for rather than naming nothing, which is the case a `??` in place of the
			// `||` changes.
			{ input: "" },
			// A call with no arguments at all, which is the row a host draws before the model has sent
			// any: the type states the pattern, and a streamed call has not carried one yet.
			NO_ARGS,
			undefined,
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(
						drawToolView(lineView(textSearchToolView.renderCall(args ?? NO_ARGS, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						textSearchOracle.textSearchRenderer.renderCall(args ?? NO_ARGS, options, theme),
						width,
					);
					expect(unpad(oracle)).toEqual(drawn);
				}
			}
		}
		// The pad is real in one arm and absent in the other, so the cell above is not comparing two
		// unpadded rows.
		const padded = renderCompLines(
			textSearchOracle.textSearchRenderer.renderCall({ input: "needle" }, HOST_COLLAPSED, theme),
			200,
		);
		expect(padded[0]!.startsWith(" ")).toBe(true);
		const flush = renderCompLines(
			drawToolView(lineView(textSearchToolView.renderCall({ input: "needle" }, COLLAPSED)), theme),
			200,
		);
		expect(flush[0]!.startsWith(" ")).toBe(false);
		// Anti-vacuity: the row carries the tool's title, the pattern, and each narrowing the call
		// asked for, and a call with no pattern still says it is a search.
		const narrowed = stripVTControlCharacters(
			renderCompLines(
				drawToolView(
					lineView(
						textSearchToolView.renderCall(
							{ input: "needle", path: "src", case: false, gitignore: false, skip: 2 },
							COLLAPSED,
						),
					),
					theme,
				),
				200,
			).join(""),
		);
		expect(narrowed).toContain("Search text: needle");
		expect(narrowed).toContain("in src");
		expect(narrowed).toContain("case:insensitive");
		expect(narrowed).toContain("gitignore:false");
		expect(narrowed).toContain("skip:2");
		const bare = stripVTControlCharacters(
			renderCompLines(drawToolView(lineView(textSearchToolView.renderCall(NO_ARGS, COLLAPSED)), theme), 200).join(""),
		);
		expect(bare).toContain("Search text: ?");
		expect(bare).not.toContain("skip:");
	});

	it("exception cell: names a failure in main's words, one column left of them", () => {
		const failures: TextSearchViewResult[] = [
			{ content: [{ type: "text", text: "regex refused to compile" }], isError: true },
			{ content: [], details: { error: "bad pattern" } },
			// A failure the tool reported with neither a message nor details: both arms name it.
			{ content: [], isError: true },
			// Both channels at once: the details win in both arms.
			{ content: [{ type: "text", text: "content text" }], details: { error: "details error" }, isError: true },
		];
		for (const value of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "needle" }, width))).toEqual(
						viewLines(value, context, { input: "needle" }, width),
					);
				}
			}
		}
		// Anti-vacuity: the row says which failure it was, and the details beat the content text
		// rather than being appended to it.
		const drawn = viewLines(failures[3]!, COLLAPSED, { input: "needle" }, 200);
		expect(drawn[0]).toContain(theme.fg("error", "Error: details error"));
		expect(stripVTControlCharacters(drawn.join(""))).not.toContain("content text");
		expect(stripVTControlCharacters(viewLines(failures[2]!, COLLAPSED, { input: "x" }, 200).join(""))).toContain(
			"Unknown error",
		);
	});

	it("exception cell: states a text-only empty answer where main stated it", () => {
		const empties: TextSearchViewResult[] = [
			{ content: [{ type: "text", text: "No matches found" }] },
			{ content: [{ type: "text", text: "" }] },
			{ content: [] },
			{ content: [{ type: "text", text: "" }], details: { displayContent: "No matches found" } },
		];
		for (const value of empties) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(unpad(oracleLines(value, options, { input: "needle" }, width))).toEqual(
						viewLines(value, context, { input: "needle" }, width),
					);
				}
			}
		}
		// Anti-vacuity: one row, the warning mark, and the words main wrote.
		const drawn = viewLines(empties[0]!, COLLAPSED, { input: "needle" }, 200);
		expect(drawn).toHaveLength(1);
		expect(drawn[0]).toContain(theme.fg("muted", "No matches found"));
	});

	it("lists the lines of a text-only result byte for byte inside the rail the host quiets", () => {
		const lines = Array.from({ length: 12 }, (_unused, index) => `hit ${index}\tafter a tab`);
		const value: TextSearchViewResult = { content: [{ type: "text", text: lines.join("\n") }] };
		const args: TextSearchRenderArgs = { input: "hit" };
		for (const width of [200, WIDTH, 40]) {
			// Expanded holds nothing back, so every row of the body is compared.
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
			// Collapsed shows the same rows and holds the same count back; only the note differs.
			const drawn = withoutFramePad(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Exception: main wrote the count with no gesture; the host writes the same count in the
			// same dim and offers the expand hint it offers on every other card.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 7 more items"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 7 more items"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(stripVTControlCharacters(oracle.at(-1) ?? "")).not.toContain("expand");
		}
		// The rail is the block's default in one arm and the host's quiet edge in the other.
		expect(oracleLines(value, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("dim", rail()));
		expect(viewLines(value, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row counts the rows, the collapsed body reserves one of its six for
		// the note, the tab is spaces rather than a hole, and expanding reveals the rest.
		const collapsed = viewLines(value, COLLAPSED, args, 200);
		expect(stripVTControlCharacters(collapsed[0] ?? "")).toContain("12 items");
		expect(collapsed).toHaveLength(COLLAPSED_TEXT_LIMIT + 1);
		expect(stripVTControlCharacters(collapsed[1] ?? "")).toContain("hit 0");
		expect(stripVTControlCharacters(collapsed[1] ?? "")).toContain("after a tab");
		expect(collapsed[1]).not.toContain("\t");
		expect(stripVTControlCharacters(collapsed.join("\n"))).not.toContain("hit 5");
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("hit 11");
		expect(expanded).not.toContain("more items");
	});

	it("draws the grouped body of a detailed result byte for byte, rail apart", () => {
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH, 40]) {
				expect(quietRail(oracleLines(value, options, args, width))).toEqual(viewLines(value, context, args, width));
			}
		}
		// Anti-vacuity: the head row counts matches and files and states the scope; the collapsed card
		// keeps the headers and the marked lines and drops the context around them, which is what the
		// expanded card carries.
		const expanded = stripVTControlCharacters(viewLines(value, EXPANDED, args, 200).join("\n"));
		expect(expanded).toContain("2 matches");
		expect(expanded).toContain("2 files");
		expect(expanded).toContain("in src");
		expect(expanded).toContain("const before = 1;");
		const collapsed = stripVTControlCharacters(viewLines(value, COLLAPSED, args, 200).join("\n"));
		expect(collapsed).toContain("const needle = true;");
		expect(collapsed).not.toContain("const before = 1;");
		// A nested file header is dimmed and a directory header accented, and a body row is indented
		// under the header that opened its group.
		const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(rows[0]?.[0]).toMatchObject({ text: "# src/", tone: "accent" });
		expect(rows[1]?.[0]).toMatchObject({ text: "  " });
		expect(rows[1]?.[1]).toMatchObject({ text: "## a.ts", tone: "dim" });
	});

	it("holds groups back in the unit the search was asked for, closing the card with the gesture", () => {
		// Nine groups of two rows each: twice the collapsed budget, so the card holds groups back.
		const groups = Array.from({ length: 9 }, (_unused, index) =>
			[`## f${index}.ts`, `*${index + 1}│const needle = ${index};`].join("\n"),
		);
		const value = detailed({ matchCount: 9, fileCount: 9, cwd: "/repo", displayContent: groups.join("\n\n") });
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(value, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(value, HOST_COLLAPSED, args, width)));
			expect(drawn).toHaveLength(oracle.length);
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 7 more matches"));
			expect(oracle.at(-1)).toContain(theme.fg("dim", "… 7 more matches"));
			expect(drawn.at(-1)).toContain(formatExpandHint(theme, false, true));
			expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
				viewLines(value, EXPANDED, args, width),
			);
		}
		// A paths-only search counts what it held back in files, because its rows are files.
		const pathsOnly = detailed({
			matchCount: 25,
			fileCount: 25,
			pathsOnly: true,
			cwd: "/repo",
			displayContent: Array.from({ length: 25 }, (_unused, index) => `## mod-${index}.ts`).join("\n\n"),
		});
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(pathsOnly, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(pathsOnly, HOST_COLLAPSED, args, width)));
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			// Every row of a paths-only body is a header, so the search marked no match line and none
			// of the rows shown counts against the total: the note names all 25 files.
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 25 more files"));
		}
		const flat = stripVTControlCharacters(viewLines(pathsOnly, COLLAPSED, args, 200).join("\n"));
		expect(flat).toContain("more files");
		expect(flat).not.toContain("more matches");
		// Output the search marked no match line in at all: the note counts rows, since the head
		// row's own count cannot be apportioned between what is shown and what is not.
		const unmarked = detailed({
			matchCount: 40,
			fileCount: 1,
			cwd: "/repo",
			displayContent: Array.from({ length: 40 }, (_unused, index) => ` ${index + 1}│const x = ${index};`).join("\n"),
		});
		for (const width of [200, WIDTH]) {
			const drawn = withoutFramePad(viewLines(unmarked, COLLAPSED, args, width));
			const oracle = withoutFramePad(quietRail(oracleLines(unmarked, HOST_COLLAPSED, args, width)));
			expect(drawn.slice(0, -1)).toEqual(oracle.slice(0, -1));
			expect(drawn.at(-1)).toContain(theme.fg("dim", "… 35 more matches"));
		}
		// The note about a path the search never reached takes a row out of the budget before the
		// groups are measured against it, in both arms.
		const withMissing = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			missingPaths: ["gone/"],
		});
		expect(viewLines(withMissing, COLLAPSED, args, 200)).toEqual(
			quietRail(oracleLines(withMissing, HOST_COLLAPSED, args, 200)),
		);
		expect(viewLines(withMissing, COLLAPSED, args, 200).at(-1)).toContain(
			theme.fg("warning", "skipped missing: gone/"),
		);
	});

	it("exception cell: an empty detailed answer indents its rows under the head row it kept", () => {
		const cases: Array<{ details: Partial<TextSearchDetails>; args: TextSearchRenderArgs | undefined }> = [
			{ details: {}, args: { input: "needle" } },
			{ details: {}, args: undefined },
			{ details: {}, args: { input: "" } },
			{ details: { scopePath: "src", searchPath: "/repo/src" }, args: { input: "needle" } },
			{ details: { scopePath: "src" }, args: { input: "needle" } },
			{ details: { missingPaths: ["gone/"] }, args: { input: "needle" } },
			{ details: { missingPaths: ["a/", "b/"], scopePath: "src" }, args: { input: "needle" } },
		];
		for (const { details, args } of cases) {
			const value = detailed({ ...details, fileCount: details.fileCount ?? 1 });
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					const drawn = withoutEmptyRuns(viewLines(value, context, args, width));
					const oracle = withoutEmptyRuns(unpad(oracleLines(value, options, args, width)));
					expect(drawn).toHaveLength(oracle.length);
					// The head row is the same row one column left. Every row under it is the same row
					// indented two columns under that head, where main left it in column zero behind
					// the runs its single `Text` had closed.
					expect(drawn[0]).toBe(oracle[0]);
					for (let row = 1; row < oracle.length; row++) expect(drawn[row]).toBe(`  ${oracle[row]}`);
				}
			}
		}
		// Anti-vacuity: the card says it found nothing, counts zero, and says separately what it never
		// reached.
		const missing = viewLines(detailed({ fileCount: 1, missingPaths: ["gone/"] }), COLLAPSED, { input: "x" }, 200);
		const flat = stripVTControlCharacters(missing.join("\n"));
		expect(flat).toContain("0 matches");
		expect(flat).toContain("No matches found");
		expect(missing.at(-1)).toContain(theme.fg("warning", "skipped missing: gone/"));
	});

	it("says on the rows what a truncated search cut, leaving the rail quiet", () => {
		const cut = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			truncated: true,
			missingPaths: ["gone/"],
		});
		const byColumn = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			displayContent: GROUPED,
			// A column cut states the column it cut at, which is the shape `OutputMeta` records.
			meta: { limits: { columnTruncated: { maxColumn: 200 } } } as TextSearchDetails["meta"],
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		for (const value of [cut, byColumn]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH] as const) {
					// Main painted the whole rail in warning because the block derives its edge from
					// the state. The host keeps the quiet edge and the card states the outcome in the
					// words on its rows, which are byte-identical.
					expect(quietRail(oracleLines(value, options, args, width), "warning")).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		expect(oracleLines(cut, HOST_EXPANDED, args, 200)[0]).toContain(theme.fg("warning", rail()));
		expect(viewLines(cut, EXPANDED, args, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		// Anti-vacuity: the head row marks the truncation once, and the card still names the path it
		// never reached.
		const drawn = viewLines(cut, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("truncated");
		expect(drawn.filter(row => row.includes(theme.fg("warning", "skipped missing: gone/")))).toHaveLength(1);
		// The state is the card's own claim rather than a colour: on this preset a warning frame and a
		// success frame draw the same quiet rail, so a host that reads the view is the only reader
		// that can tell them apart.
		expect(framedView(textSearchToolView.renderResult(cut, EXPANDED, args)).state).toBe("warning");
		expect(
			framedView(
				textSearchToolView.renderResult(
					detailed({ matchCount: 1, fileCount: 1, cwd: "/repo", displayContent: GROUPED }),
					EXPANDED,
					args,
				),
			).state,
		).toBe("success");
	});

	it("states for a second host what each row of a search points at, and opens the same links", () => {
		const value = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		const args: TextSearchRenderArgs = { input: "needle" };
		const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
		// A body row names the file AND the line inside it, which is what makes it a position rather
		// than a document: a row that carried the file alone would send a reader to line one.
		const body = rows.find(row =>
			row
				.map(span => span.text)
				.join("")
				.includes("needle"),
		);
		expect(body?.at(-1)).toMatchObject({ file: "/repo/src/a.ts", fileLine: 12, tone: "output" });
		expect(rows[0]?.[0]).toMatchObject({ file: "/repo/src" });
		// A url header names its target as a link rather than as a path, stripped of the `##` and of
		// the count the tool appended.
		const urlValue = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## https://example.com/page (1 match)", "*3│const needle = true;"].join("\n"),
		});
		const urlRows = framedView(textSearchToolView.renderResult(urlValue, EXPANDED, args)).sections[0]?.lines ?? [];
		expect(urlRows[0]?.[0]).toMatchObject({ link: "https://example.com/page", tone: "accent" });
		expect(urlRows[0]?.[0]?.file).toBeUndefined();
		// With hyperlinks on, the rows carry the OSC 8 targets main's own body carried, line and all.
		settings.override("tui.hyperlinks", "always");
		try {
			for (const width of [200, WIDTH]) {
				for (const shape of [value, urlValue]) {
					expect(quietRail(oracleLines(shape, HOST_EXPANDED, args, width))).toEqual(
						viewLines(shape, EXPANDED, args, width),
					);
				}
			}
			const drawn = viewLines(value, EXPANDED, args, 200);
			expect(drawn.some(row => row.includes("line=12"))).toBe(true);
			expect(viewLines(urlValue, EXPANDED, args, 200)[1]).toContain("https://example.com/page");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("frames a result the tool counted on one axis alone, as main framed it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		// Main framed the detailed card when EITHER count arrived and read the missing one as zero, so
		// a result carrying matches alone is the grouped card and one carrying files alone is the empty
		// card. Neither is the text-only card, which is what a card reads a result with no count at all
		// as, and which nothing else here distinguishes from a result counted on one axis.
		const withMatches: TextSearchViewResult = {
			content: [{ type: "text", text: GROUPED }],
			details: { matchCount: 2, cwd: "/repo" },
		};
		const withFiles: TextSearchViewResult = {
			content: [{ type: "text", text: GROUPED }],
			details: { fileCount: 2, cwd: "/repo" },
		};
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH] as const) {
				expect(quietRail(oracleLines(withMatches, options, args, width))).toEqual(
					viewLines(withMatches, context, args, width),
				);
				// A count on the file axis alone is zero matches, which is the empty card: the head row
				// one column left, and every row under it two columns in.
				const drawn = withoutEmptyRuns(viewLines(withFiles, context, args, width));
				const oracle = withoutEmptyRuns(unpad(oracleLines(withFiles, options, args, width)));
				expect(drawn).toHaveLength(oracle.length);
				expect(drawn[0]).toBe(oracle[0]);
				for (let row = 1; row < oracle.length; row++) expect(drawn[row]).toBe(`  ${oracle[row]}`);
			}
		}
		// Anti-vacuity: each card states the axis it was given and zero for the one it was not, and
		// neither is the text-only card, whose head row counts its rows as items.
		const matches = stripVTControlCharacters(viewLines(withMatches, EXPANDED, args, 200).join("\n"));
		expect(matches).toContain("2 matches");
		expect(matches).toContain("0 files");
		expect(matches).not.toContain("items");
		const files = stripVTControlCharacters(viewLines(withFiles, EXPANDED, args, 200).join("\n"));
		expect(files).toContain("0 matches");
		expect(files).toContain("No matches found");
		expect(files).not.toContain("items");
	});

	it("expands a tab and cuts a row too long for the frame where main cut it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const tabbed = detailed({
			matchCount: 2,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", "*12│const needle =\tfalse;", "*13│const other =\t3;"].join("\n"),
		});
		const long = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## a.ts", `*12│const needle = "${"x".repeat(300)}";`].join("\n"),
		});
		for (const value of [tabbed, long]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40] as const) {
					expect(quietRail(oracleLines(value, options, args, width))).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		// Anti-vacuity: a tab is spaces rather than a hole in the row.
		const drawnTabs = viewLines(tabbed, EXPANDED, args, 200);
		expect(drawnTabs.join("")).not.toContain("\t");
		expect(stripVTControlCharacters(drawnTabs.join("\n"))).toContain(replaceTabs("const needle =\tfalse;"));
		// And a row wider than the frame ends at the frame rather than wrapping onto a second row: the
		// card is its header, the group's header, and one body row.
		const cut = viewLines(long, EXPANDED, args, 40);
		expect(cut).toHaveLength(3);
		for (const row of cut) expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(40);
		expect(stripVTControlCharacters(cut.join("\n"))).not.toContain("x".repeat(300));
	});

	it("lists the rows main listed of a text-only result, blanks dropped and long rows cut", () => {
		const args: TextSearchRenderArgs = { input: "hit" };
		const spaced: TextSearchViewResult = {
			content: [{ type: "text", text: ["first hit", "", "   ", "second hit", "", "third hit"].join("\n") }],
		};
		const long: TextSearchViewResult = { content: [{ type: "text", text: `hit ${"y".repeat(300)}` }] };
		for (const value of [spaced, long]) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40] as const) {
					expect(quietRail(oracleLines(value, options, args, width))).toEqual(
						viewLines(value, context, args, width),
					);
				}
			}
		}
		// Anti-vacuity: a blank line is not a row, so the card counts three and draws three under its
		// head row.
		const drawn = viewLines(spaced, EXPANDED, args, 200);
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("3 items");
		expect(drawn).toHaveLength(4);
		// And a row wider than the frame ends at the frame.
		const cut = viewLines(long, EXPANDED, args, 40);
		expect(cut).toHaveLength(2);
		for (const row of cut) expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(40);
	});

	it("apportions what it holds back the way main apportioned it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		// Marked matches with the context around them, expanded: the note counts the marks rather than
		// the rows they sit among, so a card showing six of nine marks holds three back.
		const withContext = detailed({
			matchCount: 9,
			fileCount: 9,
			cwd: "/repo",
			displayContent: Array.from({ length: 9 }, (_unused, index) =>
				[
					`## f${index}.ts`,
					` ${index + 1}│const before = 0;`,
					`*${index + 2}│const needle = ${index};`,
					` ${index + 3}│const after = 0;`,
				].join("\n"),
			).join("\n\n"),
		});
		// Every row but the note is byte-identical, and the note differs by the gesture alone
		// (exception 35), so the count itself is compared with the gesture dropped.
		expect(withoutFramePad(quietRail(oracleLines(withContext, HOST_EXPANDED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(withContext, EXPANDED, args, 200))),
		);
		expect(viewLines(withContext, EXPANDED, args, 200)).toHaveLength(EXPANDED_TEXT_LIMIT + 1);
		expect(viewLines(withContext, EXPANDED, args, 200).at(-1)).toContain(theme.fg("dim", "… 3 more matches"));
		// The note about a path the search never reached costs the body a row before the groups are
		// measured against it, so the card draws one group's row fewer than it would without it.
		const missing = detailed({
			matchCount: 9,
			fileCount: 9,
			cwd: "/repo",
			displayContent: Array.from({ length: 9 }, (_unused, index) =>
				[`## f${index}.ts`, `*${index + 1}│const needle = ${index};`].join("\n"),
			).join("\n\n"),
			missingPaths: ["gone/"],
		});
		expect(withoutFramePad(quietRail(oracleLines(missing, HOST_COLLAPSED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(missing, COLLAPSED, args, 200))),
		);
		const missingRows = viewLines(missing, COLLAPSED, args, 200);
		// Head row, two whole groups, the held-back note, and the path it never reached.
		expect(missingRows).toHaveLength(7);
		expect(missingRows.at(-2)).toContain(theme.fg("dim", "… 7 more matches"));
		expect(missingRows.at(-1)).toContain(theme.fg("warning", "skipped missing: gone/"));
		// A paths-only search apportions its FILE count: the matches it also counted are on lines this
		// card never draws, so counting them would name rows that do not exist.
		const pathsOnly = detailed({
			matchCount: 60,
			fileCount: 25,
			pathsOnly: true,
			cwd: "/repo",
			displayContent: Array.from({ length: 25 }, (_unused, index) => `## mod-${index}.ts`).join("\n\n"),
		});
		expect(withoutFramePad(quietRail(oracleLines(pathsOnly, HOST_COLLAPSED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(pathsOnly, COLLAPSED, args, 200))),
		);
		expect(viewLines(pathsOnly, COLLAPSED, args, 200).at(-1)).toContain(theme.fg("dim", "… 25 more files"));
		// Every match the head row counted is already on a row the card drew and what is left over is
		// headers, so the note counts rows: a match count cannot say what those headers are.
		const headers = detailed({
			matchCount: 1,
			fileCount: 31,
			cwd: "/repo",
			displayContent: [
				["## a.ts", " 1│const needle = 1;"].join("\n"),
				...Array.from({ length: 30 }, (_unused, index) => `## f${index}.ts`),
			].join("\n\n"),
		});
		expect(withoutFramePad(quietRail(oracleLines(headers, HOST_EXPANDED, args, 200)))).toEqual(
			withoutFramePad(withoutExpandHint(viewLines(headers, EXPANDED, args, 200))),
		);
		expect(viewLines(headers, EXPANDED, args, 200).at(-1)).toContain(theme.fg("dim", "… 9 more lines"));
	});

	it("links the scope on the head row to the path the search ran in", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const scoped = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			searchPath: "/repo/src",
			displayContent: GROUPED,
		});
		// The same scope from a result that never carried the absolute path: the words are the scope's
		// own either way, and only one of them opens anything.
		const unresolvable = detailed({
			matchCount: 2,
			fileCount: 2,
			cwd: "/repo",
			scopePath: "src",
			displayContent: GROUPED,
		});
		settings.override("tui.hyperlinks", "always");
		try {
			for (const value of [scoped, unresolvable]) {
				for (const width of [200, WIDTH] as const) {
					expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
						viewLines(value, EXPANDED, args, width),
					);
				}
			}
			const head = viewLines(scoped, EXPANDED, args, 200)[0] ?? "";
			expect(head).toContain("file:///repo/src");
			expect(stripVTControlCharacters(head)).toContain("in src");
			const bare = viewLines(unresolvable, EXPANDED, args, 200)[0] ?? "";
			expect(bare).not.toContain("file:///repo/src");
			expect(stripVTControlCharacters(bare)).toContain("in src");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("resolves an internal address to the path a host opens, and carries it to the rows under it", () => {
		const args: TextSearchRenderArgs = { input: "needle" };
		const value = detailed({
			matchCount: 1,
			fileCount: 1,
			cwd: "/repo",
			displayContent: ["## local://notes.md (1 match)", "*3│const needle = true;"].join("\n"),
		});
		// `local://` is the one scheme a card can resolve without waiting for the tool, and the root it
		// resolves against is the session's, so the cell installs one rather than reaching for a real
		// session. The override is process-global, hence the finally.
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => "/repo/.veyyon/artifacts",
			getSessionId: () => "differential",
		});
		const resolved = "/repo/.veyyon/artifacts/local/notes.md";
		try {
			const rows = framedView(textSearchToolView.renderResult(value, EXPANDED, args)).sections[0]?.lines ?? [];
			expect(rows[0]?.[0]).toMatchObject({ file: resolved, tone: "accent" });
			expect(rows[0]?.[0]?.link).toBeUndefined();
			// The header is the only row that resolved the address, so the row under it learns the path
			// from it: the classifier that resolves paths knows nothing about the scheme.
			expect(rows[1]?.at(-1)).toMatchObject({ file: resolved, fileLine: 3 });
			settings.override("tui.hyperlinks", "always");
			try {
				for (const width of [200, WIDTH] as const) {
					expect(quietRail(oracleLines(value, HOST_EXPANDED, args, width))).toEqual(
						viewLines(value, EXPANDED, args, width),
					);
				}
				const drawn = viewLines(value, EXPANDED, args, 200);
				expect(drawn[1]).toContain(`file://${resolved}`);
				expect(drawn[2]).toContain(`file://${resolved}?line=3`);
			} finally {
				settings.clearOverride("tui.hyperlinks");
			}
		} finally {
			LocalProtocolHandler.resetOverrideForTests();
		}
	});
});
