/**
 * A finished todo board is one green line, and it is one green line because of
 * what the board says right now — not because anything remembered collapsing it.
 *
 * WHY THIS SUITE EXISTS. The reported defect: "the todolist doesnt collapse into
 * a single 'todo list done' green colored", clarified with "collapsed state
 * should not persist is what i meant". Both halves are contract:
 *
 *  1. Every task closed  → exactly one success-coloured line.
 *  2. Anything still open → the full board, unchanged.
 *  3. The answer is recomputed on every render. A board that reopens (the model
 *     appends a task after finishing) draws in full again, and nothing in the
 *     session or the tool result grows a field naming the collapse.
 *
 * THE CLASS, not the incident. The defect class is "a display decision that asks
 * about SOME statuses". `#isClosedTodo` in the HUD asked about two of them by
 * name; `@veyyon/tool-render` kept a private copy of the whole vocabulary. So
 * the terminality decision now has one owner, `TODO_STATUS_IS_TERMINAL` in
 * `@veyyon/wire`, and the sweep below enumerates that map AT RUN TIME and drives
 * the real renderer once per member. Adding a fifth status turns this suite red
 * until somebody records whether it closes a task.
 *
 * WHAT IT DOES NOT CATCH. It renders the TUI card. The HTML/collab renderer runs
 * the same derivation over the same owner but builds a different component tree,
 * and is covered by `packages/tool-render/test/todo-done-collapse.test.ts`. This
 * suite also says nothing about WHERE the card sits in the transcript, only about
 * what it draws.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TodoTool, type TodoPhase, type TodoToolDetails, todoToolRenderer } from "@veyyon/coding-agent/tools/todo";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, type TUI } from "@veyyon/tui";
import {
	isTerminalTodoStatus,
	TODO_DONE_SUMMARY,
	TODO_STATUS_IS_TERMINAL,
	TODO_STATUSES,
	type TodoStatus,
} from "@veyyon/wire";
import { createToolExecution } from "../helpers/tool-execution";

/**
 * The terminality call, one row per status, written down here so it is an
 * independent second opinion rather than a mirror of the source. A status in one
 * table and missing from the other fails the sweep.
 */
const TERMINALITY_DECISION: Record<string, boolean> = {
	pending: false,
	in_progress: false,
	completed: true,
	abandoned: true,
};

const RENDER_WIDTH = 100;

type TodoResult = { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean };

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

function resultFor(phases: TodoPhase[]): TodoResult {
	return { content: [{ type: "text", text: "board" }], details: { phases, storage: "memory" } };
}

/** The card's own lines, with the frame's right-edge padding taken off. */
function renderLines(
	result: TodoResult,
	options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number } = { expanded: false, isPartial: false },
): string[] {
	return todoToolRenderer
		.renderResult(result, options, theme)
		.render(RENDER_WIDTH)
		.map(line => line.trimEnd());
}

/**
 * The exact bytes a finished board must produce — success SGR included, since the
 * colour is half the report. Built from the theme accessors rather than a literal
 * escape so a re-themed success colour stays the contract.
 */
function doneLine(tasks: number): string {
	const plural = tasks === 1 ? "task" : "tasks";
	return theme.fg("success", `${theme.checkbox.checked} ${TODO_DONE_SUMMARY} · ${tasks} ${plural}`);
}

/** The SGR `theme.fg(color, …)` opens with, isolated from any text. */
function sgrPrefix(color: "success" | "error"): string {
	return theme.fg(color, "\u0000").split("\u0000")[0] ?? "";
}

function board(statuses: TodoStatus[], phaseName = "Alpha"): TodoPhase[] {
	return [
		{ name: phaseName, tasks: statuses.map((status, index) => ({ content: `task-${index}-${status}`, status })) },
	];
}

// The colour IS the report ("green colored"), so the assertions below have to
// see real SGR. A piped `bun test` resolves the ANSI policy to `plain`, which
// turns every `theme.fg` into the identity and would make every exact-byte
// comparison here pass while proving nothing about colour. Restored after the
// file so no later suite inherits the override.
let previousAnsiPolicy: AnsiPolicy = "plain";

beforeAll(async () => {
	previousAnsiPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousAnsiPolicy);
});

describe("finished todo board collapses to one success line", () => {
	/**
	 * The headline contract, on exact bytes: one line, the success colour, the
	 * words that name the board finished, and no task rows. Not `toContain` — a
	 * second line IS the defect.
	 */
	it("renders exactly one success-coloured line and nothing else", () => {
		const lines = renderLines(resultFor(board(["completed", "completed", "abandoned"])));

		expect(lines).toEqual([doneLine(3)]);
		expect(Bun.stripANSI(lines[0]!)).toContain(TODO_DONE_SUMMARY);
		expect(Bun.stripANSI(lines[0]!)).not.toContain("task-0-completed");
	});

	/**
	 * Guard against the assertion above passing in a run with no colour at all,
	 * where every `theme.fg` is the identity and "green" proves nothing.
	 */
	it("uses the success colour and not another theme colour", () => {
		const success = sgrPrefix("success");

		expect(success.length).toBeGreaterThan(0);
		expect(success).not.toBe(sgrPrefix("error"));
		expect(renderLines(resultFor(board(["completed"])))[0]).toStartWith(success);
	});

	/** Expanded or collapsed, streaming or settled: a finished board is finished. */
	it("collapses on every render option the transcript passes", () => {
		const result = resultFor(board(["completed", "completed"]));

		for (const options of [
			{ expanded: false, isPartial: false },
			{ expanded: true, isPartial: false },
			{ expanded: false, isPartial: true },
			{ expanded: true, isPartial: false, spinnerFrame: 7 },
		]) {
			expect(renderLines(result, options)).toEqual([doneLine(2)]);
		}
	});

	/** Open work anywhere on the board means the whole board still draws. */
	it("draws every row while one task is still open", () => {
		const rendered = Bun.stripANSI(
			renderLines(
				resultFor([
					{
						name: "Alpha",
						tasks: [
							{ content: "shipped", status: "completed" },
							{ content: "dropped", status: "abandoned" },
							{ content: "still going", status: "in_progress" },
						],
					},
				]),
				{ expanded: true, isPartial: false },
			).join("\n"),
		);

		expect(rendered).toContain("shipped");
		expect(rendered).toContain("dropped");
		expect(rendered).toContain("still going");
		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
	});

	/** An empty board never finished anything; it keeps its own fallback. */
	it("does not claim an empty board is done", () => {
		const rendered = Bun.stripANSI(renderLines(resultFor([])).join("\n"));

		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
		expect(rendered).toContain("Todo");
	});
});

describe("the collapse is derived, never remembered", () => {
	/**
	 * The clarification the reporter added. A board that finishes and then gains
	 * a task comes straight back: the renderer holds nothing, so the same
	 * renderer answers differently the moment the board does.
	 */
	it("re-expands the moment a finished board gains a pending task", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("c1", { op: "init", list: [{ phase: "Alpha", items: ["a1", "a2"] }] });
		await tool.execute("c2", { op: "done", task: "a1" });
		const finished = await tool.execute("c3", { op: "done", task: "a2" });

		expect(renderLines(finished)).toEqual([doneLine(2)]);

		const reopened = await tool.execute("c4", { op: "append", phase: "Alpha", items: ["a3"] });
		const rendered = Bun.stripANSI(renderLines(reopened, { expanded: true, isPartial: false }).join("\n"));

		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
		expect(rendered).toContain("a1");
		expect(rendered).toContain("a2");
		expect(rendered).toContain("a3");

		// …and finishing it again collapses again, through the same renderer.
		const refinished = await tool.execute("c5", { op: "done", task: "a3" });
		expect(renderLines(refinished)).toEqual([doneLine(3)]);
	});

	/**
	 * Rendering is a read. Nothing the session or the transcript persists may grow
	 * a "this card was collapsed" bit, because that bit is exactly what would make
	 * a collapse survive into a board that has reopened.
	 */
	it("writes nothing to the session or the serialized result", async () => {
		const session = createSession();
		const tool = new TodoTool(session);
		await tool.execute("c1", { op: "init", list: [{ phase: "Alpha", items: ["a1", "a2"] }] });
		await tool.execute("c2", { op: "done", task: "a1" });
		const result = await tool.execute("c3", { op: "done", task: "a2" });

		const sessionBefore = JSON.stringify(session.getTodoPhases?.());
		const resultBefore = JSON.stringify(result);

		for (const options of [
			{ expanded: false, isPartial: false },
			{ expanded: true, isPartial: false },
			{ expanded: false, isPartial: true },
		]) {
			expect(renderLines(result, options)).toEqual([doneLine(2)]);
		}

		expect(JSON.stringify(session.getTodoPhases?.())).toBe(sessionBefore);
		expect(JSON.stringify(result)).toBe(resultBefore);

		// What a transcript writes down for this turn is phases and counters. No key
		// or value anywhere in it names a collapse or an expansion.
		const persisted = JSON.stringify({ phases: session.getTodoPhases?.(), details: result.details });
		expect(persisted).not.toMatch(/collaps|expand/i);
	});
});

describe("terminality vocabulary is closed", () => {
	/**
	 * The class-closing sweep. The variant space comes from
	 * `TODO_STATUS_IS_TERMINAL` at run time and every member drives the real
	 * renderer. A new status with no row in `TERMINALITY_DECISION` fails here
	 * instead of quietly picking a side.
	 */
	it("classifies every status in the source vocabulary and collapses on exactly the terminal ones", () => {
		expect(TODO_STATUSES.length).toBeGreaterThan(0);

		for (const status of TODO_STATUSES) {
			if (!Object.hasOwn(TERMINALITY_DECISION, status)) {
				throw new Error(
					`todo status "${status}" has no terminality decision in this suite: does a board of only "${status}" tasks count as done?`,
				);
			}
			const terminal = TERMINALITY_DECISION[status]!;
			expect(isTerminalTodoStatus(status)).toBe(terminal);

			const lines = renderLines(resultFor(board([status])), { expanded: true, isPartial: false });
			if (terminal) {
				expect(lines).toEqual([doneLine(1)]);
			} else {
				expect(Bun.stripANSI(lines.join("\n"))).toContain(`task-0-${status}`);
				expect(Bun.stripANSI(lines.join("\n"))).not.toContain(TODO_DONE_SUMMARY);
			}
		}

		// A row here for a status the source dropped is just as stale as a missing one.
		expect(Object.keys(TERMINALITY_DECISION).sort()).toEqual([...TODO_STATUSES].sort());
		expect(Object.keys(TODO_STATUS_IS_TERMINAL).sort()).toEqual([...TODO_STATUSES].sort());
	});

	/** One open task of ANY status holds a board of closed ones open. */
	it("keeps the board open when any single open status is present among closed work", () => {
		const closed = TODO_STATUSES.filter(status => isTerminalTodoStatus(status));
		const open = TODO_STATUSES.filter(status => !isTerminalTodoStatus(status));
		expect(open.length).toBeGreaterThan(0);

		for (const status of open) {
			const rendered = Bun.stripANSI(
				renderLines(resultFor(board([...closed, ...closed, status])), { expanded: true, isPartial: false }).join(
					"\n",
				),
			);
			expect(rendered).not.toContain(TODO_DONE_SUMMARY);
			expect(rendered).toContain(`task-${closed.length * 2}-${status}`);
		}
	});

	/** Any mixture of closed statuses, across any number of phases, is done. */
	it("collapses a board mixing every closed status across phases", () => {
		const closed = TODO_STATUSES.filter(status => isTerminalTodoStatus(status));
		const phases: TodoPhase[] = closed.map((status, index) => ({
			name: `Phase ${index + 1}`,
			tasks: closed.map((inner, position) => ({ content: `p${index}-t${position}`, status: inner })),
		}));

		expect(renderLines(resultFor(phases))).toEqual([doneLine(closed.length * closed.length)]);
	});
});

describe("merged call/result transcript block", () => {
	/**
	 * The block the transcript actually holds. `todo` renders with
	 * `mergeCallAndResult`, so the block drops its streaming call preview once a
	 * result lands — a finished board must be one line in the block too, not one
	 * line under a leftover "Todo" call header. Live streaming and a transcript
	 * rebuild both reach this same component with the same result, which is why
	 * the derivation lives in `renderResult` and not at either call site.
	 */
	it("shows only the done line once the finished result lands", async () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = createToolExecution("todo", { op: "done", task: "a2" }, {}, undefined, uiStub);

		const tool = new TodoTool(createSession());
		await tool.execute("c1", { op: "init", list: [{ phase: "Alpha", items: ["a1", "a2"] }] });
		await tool.execute("c2", { op: "done", task: "a1" });
		const finished: AgentToolResult<TodoToolDetails> = await tool.execute("c3", { op: "done", task: "a2" });

		component.updateResult(finished, false);
		const lines = component
			.render(RENDER_WIDTH)
			.map(line => line.trim())
			.filter(line => Bun.stripANSI(line).length > 0);

		expect(lines).toEqual([doneLine(2)]);
	});
});
