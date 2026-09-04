/**
 * The `task` card draws what main's renderer drew, for the call preview, the live tree and the
 * settled one.
 *
 * The rows are compared as terminal bytes -- the tree connectors, the outcome badges, the per-agent
 * counts, the context gauge, the cost, the model badge and the colour the reasoning level is drawn
 * in included. What a subagent row says is the card's whole subject, so this sweeps a pending row, a
 * running row with a tool under it, a retrying row, a done row, a failed row and an aborted row, at
 * both disclosures and frozen.
 *
 * SEVEN DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived in a normalizer:
 *
 *  - THE HEAD ROW STATES ITS TARGET AS THE HOST'S META, `Task deep`, where main wrote its own
 *    punctuation and tone, `Task: deep`. The agent a call names is one fact about the call, which is
 *    what every other card's head row states after its title, so the separator and the colour are the
 *    host's. One column narrower, which every row of that card follows.
 *  - A CALL WHOSE RESULT HAS ARRIVED IS ITS HEAD ROW ALONE. Main kept drawing the brief and the agent
 *    list under the preview while the result card below it drew the same brief and the same agents,
 *    so a one-agent spawn stated its assignment twice. The result card is the one that has the
 *    outcome, so it keeps the body and the preview shrinks to what it still says: that a spawn
 *    happened.
 *  - A CARD THAT IS STILL ARRIVING carries the host's `… (streaming)` row. Main drew nothing, because
 *    the head row's own glyph animated; the host moves the animation off the head row so a live card
 *    cannot pin the native-scrollback commit boundary.
 *  - A REFUSED SPAWN KEEPS THE MUTED RAIL. Main tinted the whole card amber -- the rail, the section
 *    rule and every row's ground. The rail states a failure and nothing else in this host, which is
 *    the reduction `BLOCK_STATES` makes for every converted card; the refusal itself is still amber,
 *    on the head row's mark and on the sentence that states it.
 *  - A META SEPARATOR CARRIES THE META'S OWN TONE. Main wrote the dot between two stats in whatever
 *    ground the row was already in. Same glyph, same spacing, same order, so `sameRow` reduces both
 *    spellings and every stat inside them is compared byte for byte.
 *  - A TREE CONNECTOR CARRIES THE TREE'S TONE. Main drew the `└` of a tool row in the row's ground.
 *    Same glyph in the same column, and `sameRow` reduces both.
 *  - A COLOUR IS NEVER OPENED WITH NOTHING IN IT. Main opened the success colour in front of a done
 *    row's mark and closed it before the glyph, then closed it twice more; the row drew as though it
 *    had never been opened. `sameRow` drops an empty run and collapses a repeated reset on both arms.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Nothing here spawns an agent: what a card CLAIMS about a run is
 * owned by `test/task/*`, and a `TaskToolDetails` shape that changed meaning would be drawn
 * identically by both arms. It compares one theme and one set of ANSI capabilities, and it says
 * nothing about the transcript component around the card -- merging a call with its result, and the
 * streamed argument buffer a preview is decoded from, are the component's. The nested-task rows a
 * subagent's own `task` call contributes are drawn from data another suite proves is extracted.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { taskToolView } from "@veyyon/coding-agent/task/task-view";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@veyyon/coding-agent/task/types";
import { UNICODE_SYMBOLS } from "@veyyon/coding-agent/theme/symbols";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { ToolViewContext } from "@veyyon/view";
import * as taskOracle from "../oracles/task-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

/** What the tool returns once anything has spawned, live or settled. */
interface TaskCardResult {
	content: Array<{ type: string; text?: string }>;
	details?: TaskToolDetails;
	isError?: boolean;
}
/** The run the host wraps a meta separator in, including one the row's right margin cut. */
const VIEW_DOT = /\u001b\[(?!39m)[0-9;]+m( ·(?: |(?=\u001b\[49m)|$))(?:\u001b\[39m)?/g;
/** A colour opened with nothing in it, which draws as though it had never been opened. */
const EMPTY_RUN = /\u001b\[(?!39m)[0-9;]+m(?=\u001b\[39m)/g;
/** A reset in front of the next colour, which the colour after it does anyway. */
const RESET_BEFORE_COLOR = /\u001b\[39m(?=\u001b\[(?!39m)[0-9;]+m)/g;
/** A reset written more than once in a row, which draws as one. */
const REPEATED_RESET = /(?:\u001b\[39m){2,}/g;
/** A tree connector with the run around it, in either arm's tone. */
const CONNECTOR = /\u001b\[[0-9;]+m([└├│])\u001b\[39m/g;
/** The pad between a row's last glyph and the reset that closes it. */
const TRAILING_PAD = / +(?=(?:\u001b\[[0-9;]*m)*$)/;

/** A row with the pinned styling differences reduced, and everything else left as it was drawn. */
const sameRow = (row: string): string =>
	row
		.replace(VIEW_DOT, "$1")
		.replace(CONNECTOR, "$1")
		.replace(EMPTY_RUN, "")
		.replace(RESET_BEFORE_COLOR, "")
		.replace(REPEATED_RESET, "\u001b[39m")
		.replace(TRAILING_PAD, "");
const sameRows = (rows: readonly string[]): string[] => rows.map(sameRow);

/** The rows under the head row, which is the one row the two arms punctuate differently. */
const body = (rows: readonly string[]): string[] => sameRows(rows.slice(1));

/** The host's own row for a card that is still arriving, which main had no equivalent of. */
const STREAMING = "… (streaming)";
const settled = (rows: readonly string[]): string[] =>
	rows.filter(row => !stripVTControlCharacters(row).includes(STREAMING));

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "AuthLoader",
		agent: "deep",
		agentSource: "bundled",
		status: "running",
		task: "Port the credential store.",
		tokens: 1200,
		requests: 3,
		durationMs: 4000,
		cost: 0.12,
		recentTools: [],
		recentOutput: [],
		toolCount: 5,
		contextTokens: 8000,
		contextWindow: 200000,
		...overrides,
	} as AgentProgress;
}

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "AuthLoader",
		agent: "deep",
		agentSource: "bundled",
		task: "Port the credential store.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 5200,
		tokens: 1200,
		requests: 3,
		...overrides,
	} as SingleResult;
}

const details = (overrides: Partial<TaskToolDetails> = {}): TaskToolDetails => ({
	projectAgentsDir: null,
	results: [],
	totalDurationMs: 5200,
	...overrides,
});

describe("task tool differential", () => {
	const CALL: TaskParams = {
		agent: "deep",
		name: "AuthLoader",
		task: "Port the credential store.\nKeep the public API.",
	};

	const BATCH: TaskParams = {
		context: "# Goal\nPort the store.",
		tasks: [
			{ name: "AuthLoader", task: "Port the credential store.", agent: "deep" },
			{ name: "TokenSweep", task: "Sweep the token cache.", agent: "deep", isolated: true },
		],
	};

	/** One live agent part way through a tool, with a settled peer waiting behind it. */
	const LIVE: TaskCardResult = {
		content: [{ type: "text", text: "Running 2 agents..." }],
		details: details({
			progress: [
				progress({
					currentTool: "read",
					currentToolArgs: "src/app.ts",
					lastIntent: "Reading the store",
					recentTools: [{ tool: "search", args: "TODO", endMs: 1_000 }],
					recentOutput: ["found 3 matches", "reading src/app.ts"],
					resolvedModel: "anthropic/claude:high",
				}),
				progress({
					index: 1,
					id: "TokenSweep",
					status: "pending",
					task: "Sweep the token cache.",
					tokens: 0,
					requests: 0,
					durationMs: 0,
					toolCount: 0,
				}),
			],
		}),
	};

	/** One agent that finished and one that failed, which is what a settled batch card draws. */
	const SETTLED: TaskCardResult = {
		content: [{ type: "text", text: "Ran 2 agents" }],
		details: details({
			results: [
				result({ resolvedModel: "anthropic/claude:high", outputPath: "/repo/.veyyon/out/auth.md" }),
				result({
					index: 1,
					id: "TokenSweep",
					task: "Sweep the token cache.",
					exitCode: 1,
					error: "provider refused the request",
					durationMs: 800,
				}),
			],
		}),
	};

	function mainCall(args: TaskParams, context: ToolViewContext): string[] {
		const options: RenderResultOptions = { expanded: context.expanded, isPartial: context.partial === true };
		return renderCompLines(taskOracle.renderCall(args, options, theme), WIDTH);
	}

	function viewCall(args: TaskParams, context: ToolViewContext): string[] {
		return renderCompLines(drawToolView(taskToolView.renderCall(args, context), theme), WIDTH);
	}

	function mainResult(card: TaskCardResult, context: ToolViewContext, args?: TaskParams): string[] {
		const options: RenderResultOptions & { renderContext?: { hasResult?: boolean; frozen?: boolean } } = {
			expanded: context.expanded,
			isPartial: context.partial === true,
			renderContext: { hasResult: context.hasResult, frozen: context.frozen },
		};
		return renderCompLines(taskOracle.renderResult(card, options, theme, args), WIDTH);
	}

	function viewResult(card: TaskCardResult, context: ToolViewContext, args?: TaskParams): string[] {
		return renderCompLines(drawToolView(taskToolView.renderResult(card, context, args), theme), WIDTH);
	}

	it("draws the call preview while the arguments are arriving", () => {
		const context: ToolViewContext = { expanded: false, partial: true };
		expect(body(viewCall(CALL, context))).toEqual(body(mainCall(CALL, context)));
	});

	it("draws the call preview expanded", () => {
		const context: ToolViewContext = { expanded: true, partial: true };
		expect(body(viewCall(CALL, context))).toEqual(body(mainCall(CALL, context)));
	});

	it("draws a batch call preview, head row included", () => {
		const context: ToolViewContext = { expanded: false, partial: true };
		expect(sameRows(viewCall(BATCH, context))).toEqual(sameRows(mainCall(BATCH, context)));
	});

	it("draws an isolated call, which states both the agent and the isolation", () => {
		const args: TaskParams = { ...CALL, isolated: true, cwd: "libs/scanner" };
		const context: ToolViewContext = { expanded: false, partial: true };
		const head = stripVTControlCharacters(viewCall(args, context)[0] ?? "")
			.replace(/^▏ /, "")
			.trimEnd();
		expect(head).toBe("⇶ Task deep · isolated");
		expect(body(viewCall(args, context))).toEqual(body(mainCall(args, context)));
	});

	it("draws a live tree", () => {
		const context: ToolViewContext = { expanded: false, partial: true };
		expect(settled(sameRows(viewResult(LIVE, context, CALL)))).toEqual(sameRows(mainResult(LIVE, context, CALL)));
	});

	it("draws a live tree expanded, with the tools and the output under each agent", () => {
		const context: ToolViewContext = { expanded: true, partial: true };
		expect(settled(sameRows(viewResult(LIVE, context, CALL)))).toEqual(sameRows(mainResult(LIVE, context, CALL)));
	});

	it("draws a frozen live tree, whose rows report inert", () => {
		const context: ToolViewContext = { expanded: false, partial: true, frozen: true };
		expect(settled(sameRows(viewResult(LIVE, context, CALL)))).toEqual(sameRows(mainResult(LIVE, context, CALL)));
	});

	it("draws an agent standing down between provider retries", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "Running 1 agent..." }],
			details: details({
				progress: [
					progress({
						retryState: {
							attempt: 2,
							maxAttempts: 5,
							delayMs: 30_000,
							errorMessage: "429 rate limited",
							startedAtMs: Date.now() - 5_000,
						},
					}),
				],
			}),
		};
		const context: ToolViewContext = { expanded: false, partial: true };
		expect(settled(sameRows(viewResult(card, context, CALL)))).toEqual(sameRows(mainResult(card, context, CALL)));
	});

	it("draws a settled tree", () => {
		const context: ToolViewContext = { expanded: false };
		expect(sameRows(viewResult(SETTLED, context, CALL))).toEqual(sameRows(mainResult(SETTLED, context, CALL)));
	});

	it("draws a settled tree expanded", () => {
		const context: ToolViewContext = { expanded: true };
		expect(sameRows(viewResult(SETTLED, context, CALL))).toEqual(sameRows(mainResult(SETTLED, context, CALL)));
	});

	it("draws an aborted agent", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "Ran 1 agent" }],
			details: details({
				results: [result({ aborted: true, abortReason: "cancelled by the caller", exitCode: 130 })],
			}),
		};
		const context: ToolViewContext = { expanded: false };
		expect(sameRows(viewResult(card, context, CALL))).toEqual(sameRows(mainResult(card, context, CALL)));
	});

	/**
	 * Every reasoning level the glyph registry declares, drawn in that level's own colour.
	 *
	 * Swept from the registry rather than listed, because a level added there is a colour nobody
	 * compared: this turns red the moment one arrives. `high` alone would prove nothing -- the theme
	 * draws it in the same colour as an untoned run's default -- so a level whose colour is its own is
	 * what says the card reads the scale at all.
	 */
	it("draws every reasoning level in that level's own colour", () => {
		const levels = Object.keys(UNICODE_SYMBOLS)
			.filter(key => key.startsWith("thinking.") && key !== "thinking.autoPending")
			.map(key => key.slice("thinking.".length));
		expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		const context: ToolViewContext = { expanded: false };
		for (const level of levels) {
			const card: TaskCardResult = {
				content: [{ type: "text", text: "Ran 1 agent" }],
				details: details({ results: [result({ resolvedModel: `anthropic/claude:${level}` })] }),
			};
			expect(sameRows(viewResult(card, context, CALL))).toEqual(sameRows(mainResult(card, context, CALL)));
		}
	});

	it("draws a background spawn, head row included", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "Started in background" }],
			details: details({ async: { state: "running", jobId: "job_12", type: "task" } }),
		};
		const context: ToolViewContext = { expanded: false };
		expect(sameRows(viewResult(card, context, CALL))).toEqual(sameRows(mainResult(card, context, CALL)));
	});

	it("draws a call that failed before anything spawned", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "task failed: no such agent 'ghost'" }],
			isError: true,
		};
		const context: ToolViewContext = { expanded: false };
		expect(body(viewResult(card, context, CALL))).toEqual(body(mainResult(card, context, CALL)));
	});

	it("draws a refused spawn's sentence", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "Refused" }],
			details: details({ warning: { kind: "homogeneous-triage", message: "every task in the batch is the same" } }),
		};
		const context: ToolViewContext = { expanded: false };
		const view = viewResult(card, context, CALL);
		const main = mainResult(card, context, CALL);
		expect(view.map(row => stripVTControlCharacters(row))).toEqual(main.map(row => stripVTControlCharacters(row)));
	});

	/**
	 * The head row, pinned as bytes on both arms.
	 *
	 * This is the exception every cell above compares around, so it is stated once here rather than
	 * normalized away: main punctuated its own title and drew the agent dim, and the host writes the
	 * same agent as the card's meta in its own muted tone.
	 */
	it("states the agent as the host's meta, where main wrote a colon", () => {
		const context: ToolViewContext = { expanded: false, partial: true };
		expect(mainCall(CALL, context)[0]).toContain(`Task\u001b[39m: ${theme.fg("muted", "deep")}`);
		expect(viewCall(CALL, context)[0]).toContain(`Task\u001b[39m ${theme.fg("dim", "deep")}`);
	});

	/** A call whose result has arrived is its head row alone; main repeated the brief and the agents. */
	it("stops repeating the brief once the result card draws it", () => {
		const context: ToolViewContext = { expanded: false, partial: true, hasResult: true };
		expect(viewCall(CALL, context)).toHaveLength(1);
		expect(stripVTControlCharacters(viewCall(CALL, context)[0] ?? "")).toContain("Task deep");
		expect(
			mainCall(CALL, context)
				.map(row => stripVTControlCharacters(row))
				.join("\n"),
		).toContain("AuthLoader");
	});

	/** The card that is still arriving says so on its own row, which main had no equivalent of. */
	it("carries the host's streaming row while agents are in flight", () => {
		const context: ToolViewContext = { expanded: false, partial: true };
		const rows = viewResult(LIVE, context, CALL).map(row => stripVTControlCharacters(row));
		expect(rows.at(-1)?.trimEnd()).toBe(`▏  ${STREAMING}`);
		expect(mainResult(LIVE, context, CALL).some(row => row.includes(STREAMING))).toBe(false);
	});

	/**
	 * A refusal keeps the muted rail, where main tinted the whole card amber.
	 *
	 * Compared as the rail glyph of every row, so a change that tints one row and not the rest is
	 * caught as well as one that tints none.
	 */
	it("keeps the settled rail under a refusal, where main tinted the card", () => {
		const card: TaskCardResult = {
			content: [{ type: "text", text: "Refused" }],
			details: details({ warning: { kind: "homogeneous-triage", message: "every task in the batch is the same" } }),
		};
		const context: ToolViewContext = { expanded: false };
		const rail = (rows: readonly string[]): string[] => [
			...new Set(rows.map(row => /\u001b\[38;2;[0-9;]+m▏/.exec(row)?.[0] ?? "")),
		];
		const railOf = (color: "borderMuted" | "warning"): string => `${theme.fg(color, "▏").replace("\u001b[39m", "")}`;
		expect(rail(viewResult(card, context, CALL))).toEqual([railOf("borderMuted")]);
		expect(rail(mainResult(card, context, CALL))).toEqual([railOf("warning")]);
	});
});
