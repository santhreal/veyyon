/**
 * The exported/collab view of a finished todo board.
 *
 * WHY THIS SUITE EXISTS. The TUI card collapses a board whose every task has
 * closed into one success-coloured line. An HTML export that still draws the
 * full board is the same defect wearing a different renderer — the streaming
 * bash preview taught this repo that a fix landed in one render path and not the
 * others is not a fix. Both paths now ask the same owner,
 * `TODO_STATUS_IS_TERMINAL` / `isTodoListDone` in `@veyyon/wire`.
 *
 * THE CLASS. The status vocabulary is enumerated at run time, so a fifth status
 * makes the sweep red rather than quietly rendering as one thing here and
 * another in the terminal. The unknown-status case is asserted too, because this
 * renderer reads raw JSON off a transcript and a status it does not recognise
 * must read as OPEN — claiming an unread board finished is the worse lie.
 *
 * WHAT IT DOES NOT CATCH. Colour. That is one CSS custom property away in
 * `tool-render.css` (`.tv-todo-done` → `--tv-ok`) and no DOM assertion can see
 * it; the TUI suite pins the terminal's success bytes exactly.
 */

import { describe, expect, it } from "bun:test";
import { isTerminalTodoStatus, TODO_DONE_SUMMARY, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps } from "../src/types";

type RawTask = { content: string; status: string };

function renderBoard(phases: Array<{ name: string; tasks: RawTask[] }>): string {
	const Body = resolveToolRenderer("todo").Body;
	if (!Body) throw new Error("todo renderer has no Body");
	return renderToStaticMarkup(
		createElement(Body, {
			name: "todo",
			args: { op: "done" },
			result: { content: [{ type: "text", text: "board" }], details: { phases, storage: "session" } },
		} as ToolRenderProps),
	);
}

function phase(statuses: string[], name = "Alpha"): Array<{ name: string; tasks: RawTask[] }> {
	return [{ name, tasks: statuses.map((status, index) => ({ content: `task-${index}-${status}`, status })) }];
}

/** Count of rendered task rows, whatever their status class. */
function taskRows(html: string): number {
	return html.split('class="tv-task ').length - 1;
}

describe("todo HTML renderer collapses a finished board", () => {
	it("replaces the whole board with one done line", () => {
		const html = renderBoard(phase(["completed", "abandoned", "completed"]));

		expect(html).toContain(`${TODO_DONE_SUMMARY} · 3 tasks`);
		expect(html).toContain('class="tv-todo-done"');
		expect(taskRows(html)).toBe(0);
		expect(html).not.toContain("task-0-completed");
		expect(html).not.toContain("tv-todo-phase");
	});

	it("draws every row while one task is still open", () => {
		const html = renderBoard(phase(["completed", "abandoned", "in_progress"]));

		expect(html).not.toContain(TODO_DONE_SUMMARY);
		expect(taskRows(html)).toBe(3);
		expect(html).toContain("task-2-in_progress");
	});

	/** A board that finished and then gained a task is an open board again. */
	it("re-expands when a finished board gains a pending task", () => {
		expect(renderBoard(phase(["completed", "completed"]))).toContain(TODO_DONE_SUMMARY);

		const reopened = renderBoard(phase(["completed", "completed", "pending"]));

		expect(reopened).not.toContain(TODO_DONE_SUMMARY);
		expect(taskRows(reopened)).toBe(3);
	});

	/** An empty board finished nothing, and a board of empty phases is not done either. */
	it("does not claim an empty board is done", () => {
		expect(renderBoard([])).not.toContain(TODO_DONE_SUMMARY);
		expect(renderBoard([{ name: "Alpha", tasks: [] }])).not.toContain(TODO_DONE_SUMMARY);
	});

	/**
	 * The class-closing sweep: the vocabulary comes from the source at run time
	 * and each member drives the real renderer.
	 */
	it("collapses on exactly the terminal statuses of the shared vocabulary", () => {
		expect(TODO_STATUSES.length).toBeGreaterThan(0);

		for (const status of TODO_STATUSES) {
			const html = renderBoard(phase([status]));
			if (isTerminalTodoStatus(status as TodoStatus)) {
				expect(html).toContain(`${TODO_DONE_SUMMARY} · 1 task`);
				expect(taskRows(html)).toBe(0);
			} else {
				expect(html).not.toContain(TODO_DONE_SUMMARY);
				expect(html).toContain(`task-0-${status}`);
			}
		}
	});

	/**
	 * A transcript can carry a status this build has never heard of — an older
	 * or newer veyyon, or the Claude-compat `cancelled` spelling the tool
	 * normalizes away before it ever reaches a board. Unknown reads as OPEN, so
	 * the export shows the work instead of announcing a finish nobody recorded.
	 */
	it("treats an unrecognized status as open work", () => {
		const html = renderBoard(phase(["completed", "cancelled"]));

		expect(html).not.toContain(TODO_DONE_SUMMARY);
		expect(taskRows(html)).toBe(2);
		expect(html).toContain("tv-task--pending");
	});
});
