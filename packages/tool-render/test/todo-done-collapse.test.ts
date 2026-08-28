/**
 * The exported/collab view of a finished todo board.
 *
 * WHY THIS SUITE EXISTS. The TUI card collapses a board whose every task has
 * closed into one success-coloured line. An HTML export that still draws the
 * full board is the same defect wearing a different renderer — the streaming
 * bash preview taught this repo that a fix landed in one render path and not the
 * others is not a fix. Both paths now ask the same owner,
 * `TODO_STATUS_IS_TERMINAL` / `isTodoListDone` in `@veyyon/wire`.
 * THE CLASS. The status vocabulary is enumerated at run time, so a fifth status
 * makes the sweep red rather than quietly rendering as one thing here and
 * another in the terminal. The collapse decision is swept over the FULL cross
 * product of statuses across one and two phases and compared, board by board,
 * against `isTodoListDone` in the owner: this renderer is not allowed to be
 * right for the reported mixture and wrong for a sibling. The unknown-status
 * case is asserted too, because this renderer reads raw JSON off a transcript
 * and a status it does not recognise must read as OPEN — claiming an unread
 * board finished is the worse lie, and `Object.prototype` member names are the
 * spelling of that lie which actually shipped.
 *
 * WHAT IT DOES NOT CATCH. Colour. That is one CSS custom property away in
 * `tool-render.css` (`.tv-todo-done` → `--tv-ok`) and no DOM assertion can see
 * it; the TUI suite pins the terminal's success bytes exactly.
 */

import { describe, expect, it } from "bun:test";
import { isTerminalTodoStatus, isTodoListDone, TODO_DONE_SUMMARY, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps } from "../src/types";

type RawTask = { content: string; status: string };
type RawPhase = { name: string; tasks: RawTask[] };

function renderBody(props: Partial<ToolRenderProps>): string {
	const Body = resolveToolRenderer("todo").Body;
	if (!Body) throw new Error("todo renderer has no Body");
	return renderToStaticMarkup(
		createElement(Body, { name: "todo", args: { op: "done" }, ...props } as ToolRenderProps),
	);
}

function renderBoard(phases: RawPhase[]): string {
	return renderBody({
		result: { content: [{ type: "text", text: "board" }], details: { phases, storage: "session" } },
	});
}

function phase(statuses: string[], name = "Alpha"): RawPhase[] {
	return [{ name, tasks: statuses.map((status, index) => ({ content: `task-${index}-${status}`, status })) }];
}

/** A board spread over several phases, one argument per phase. */
function board(...phases: string[][]): RawPhase[] {
	return phases.map((statuses, index) => ({
		name: `Phase ${index + 1}`,
		tasks: statuses.map((status, task) => ({ content: `p${index}-t${task}-${status}`, status })),
	}));
}

/** Count of rendered task rows, whatever their status class. */
function taskRows(html: string): number {
	return html.split('class="tv-task ').length - 1;
}

/** What this renderer decided, read back off the markup it produced. */
function renderedAsDone(html: string): boolean {
	return html.includes('class="tv-todo-done"');
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
	 * Fail by default on a new status, in this renderer's own terms.
	 *
	 * Agreeing with the owner is not enough on its own: a status added to the
	 * vocabulary as TERMINAL would agree with the owner here and slip through,
	 * while this renderer still has no glyph and no CSS class for it. The
	 * decisions this file owns are pinned below by exact equality and each one is
	 * read back off the real markup, so a fifth status turns this suite red until
	 * somebody picks its icon and its class.
	 */
	it("renders every status in the vocabulary with the icon and class recorded here", () => {
		const PINNED_ROWS: Record<string, { icon: string; className: string }> = {
			pending: { icon: "○", className: "tv-task tv-task--pending" },
			in_progress: { icon: "→", className: "tv-task tv-task--in_progress" },
			completed: { icon: "✓", className: "tv-task tv-task--completed" },
			abandoned: { icon: "✕", className: "tv-task tv-task--abandoned" },
		};

		expect(Object.keys(PINNED_ROWS).sort()).toEqual([...TODO_STATUSES].sort());

		for (const status of TODO_STATUSES) {
			const row = PINNED_ROWS[status];
			// Terminal statuses collapse on their own, so pair each one with an open
			// task to force the row to draw.
			const html = renderBoard(phase([status, "pending"]));

			expect(html).toContain(`class="${row.className}"`);
			expect(html).toContain(`<span class="tv-task-icon">${row.icon}</span>`);
		}

		// The collapsed line uses the completed glyph, and it is the same one.
		expect(renderBoard(phase(["completed"]))).toContain(`${PINNED_ROWS.completed.icon} ${TODO_DONE_SUMMARY}`);
	});

	/**
	 * The class-closing sweep. The vocabulary comes from the source at run time,
	 * every member drives the real renderer, and the expectation is the owner's
	 * answer for the same board — so this renderer cannot drift from the terminal
	 * card without one of the two suites going red.
	 */
	it("collapses on exactly the terminal statuses of the shared vocabulary", () => {
		expect(TODO_STATUSES.length).toBeGreaterThan(0);

		for (const status of TODO_STATUSES) {
			const html = renderBoard(phase([status]));
			if (isTerminalTodoStatus(status)) {
				expect(html).toContain(`${TODO_DONE_SUMMARY} · 1 task`);
				expect(taskRows(html)).toBe(0);
			} else {
				expect(html).not.toContain(TODO_DONE_SUMMARY);
				expect(html).toContain(`task-0-${status}`);
			}
		}
	});

	/**
	 * The full cross product, across one and two phases. The reported defect was
	 * a decision that happened to be right for the mixture someone had in mind;
	 * every mixture is checked here, and the row count is asserted alongside the
	 * verdict so a board that collapses AND keeps its rows still fails.
	 */
	it("agrees with the owner on every board of up to two tasks across up to two phases", () => {
		let checked = 0;
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const layouts: RawPhase[][] = [
					board([first, second]),
					board([first], [second]),
					board([], [first], [], [second], []),
				];
				for (const phases of layouts) {
					const expected = isTodoListDone(
						phases.map(entry => ({ tasks: entry.tasks.map(task => ({ status: task.status as TodoStatus })) })),
					);
					const html = renderBoard(phases);
					expect(renderedAsDone(html)).toBe(expected);
					expect(taskRows(html)).toBe(expected ? 0 : 2);
					if (expected) expect(html).toContain(`${TODO_DONE_SUMMARY} · 2 tasks`);
					checked++;
				}
			}
		}
		const n = TODO_STATUSES.length;
		expect(checked).toBe(n * n * 3);
	});

	/**
	 * A transcript can carry a status this build has never heard of — an older
	 * or newer veyyon, or the Claude-compat `cancelled` spelling the tool
	 * normalizes away before it ever reaches a board. Unknown reads as OPEN, so
	 * the export shows the work instead of announcing a finish nobody recorded.
	 *
	 * `toString` and its `Object.prototype` siblings are in the list because they
	 * were not hypothetical: the narrowing used `in`, which walks the prototype
	 * chain, so those names came back typed as statuses and looked up truthy
	 * function values that read as CLOSED. An export of a live board announced it
	 * finished.
	 */
	it("treats an unrecognized status as open work", () => {
		for (const foreign of ["cancelled", "blocked", "COMPLETED", "toString", "constructor", "valueOf"]) {
			const html = renderBoard(phase(["completed", foreign]));

			expect(html).not.toContain(TODO_DONE_SUMMARY);
			expect(renderedAsDone(html)).toBe(false);
			expect(taskRows(html)).toBe(2);
			expect(html).toContain("tv-task--pending");
			expect(html).toContain(`task-1-${foreign}`);
		}
	});

	/**
	 * A missing or non-array `status`, and a task that is not a record at all.
	 * The board still draws; nothing about a malformed row may be read as closed.
	 */
	it("does not read a malformed task as closed", () => {
		const html = renderBody({
			result: {
				content: [{ type: "text", text: "board" }],
				details: {
					phases: [
						{
							name: "Alpha",
							tasks: [{ content: "done thing", status: "completed" }, { content: "no status" }, null, 7],
						},
					],
					storage: "session",
				},
			},
		});

		expect(renderedAsDone(html)).toBe(false);
		expect(html).toContain("tv-task--pending");
	});

	/**
	 * The collapse is a function of the result in hand, so the same renderer
	 * answers differently the moment the board does, in either direction, with no
	 * component state between the two renders.
	 */
	it("re-expands and re-collapses as the board changes, holding nothing between renders", () => {
		const finished = phase(["completed", "completed"]);
		expect(renderedAsDone(renderBoard(finished))).toBe(true);
		expect(renderedAsDone(renderBoard(phase(["completed", "completed", "pending"])))).toBe(false);
		expect(renderedAsDone(renderBoard(finished))).toBe(true);

		// Rendering does not mutate the result it was handed: an export that
		// re-renders the same object must not have grown a collapsed flag.
		const snapshot = JSON.stringify(finished);
		renderBoard(finished);
		renderBoard(finished);
		expect(JSON.stringify(finished)).toBe(snapshot);
		expect(snapshot).not.toMatch(/collaps|expand|done/i);
	});

	/**
	 * An errored `todo` call has no board to judge. It must fall back to the
	 * result text rather than collapse — "Todo list done" over a failed write is
	 * the same false finish in a different disguise.
	 */
	it("never collapses an errored result", () => {
		const html = renderBody({
			result: {
				content: [{ type: "text", text: "Errors: Missing task content" }],
				details: { phases: phase(["completed", "completed"]), storage: "session" },
				isError: true,
			},
		});

		expect(renderedAsDone(html)).toBe(false);
		expect(html).toContain("Errors: Missing task content");
	});

	/** No result yet (a streaming call): the op row renders, no board is claimed. */
	it("claims nothing while the call is still streaming", () => {
		const html = renderBody({ args: { op: "done", task: "a1" }, result: undefined });

		expect(renderedAsDone(html)).toBe(false);
		expect(html).not.toContain(TODO_DONE_SUMMARY);
	});
});
