/**
 * The five vibe cards draw what main's renderer drew.
 *
 * Every arm a director's turn passes through is compared as terminal bytes: the composer as the
 * message is typed and as it settles, the acknowledgement each send became, the kill row, the wall
 * with a worker on air beside a worker whose turn was delivered, the empty wall, and the two
 * fallbacks each of the five tools falls back to. FIVE DIFFERENCES ARE PINNED AS EXCEPTION CELLS
 * rather than waived silently:
 *
 *  - A card's rows sit two columns under the row that heads it, where main drew each worker's header
 *    row and each composer footer at column zero and only indented the rows below one.
 *  - A settled composer and a kill row state the subject after a colon and carry the worker's flavour
 *    as the row's badge, where main built one title string with the badge and the id spliced into it.
 *  - A kill that cancelled a turn says so as the row's metadata, where main parenthesised it inside
 *    the title.
 *  - The composer's caret appears only where a surface repaints, where main's blinked on a still
 *    frame too, because it read an absent spinner frame as frame zero.
 *  - A cut row closes its colour after the ellipsis, where main cut with a hard reset before it.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never calls `execute()`, so nothing here proves which sessions
 * exist, what a send did to a running turn or what a kill ended: `test/tools/vibe.test.ts` owns that,
 * and a `details` shape whose meaning changed would be drawn identically by both arms. Shimmer is
 * `disabled` under the harness settings, which is the shipped default, so the sweep a live worker's
 * name and current tool take is not compared here -- both arms read the same `shimmerEnabled()` and
 * the sweep's phase is wall-clock, so two arms drawn microseconds apart could never be equal bytes.
 * `a-vibe-card-states-the-worker-and-what-it-is-doing.test.ts` owns what the card claims.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import type { VibeScreenSnapshot } from "@veyyon/coding-agent/session/vibe-runtime";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { VibeOp, VibeToolDetails } from "@veyyon/coding-agent/tools/agent/vibe";
import {
	createVibeToolView,
	type VibeRenderArgs,
	type VibeToolResult,
} from "@veyyon/coding-agent/tools/agent/vibe-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { Ellipsis } from "@veyyon/natives";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ToolViewContext } from "@veyyon/view";
import { createVibeToolRenderer } from "../oracles/vibe-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

const OPS = ["spawn", "send", "wait", "kill", "list"] as const;
const WIDTHS = [200, WIDTH, 40];

/** The frames a comparison is taken on: no frame at all, an even one and an odd one. */
const FRAMES = [undefined, 0, 3] as const;

/** A turn that began half a second off a boundary, so both arms format the same elapsed seconds. */
const TURN_AGE_MS = 5500;

/** The escape a theme colour closes with. */
const CLOSE = "\x1b[39m";

/** The columns a card's rows sit in under the row that heads them. */
const BLOCK_INDENT = 2;

function screen(overrides: Partial<VibeScreenSnapshot> = {}): VibeScreenSnapshot {
	return {
		id: "Anna",
		cli: "fast",
		state: "running",
		turns: 1,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: Date.now(),
		...overrides,
	};
}

function context(expanded: boolean, frame?: number): ToolViewContext {
	return { expanded, partial: false, frame };
}

function hostOptions(expanded: boolean, frame?: number): RenderResultOptions {
	return { expanded, isPartial: false, spinnerFrame: frame };
}

function asOracleResult(result: VibeToolResult): {
	content: Array<{ type: string; text?: string }>;
	details?: VibeToolDetails;
	isError?: boolean;
} {
	return result;
}

function viewCall(op: VibeOp, args: VibeRenderArgs, expanded: boolean, frame: number | undefined, width: number) {
	const view = createVibeToolView(op).renderCall(args, context(expanded, frame));
	return renderCompLines(drawToolView(view, theme, frame), width);
}

function oracleCall(op: VibeOp, args: VibeRenderArgs, expanded: boolean, frame: number | undefined, width: number) {
	return renderCompLines(createVibeToolRenderer(op).renderCall(args, hostOptions(expanded, frame), theme), width);
}

function viewResult(
	op: VibeOp,
	result: VibeToolResult,
	args: VibeRenderArgs,
	expanded: boolean,
	frame: number | undefined,
	width: number,
) {
	const view = createVibeToolView(op).renderResult(result, context(expanded, frame), args);
	return renderCompLines(drawToolView(view, theme, frame), width);
}

function oracleResult(
	op: VibeOp,
	result: VibeToolResult,
	args: VibeRenderArgs,
	expanded: boolean,
	frame: number | undefined,
	width: number,
) {
	return renderCompLines(
		createVibeToolRenderer(op).renderResult(asOracleResult(result), hostOptions(expanded, frame), theme, args),
		width,
	);
}

/** The three row layouts a vibe card takes: one row, the composer, or the wall. */
type CardShape = "row" | "composer" | "wall";

/** A width no fixture reaches, so a render at it is the card before any cut. */
const UNCUT = 400;

function indent(row: string): string {
	return `${" ".repeat(BLOCK_INDENT)}${row}`;
}

/**
 * The oracle's rows as a headed block lays them out.
 *
 * Three host policies move a row, and each is applied to the oracle rather than waived:
 *
 *  - The block heads its rows and cuts that header without an ellipsis, because it composed the row
 *    to fit; main cut the whole card's rows alike, ellipsis and all. The oracle's header is therefore
 *    re-cut from an uncut render with the host's own policy.
 *  - Every row the block holds sits at the block's indent. Main already indented a composer's message
 *    rows and a worker's body rows two columns, so those rows land where the host puts them; a
 *    worker's header row and the composer's footer sat at column zero and move right by two.
 *  - A row the host indents has two columns less room for its text, so a row that moves is taken from
 *    a render two columns narrower. The comparison stays byte for byte instead of becoming a
 *    comparison of trimmed prefixes.
 */
function asHostRows(shape: CardShape, renderAt: (width: number) => string[], width: number): string[] {
	if (shape === "row") return renderAt(width);
	const head = truncateToWidth(renderAt(UNCUT)[0] ?? "", width, Ellipsis.Omit);
	if (shape === "wall")
		return [
			head,
			...renderAt(width - BLOCK_INDENT)
				.slice(1)
				.map(indent),
		];
	const own = renderAt(width);
	const footer = renderAt(width - BLOCK_INDENT).at(-1) ?? "";
	return [head, ...own.slice(1, -1), indent(footer)];
}

/**
 * The oracle's cut rows closed the way the host closes them.
 *
 * `truncateToWidth` ends a cut row with a hard reset before the ellipsis (`ESC[0m…`), which drops
 * every open attribute rather than the one colour the row opened; the host cuts the span's text, so
 * the ellipsis draws inside the row's colour and the colour closes after it. Every column before the
 * cut is still compared byte for byte.
 */
function closedAfterCut(rows: readonly string[]): string[] {
	return rows.map(row => (row.endsWith("\x1b[0m…") ? `${row.slice(0, -"\x1b[0m…".length)}…\x1b[39m` : row));
}

/**
 * The oracle's composer marks as runs of their own.
 *
 * Main appended the caret and the cut-message ellipsis to the message's own text, inside the colour
 * the message was drawn in; both are marks about the composer rather than words of the message, so
 * each is a span of its own and closes the message's colour before opening its own.
 */
function marksAsOwnRuns(rows: readonly string[]): string[] {
	const caret = theme.fg("accent", "▌");
	const cut = theme.fg("toolOutput", "…");
	return rows.map(row =>
		row.endsWith(`${caret}${CLOSE}`)
			? `${row.slice(0, -`${caret}${CLOSE}`.length)}${CLOSE}${caret}`
			: row.endsWith(` …${CLOSE}`)
				? `${row.slice(0, -` …${CLOSE}`.length)}${CLOSE} ${cut}`
				: row,
	);
}

/** Every call arm of one operation, at every width, disclosure state and frame. */
function compareCall(
	op: VibeOp,
	args: VibeRenderArgs,
	options: { shape: CardShape; frames?: readonly (number | undefined)[] },
): void {
	for (const width of WIDTHS) {
		for (const expanded of [false, true]) {
			for (const frame of options.frames ?? FRAMES) {
				const view = viewCall(op, args, expanded, frame, width);
				const oracle = asHostRows(
					options.shape,
					at => marksAsOwnRuns(oracleCall(op, args, expanded, frame, at)),
					width,
				);
				expect(view).toEqual(closedAfterCut(oracle));
			}
		}
	}
}

/**
 * Every result arm of one operation, at every width, disclosure state and frame.
 *
 * `headerPinnedElsewhere` names the cards whose header row states its subject after a colon, which is
 * the grammar difference the exception cell below asserts on both arms: the row is taken from the view
 * so the comparison covers every row beneath it rather than stopping at the first difference.
 */
function compareResult(
	op: VibeOp,
	result: VibeToolResult,
	args: VibeRenderArgs,
	options: { shape: CardShape; headerPinnedElsewhere?: boolean } = { shape: "wall" },
): void {
	for (const width of WIDTHS) {
		for (const expanded of [false, true]) {
			for (const frame of FRAMES) {
				const view = viewResult(op, result, args, expanded, frame, width);
				const oracle = asHostRows(
					options.shape,
					at => marksAsOwnRuns(oracleResult(op, result, args, expanded, frame, at)),
					width,
				);
				if (options.headerPinnedElsewhere === true && view.length > 0) oracle[0] = view[0] as string;
				expect(view).toEqual(closedAfterCut(oracle));
			}
		}
	}
}

const LONG_PROMPT = [
	"Build the widget, and keep going until every test in the suite passes without a single retry.",
	"Then write the docs.",
	"Then review it.",
	"Then ship it.",
	"Then tell me.",
	"Then rest.",
	"Then start the next one.",
].join("\n");

describe("vibe tool differential", () => {
	it("types the composer the same way for a spawn and for a send", () => {
		// Even frames only: the caret's still-frame difference is the exception cell below.
		const frames = [0, 4] as const;
		compareCall(
			"spawn",
			{ cli: "fast", prompt: "Build the widget.\nThen test it.", name: "Anna" },
			{ shape: "composer", frames },
		);
		compareCall("send", { session: "Anna", message: "Focus on the API first." }, { shape: "composer", frames });
		compareCall("spawn", { cli: "good", prompt: LONG_PROMPT }, { shape: "composer", frames });
		compareCall("spawn", { cli: "fast" }, { shape: "composer", frames });
		compareCall("send", {}, { shape: "composer", frames });
		compareCall("send", { session: "Anna", message: "   \n\nFocus.\n" }, { shape: "composer", frames });

		// Odd frames carry no caret in either arm, so those compare across every width unchanged.
		compareCall("spawn", { cli: "fast", prompt: "Build the widget." }, { shape: "composer", frames: [1, 7] });
		compareCall("send", { session: "Anna", message: LONG_PROMPT }, { shape: "composer", frames: [1, 7] });
		// A call whose arguments have not arrived yet, and names long enough to reach the width each
		// title cuts its subject to.
		compareCall("spawn", {}, { shape: "composer", frames: [1] });
		compareCall("spawn", { prompt: "Build it." }, { shape: "composer", frames: [1] });
		compareCall(
			"send",
			{ session: `Anna-${"long".repeat(20)}`, message: "Focus." },
			{ shape: "composer", frames: [1] },
		);
		compareCall(
			"spawn",
			{ cli: "fast", name: `Worker-${"long".repeat(20)}`, prompt: "Build it." },
			{ shape: "composer", frames: [1] },
		);
	});

	it("states the pending wall and the pending kill the same way", () => {
		compareCall("wait", { sessions: ["Anna", "Bob"] }, { shape: "row" });
		compareCall("wait", { sessions: Array.from({ length: 12 }, (_, index) => `Worker-${index}`) }, { shape: "row" });
		compareCall("wait", {}, { shape: "row" });
		compareCall("list", {}, { shape: "row" });
		compareCall("kill", { session: "Anna" }, { shape: "row" });
		compareCall("kill", {}, { shape: "row" });
	});

	it("settles the composer on the acknowledgement each op returns", () => {
		for (const mode of ["steered", "queued", "turn"] as const) {
			const result: VibeToolResult = {
				content: [{ type: "text", text: "sent" }],
				details: {
					op: "send",
					screens: [screen()],
					send: { id: "Anna", mode, ...(mode === "turn" ? { jobId: "Anna-t2" } : {}) },
				},
			};
			// The header row is the pinned grammar difference below; every row beneath it is compared here.
			compareResult(
				"send",
				result,
				{ session: "Anna", message: LONG_PROMPT },
				{
					shape: "composer",
					headerPinnedElsewhere: true,
				},
			);
			compareResult(
				"send",
				result,
				{ session: "Anna", message: "Focus." },
				{
					shape: "composer",
					headerPinnedElsewhere: true,
				},
			);
		}
		compareResult(
			"spawn",
			{
				content: [{ type: "text", text: "spawned" }],
				details: { op: "spawn", screens: [], spawned: { id: "Anna", cli: "fast", jobId: "Anna-t1" } },
			},
			{ cli: "fast", prompt: LONG_PROMPT },
			{ shape: "composer", headerPinnedElsewhere: true },
		);
		compareResult(
			"spawn",
			{ content: [{ type: "text", text: "spawned" }], details: { op: "spawn", screens: [] } },
			{ cli: "good", prompt: "Build it." },
			{ shape: "composer", headerPinnedElsewhere: true },
		);
	});

	it("stacks the wall the same way, on air and settled", () => {
		const screens = [
			screen({
				id: "Anna",
				turnStartedAt: Date.now() - TURN_AGE_MS,
				turnMessage: "Build the widget, and keep going until the suite is green",
				trace: ["read(src/a.ts)", "bash(bun test)", "edit(src/b.ts)", "read(src/c.ts)"],
				currentTool: "edit",
				lastIntent: "Fixing the parser",
				outputTail: ["first", "", "third", "", "fifth"],
				model: "prov/fast-model",
				queued: 2,
			}),
			screen({ id: "Bob", cli: "good", state: "idle", turns: 2, lastActivity: "turn 2 completed" }),
			screen({
				id: "Cid",
				cli: "good",
				state: "starting",
				turns: 0,
				lastIntent: "booting",
				currentTool: "bash",
				currentToolArgs: "bun install",
			}),
			screen({
				id: "Eve",
				cli: "fast",
				state: "running",
				turns: 1,
				lastIntent: "Reading the schema",
				trace: ["read(src/schema.ts)"],
			}),
			screen({ id: "Dee", cli: "fast", state: "dead", turns: 3, lastActivity: "killed" }),
		];
		compareResult(
			"wait",
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens,
					wait: {
						settled: [
							{ id: "Bob", jobId: "Bob-t2", status: "completed" },
							{ id: "Dee", jobId: "Dee-t3", status: "failed" },
						],
						stillRunning: ["Anna"],
						timedOut: false,
					},
				},
			},
			{ sessions: ["Anna", "Bob"] },
		);
		compareResult(
			"wait",
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens,
					wait: {
						settled: [{ id: "Cid", jobId: "Cid-t1", status: "cancelled" }],
						stillRunning: ["Anna"],
						timedOut: true,
						waiting: true,
					},
				},
			},
			{},
		);
		compareResult("list", { content: [{ type: "text", text: "" }], details: { op: "list", screens } }, {});
		compareResult(
			"list",
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "list",
					screens: [
						screen({
							id: "OnlyOne",
							trace: ["a".repeat(200)],
							outputTail: ["b".repeat(200)],
							model: "x".repeat(80),
						}),
					],
				},
			},
			{},
		);
		// Nobody on air, nothing timed out: the wall's own mark is the settled one.
		compareResult(
			"wait",
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: [
						screen({ id: "Bob", state: "idle", turns: 2, lastActivity: "turn 2 completed" }),
						screen({ id: "Dee", state: "dead", turns: 1, lastActivity: "killed" }),
					],
					wait: {
						settled: [{ id: "Bob", jobId: "Bob-t2", status: "completed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
			},
			{ sessions: ["Bob", "Dee"] },
		);
	});

	it("reports an empty wall the same way", () => {
		for (const op of ["wait", "list"] as const) {
			compareResult(
				op,
				{
					content: [{ type: "text", text: "No vibe sessions. Spawn one with vibe_spawn." }],
					details: { op, screens: [] },
				},
				{},
				{ shape: "row" },
			);
			compareResult(op, { content: [], details: { op, screens: [] } }, {}, { shape: "row" });
		}
	});

	it("falls back the same way when a result carries no details, and when it failed", () => {
		for (const op of OPS) {
			for (const result of [
				{ content: [{ type: "text", text: "session Anna is gone" }], isError: true },
				{ content: [{ type: "text", text: "nothing to report" }] },
				{ content: [] },
				{ content: [{ type: "text", text: "" }], isError: true },
			] satisfies VibeToolResult[]) {
				for (const width of WIDTHS) {
					for (const expanded of [false, true]) {
						const view = viewResult(op, result, { session: "Anna", cli: "fast" }, expanded, 0, width);
						// Main drew the header and the body as one `Text`, whose second row opens with the empty
						// colour runs the header's own runs left behind; the host writes the row's colour once.
						const oracle = oracleResult(op, result, { session: "Anna", cli: "fast" }, expanded, 0, width).map(
							row => row.replace(/(?:\x1b\[38;2;\d+;\d+;\d+m\x1b\[39m)+/g, ""),
						);
						expect(view).toEqual(closedAfterCut(oracle));
					}
				}
			}
		}
	});

	describe("pinned differences", () => {
		it("puts a card's rows under the row that heads it", () => {
			const args = { cli: "fast" as const, prompt: "Build the widget." };
			const view = viewCall("spawn", args, false, 1, WIDTH);
			const oracle = oracleCall("spawn", args, false, 1, WIDTH);
			// Main's footer began at column zero; the host's sits at the block's indent.
			expect(oracle[2]?.startsWith(" ")).toBe(false);
			expect(view[2]?.startsWith("  ")).toBe(true);
			expect(view[2]?.trimStart()).toBe(oracle[2]);
		});

		it("states the settled subject after a colon, with the flavour as the row's badge", () => {
			const result: VibeToolResult = {
				content: [{ type: "text", text: "spawned" }],
				details: { op: "spawn", screens: [], spawned: { id: "Anna", cli: "fast", jobId: "Anna-t1" } },
			};
			const args = { cli: "good" as const, name: "requested-name", prompt: "Build the widget." };
			const view = viewResult("spawn", result, args, false, 0, WIDTH)[0] ?? "";
			const oracle = oracleResult("spawn", result, args, false, 0, WIDTH)[0] ?? "";
			// Main spliced the badge between the tool's name and the worker's; the row now states the
			// worker as the title's subject and carries the badge after it.
			expect(oracle.indexOf("⟦fast⟧")).toBeLessThan(oracle.indexOf("Anna"));
			expect(view.indexOf("Anna")).toBeLessThan(view.indexOf("⟦fast⟧"));
			expect(view).toContain("vibe spawn\x1b[39m:");
			expect(oracle).not.toContain(":");
			// Both arms name the worker that was spawned and the flavour it was spawned with, not the
			// name and flavour the call asked for.
			expect(view).toContain(theme.fg("accent", "Anna"));
			expect(view).not.toContain("requested-name");
			expect(oracle).not.toContain("requested-name");
			expect(view).toContain(theme.fg("accent", "⟦fast⟧"));
			expect(view).not.toContain("⟦good⟧");
		});

		it("states the killed worker after a colon, and says a cancelled turn as the row's metadata", () => {
			const result: VibeToolResult = {
				content: [{ type: "text", text: "killed" }],
				details: { op: "kill", screens: [], killed: { id: "Anna-1", cancelledTurn: true } },
			};
			const view = viewResult("kill", result, { session: "anna" }, false, 0, WIDTH)[0] ?? "";
			const oracle = oracleResult("kill", result, { session: "anna" }, false, 0, WIDTH)[0] ?? "";
			// Both arms name the session the runtime killed rather than the argument that asked for it,
			// and both mark the row as a turn that is done.
			expect(view).toContain(theme.fg("accent", "Anna-1"));
			expect(oracle).toContain("Anna-1");
			expect(view).not.toContain("anna\x1b");
			expect(view).toContain(theme.symbol("status.done"));
			expect(oracle).toContain(theme.symbol("status.done"));
			expect(view).toContain("vibe kill\x1b[39m:");
			expect(oracle).toContain("vibe kill Anna-1");
			// The note is the row's own run rather than text inside the title, so it carries the warning
			// tone main could not give it.
			expect(oracle).toContain("(in-flight turn cancelled)");
			expect(view).not.toContain("(in-flight turn cancelled)");
			expect(view).toContain(theme.fg("warning", "in-flight turn cancelled"));
			// A kill that cancelled nothing says nothing.
			const quiet =
				viewResult(
					"kill",
					{
						content: [{ type: "text", text: "killed" }],
						details: { op: "kill", screens: [], killed: { id: "Anna-1", cancelledTurn: false } },
					},
					{ session: "anna" },
					false,
					0,
					WIDTH,
				)[0] ?? "";
			expect(quiet).not.toContain("in-flight turn cancelled");
		});

		/**
		 * Both arms sweep the same rows, and no comparison here can be byte for byte: the sweep's phase
		 * is wall-clock, so two arms drawn microseconds apart differ by construction. Each arm is
		 * therefore asserted against ITS OWN unswept form, which is what the live flag on the row is for.
		 */
		it("sweeps a live worker's name and current tool while shimmer is on", async () => {
			const details: VibeToolDetails = {
				op: "list",
				screens: [screen({ currentTool: "edit", lastIntent: "Fixing the parser" })],
			};
			const result: VibeToolResult = { content: [{ type: "text", text: "" }], details };
			const still = viewResult("list", result, {}, true, 3, WIDTH);
			const oracleStill = oracleResult("list", result, {}, true, 3, WIDTH);
			const stillFrameless = viewResult("list", result, {}, true, undefined, WIDTH);
			const oracleStillFrameless = oracleResult("list", result, {}, true, undefined, WIDTH);
			await settings.set("display.shimmer", "classic");
			try {
				const swept = viewResult("list", result, {}, true, 3, WIDTH);
				const oracleSwept = oracleResult("list", result, {}, true, 3, WIDTH);
				// Row 1 names the worker; row 2 is the tool it is part way through.
				expect(swept[1]).not.toBe(still[1]);
				expect(swept[2]).not.toBe(still[2]);
				expect(oracleSwept[1]).not.toBe(oracleStill[1]);
				expect(oracleSwept[2]).not.toBe(oracleStill[2]);
				// A surface that repaints nothing sweeps nothing, in both arms.
				expect(viewResult("list", result, {}, true, undefined, WIDTH)).toEqual(stillFrameless);
				expect(oracleResult("list", result, {}, true, undefined, WIDTH)).toEqual(oracleStillFrameless);
			} finally {
				await settings.set("display.shimmer", "disabled");
			}
		});

		it("blinks the caret only where a surface repaints", () => {
			const args = { session: "Anna", message: "Focus." };
			// No frame: nothing on this surface animates, so the composer commits without a caret.
			expect(viewCall("send", args, false, undefined, WIDTH).join("\n")).not.toContain("▌");
			expect(oracleCall("send", args, false, undefined, WIDTH).join("\n")).toContain("▌");
			// A frame: both arms blink on the same parity.
			expect(viewCall("send", args, false, 0, WIDTH).join("\n")).toContain("▌");
			expect(oracleCall("send", args, false, 0, WIDTH).join("\n")).toContain("▌");
			expect(viewCall("send", args, false, 1, WIDTH).join("\n")).not.toContain("▌");
			expect(oracleCall("send", args, false, 1, WIDTH).join("\n")).not.toContain("▌");
		});

		it("closes a cut row's colour after the ellipsis", () => {
			const details: VibeToolDetails = {
				op: "list",
				screens: [screen({ trace: ["read(src/a.ts) with an argument list that runs past any terminal"] })],
			};
			const result: VibeToolResult = { content: [{ type: "text", text: "" }], details };
			const view = viewResult("list", result, {}, true, 3, 40);
			const oracle = oracleResult("list", result, {}, true, 3, 40);
			const viewCut = view.find(row => row.includes("…")) ?? "";
			const oracleCut = oracle.find(row => row.includes("…")) ?? "";
			expect(oracleCut.endsWith("\x1b[0m…")).toBe(true);
			expect(viewCut.endsWith("…\x1b[39m")).toBe(true);
		});

		it("ends an over-long fallback line at the margin", () => {
			const result: VibeToolResult = { content: [{ type: "text", text: "gone: ".repeat(60) }], isError: true };
			const view = viewResult("spawn", result, { cli: "fast" }, false, 0, WIDTH);
			const oracle = oracleResult("spawn", result, { cli: "fast" }, false, 0, WIDTH);
			// Main's `Text` wrapped the line over as many rows as it took; a card's row is one row.
			expect(oracle.length).toBeGreaterThan(2);
			expect(view.length).toBe(2);
			expect(view[1]).toContain("…");
		});
	});
});
