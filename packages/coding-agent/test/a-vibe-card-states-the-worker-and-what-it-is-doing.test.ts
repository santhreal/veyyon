/**
 * A vibe card states the worker it is driving and what that worker is doing.
 *
 * WHY THIS SUITE EXISTS. The five vibe tools are the director's whole surface, and their cards are
 * the only place a worker's turn is visible: the composer says what was typed at it, and the wall says
 * which workers are on air, what each is part way through, and which turns have been delivered. All
 * five describe that as a `ToolView`, so the claims below drive the view and hand it to the terminal
 * drawer, which is the path a session takes.
 *
 * THE DEFECT CLASS THIS CLOSES. A card that loses a worker: a wall that drops a screen, a screen that
 * drops the tool it is running, a settled turn with no delivery row, a composer that shows no message
 * or a caret that never blinks, and a row that overruns the columns the host gave it. Each is
 * asserted per operation rather than for the one op that came to mind, and the wall's rows are read
 * back per worker.
 *
 * WHAT IT DOES NOT CATCH. Nothing here executes a tool: which sessions exist, what a send does to a
 * running turn and what a kill cancels are `vibe.ts`'s own contracts. Byte equivalence with the
 * renderer these cards replaced is `test/differential/the-vibe-card-draws-what-main-drew.test.ts`,
 * and how a shimmer sweep looks is the terminal's.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { VibeScreenSnapshot } from "@veyyon/coding-agent/session/vibe-runtime";
import { getThemeByName, setThemeInstance, type Theme } from "@veyyon/coding-agent/theme/theme";
import type { VibeToolDetails } from "@veyyon/coding-agent/tools/agent/vibe";
import { createVibeToolView, type VibeRenderArgs } from "@veyyon/coding-agent/tools/agent/vibe-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

const WIDTH = 100;

let uiTheme: Theme;

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

/** The call card as the terminal draws it, sanitized to the words a reader sees. */
function callRows(
	op: "spawn" | "send" | "wait" | "kill" | "list",
	args: VibeRenderArgs,
	context: { expanded: boolean; frame?: number },
	width = WIDTH,
): string[] {
	const view = createVibeToolView(op).renderCall(args, context);
	return drawToolView(view, uiTheme, context.frame)
		.render(width)
		.map(line => stripAnsi(line).trimEnd());
}

/** The result card as the terminal draws it, sanitized to the words a reader sees. */
function resultRows(
	op: "spawn" | "send" | "wait" | "kill" | "list",
	result: { content: Array<{ type: string; text?: string }>; details?: VibeToolDetails; isError?: boolean },
	args: VibeRenderArgs,
	context: { expanded: boolean; frame?: number },
	width = WIDTH,
): string[] {
	const view = createVibeToolView(op).renderResult(result, context, args);
	return drawToolView(view, uiTheme, context.frame)
		.render(width)
		.map(line => stripAnsi(line).trimEnd());
}

describe("a vibe card states the worker and what it is doing", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("types the message into the composer and blinks the caret with the frame", () => {
		const args = { session: "Anna", message: "Focus on the API first.\nThen tests." };
		const even = callRows("send", args, { expanded: false, frame: 0 }).join("\n");
		expect(even).toContain("vibe send → Anna");
		expect(even).toContain("> Focus on the API first.");
		expect(even).toContain("Then tests.▌");
		expect(even).toContain("delivering…");

		// The caret is the tool's rhythm over the host's clock: an odd frame draws none, and a surface
		// that animates nothing draws none either, so a committed row never keeps a caret.
		expect(callRows("send", args, { expanded: false, frame: 1 }).join("\n")).not.toContain("▌");
		expect(callRows("send", args, { expanded: false }).join("\n")).not.toContain("▌");
	});

	it("holds the composer to two rows collapsed and six expanded, and says a message was cut", () => {
		const message = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
		const collapsed = callRows("spawn", { cli: "fast", prompt: message }, { expanded: false }).join("\n");
		expect(collapsed).toContain("> one");
		expect(collapsed).toContain("two …");
		expect(collapsed).not.toContain("three");

		const expanded = callRows("spawn", { cli: "fast", prompt: message }, { expanded: true }).join("\n");
		expect(expanded).toContain("six …");
		expect(expanded).not.toContain("seven");
	});

	it("states what a send became: steered, queued, or a turn of its own", () => {
		const cases = [
			["steered", "steered into the running turn"],
			["queued", "mid-turn — queued as the next turn"],
			["turn", "turn started (job Anna-t2)"],
		] as const;
		for (const [mode, expected] of cases) {
			const details: VibeToolDetails = {
				op: "send",
				screens: [screen()],
				send: { id: "Anna", mode, ...(mode === "turn" ? { jobId: "Anna-t2" } : {}) },
			};
			const rows = resultRows(
				"send",
				{ content: [{ type: "text", text: "ack" }], details },
				{ session: "Anna", message: "Focus on the API first." },
				{ expanded: false, frame: 0 },
			).join("\n");
			expect(rows).toContain("vibe send");
			expect(rows).toContain("Anna");
			expect(rows).toContain("> Focus on the API first.");
			expect(rows).toContain(expected);
			// An even frame is a frame the composer's caret would blink on, and a delivered message
			// carries none: the row states what the message became, not that it is still being typed.
			expect(rows).not.toContain("▌");
		}
	});

	it("stacks one screen per worker, with the tool each is running and the turns that were delivered", () => {
		const details: VibeToolDetails = {
			op: "wait",
			screens: [
				screen({
					id: "Anna",
					turnStartedAt: Date.now() - 5000,
					turnMessage: "Build the widget",
					trace: ["read(src/foo.ts)", "bash(bun test)"],
					currentTool: "edit",
					lastIntent: "Fixing the parser",
					outputTail: ["The parser now accepts nested arrays"],
					model: "prov/fast-model",
				}),
				screen({ id: "Bob", cli: "good", state: "idle", turns: 2, lastActivity: "turn 2 completed" }),
			],
			wait: {
				settled: [{ id: "Bob", jobId: "Bob-t2", status: "completed" }],
				stillRunning: ["Anna"],
				timedOut: false,
			},
		};
		const rows = resultRows(
			"wait",
			{ content: [{ type: "text", text: "" }], details },
			{ sessions: ["Anna", "Bob"] },
			{
				expanded: true,
				frame: 2,
			},
		);
		const text = rows.join("\n");

		// One header row per worker, in the order the wall lists them, each carrying its flavour badge
		// and the state it reports.
		const headers = rows.filter(line => /(Anna|Bob)\s+(running|completed|idle)/u.test(line));
		expect(headers.length).toBe(2);
		expect(headers[0]).toContain("Anna");
		expect(headers[1]).toContain("Bob");
		expect(headers[0]).toMatch(/fast.\s*Anna/u);
		expect(headers[1]).toMatch(/good.\s*Bob/u);

		expect(text).toContain("1 on air");
		expect(text).toContain("1 settled");
		expect(text).toContain("> Build the widget");
		expect(text).toContain("read(src/foo.ts)");
		expect(text).toContain("bash(bun test)");
		expect(text).toContain("edit: Fixing the parser");
		expect(text).toContain("The parser now accepts nested arrays");
		expect(text).toContain("prov/fast-model");
		expect(text).toContain("turn 2 completed");
		expect(text).toContain("turn completed — result delivered");
		// The wall is stacked rows under one header, never a frame per worker.
		expect(rows.filter(line => /[┌┐└┘─│]/u.test(line))).toEqual([]);
	});

	it("holds a live screen's trace and output to the disclosure state it was asked for", () => {
		const details: VibeToolDetails = {
			op: "list",
			screens: [
				screen({
					trace: ["t1", "t2", "t3", "t4"],
					outputTail: ["o1", "o2", "o3", "o4"],
				}),
			],
		};
		const collapsed = resultRows("list", { content: [{ type: "text", text: "" }], details }, {}, { expanded: false });
		expect(collapsed.filter(line => /\bt[1-4]\b/.test(line)).length).toBe(2);
		expect(collapsed.filter(line => /\bo[1-4]\b/.test(line)).length).toBe(1);
		// The end of each is what matters: a worker's last steps, not its first.
		expect(collapsed.join("\n")).toContain("t4");
		expect(collapsed.join("\n")).toContain("o4");
		expect(collapsed.join("\n")).not.toContain("t1");

		const expanded = resultRows("list", { content: [{ type: "text", text: "" }], details }, {}, { expanded: true });
		expect(expanded.filter(line => /\bt[1-4]\b/.test(line)).length).toBe(4);
		expect(expanded.filter(line => /\bo[1-4]\b/.test(line)).length).toBe(3);
	});

	it("reports an empty wall rather than drawing one", () => {
		for (const op of ["wait", "list"] as const) {
			const rows = resultRows(
				op,
				{
					content: [{ type: "text", text: "No vibe sessions. Spawn one with vibe_spawn." }],
					details: { op, screens: [] },
				},
				{},
				{ expanded: false },
			);
			expect(rows.length).toBe(1);
			expect(rows[0]).toContain(`vibe ${op}`);
			expect(rows[0]).toContain("No vibe sessions");
		}
	});

	it("names the session a kill ended, and says when a turn went with it", () => {
		const quiet = resultRows(
			"kill",
			{
				content: [{ type: "text", text: "killed" }],
				details: { op: "kill", screens: [], killed: { id: "Anna", cancelledTurn: false } },
			},
			{ session: "Anna" },
			{ expanded: false },
		).join("\n");
		expect(quiet).toContain("vibe kill");
		expect(quiet).toContain("Anna");
		expect(quiet).not.toContain("in-flight turn cancelled");

		const cancelled = resultRows(
			"kill",
			{
				content: [{ type: "text", text: "killed" }],
				details: { op: "kill", screens: [], killed: { id: "Anna", cancelledTurn: true } },
			},
			{ session: "Anna" },
			{ expanded: false },
		).join("\n");
		expect(cancelled).toContain("in-flight turn cancelled");
	});

	it("falls back to the tool's own text when a result carries no details, and marks a failure", () => {
		for (const op of ["spawn", "send", "wait", "kill", "list"] as const) {
			const failed = resultRows(
				op,
				{ content: [{ type: "text", text: "session Anna is gone" }], isError: true },
				{ session: "Anna", cli: "fast" },
				{ expanded: false },
			).join("\n");
			expect(failed).toContain("session Anna is gone");
			expect(failed).toContain(uiTheme.symbol("status.error"));
		}
	});

	it("keeps every row inside the columns the host gave it", () => {
		const details: VibeToolDetails = {
			op: "list",
			screens: [
				screen({
					id: "VeryLongSessionNameForTruncation",
					trace: [`read(${"x".repeat(200)})`],
					outputTail: ["y".repeat(300)],
					currentTool: "bash",
					currentToolArgs: "z".repeat(200),
					model: "provider/an-extremely-long-model-identifier",
				}),
			],
		};
		for (const width of [120, 80, 48, 24]) {
			for (const line of resultRows(
				"list",
				{ content: [{ type: "text", text: "" }], details },
				{},
				{ expanded: true },
				width,
			)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});
});
