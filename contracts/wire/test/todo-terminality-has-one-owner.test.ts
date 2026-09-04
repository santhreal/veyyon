/**
 * WHY: the todo board that would not collapse, and the reason it could not be
 * fixed in one place.
 *
 * THE DEFECT. A todo board with work on it and nothing left open kept drawing
 * the full list instead of one "Todo list done" line. The reason it stayed
 * broken across two renderers is the class this file guards: the question "has
 * this task closed?" was answered by private copies of the status vocabulary,
 * one in the TUI card and one in the HTML/collab renderer, plus a hand-written
 * pair test in the HUD that named `completed` and `abandoned` by hand.
 *
 * THE CLASS. A display decision that asks about SOME statuses. Every such
 * decision now routes through this module, so there is exactly one place that
 * can be wrong and exactly one place to test. That makes this file the owner's
 * own suite: the renderers prove they call the owner, and the owner proves it
 * answers correctly.
 *
 * FAIL BY DEFAULT. `TODO_STATUS_IS_TERMINAL` is pinned here by exact equality,
 * both its key set and its values. Adding a fifth status turns this suite RED
 * until somebody writes down whether a board of only that status is finished.
 * The truth table for `isTodoListDone` is then swept over the full cross product
 * of statuses across one and two phases, and the expectation is computed from
 * the pinned table rather than from the function under test, so this is a second
 * opinion and not a mirror.
 *
 * WHAT IT DOES NOT CATCH. Whether a renderer actually asks. A renderer that
 * grows a second private copy of the vocabulary passes here and fails in
 * `packages/coding-agent/test/tools/todo-done-collapse.test.ts` and
 * `packages/tool-render/test/todo-done-collapse.test.ts`, which drive the real
 * components and compare their decision against this owner for the same cross
 * product.
 */
import { describe, expect, it } from "bun:test";
import {
	asTodoStatus,
	isTerminalTodoStatus,
	isTodoListDone,
	TODO_DONE_SUMMARY,
	TODO_STATUS_IS_TERMINAL,
	TODO_STATUSES,
	type TodoStatus,
} from "../src/index";

/**
 * The decision, written down independently of the source. Not imported, not
 * derived: a second opinion that has to be edited on purpose.
 */
const PINNED_TERMINALITY = {
	pending: false,
	in_progress: false,
	completed: true,
	abandoned: true,
} as const;

const PINNED_STATUSES = ["pending", "in_progress", "completed", "abandoned"] as const;

type Board = Array<{ tasks: Array<{ status: TodoStatus }> }>;

function boardOf(...phases: TodoStatus[][]): Board {
	return phases.map(statuses => ({ tasks: statuses.map(status => ({ status })) }));
}

/** The oracle: work exists and every piece of it is closed, by the PINNED table. */
function expectedDone(board: Board): boolean {
	const statuses = board.flatMap(phase => phase.tasks.map(task => task.status));
	return statuses.length > 0 && statuses.every(status => PINNED_TERMINALITY[status]);
}

describe("the todo status vocabulary is closed and pinned", () => {
	it("holds exactly the statuses this suite has a decision for", () => {
		// Exact equality on both directions. A status added to the source without a
		// row here fails; a row here for a status the source dropped fails too.
		expect(TODO_STATUS_IS_TERMINAL).toEqual(PINNED_TERMINALITY);
		expect([...TODO_STATUSES]).toEqual([...PINNED_STATUSES]);
		expect(Object.keys(TODO_STATUS_IS_TERMINAL).sort()).toEqual([...PINNED_STATUSES].sort());
	});

	it("answers terminality for every member from the same table", () => {
		for (const status of TODO_STATUSES) {
			expect(isTerminalTodoStatus(status)).toBe(PINNED_TERMINALITY[status]);
		}
		// Both sides of the partition are non-empty, so a sweep that only ever
		// exercises one side cannot pass by accident.
		expect(TODO_STATUSES.filter(status => isTerminalTodoStatus(status)).length).toBeGreaterThan(0);
		expect(TODO_STATUSES.filter(status => !isTerminalTodoStatus(status)).length).toBeGreaterThan(0);
	});

	it("names the collapsed line in one place", () => {
		expect(TODO_DONE_SUMMARY).toBe("Todo list done");
	});
});

describe("narrowing arbitrary transcript JSON to a status", () => {
	it("passes every known status through unchanged", () => {
		for (const status of TODO_STATUSES) {
			expect(asTodoStatus(status)).toBe(status);
		}
	});

	/**
	 * A transcript can carry a status this build has never heard of: an older or
	 * newer veyyon, or the Claude-compat `cancelled` spelling the tool normalizes
	 * away before a board ever holds it. The invariant is not "it becomes
	 * pending", it is "it reads as OPEN": announcing a finish nobody recorded is
	 * the worse lie, and it is the lie that produced the reported defect.
	 */
	it("reads anything it does not recognize as open work", () => {
		const foreign: unknown[] = [
			"cancelled",
			"blocked",
			"COMPLETED",
			"completed ",
			"",
			null,
			undefined,
			0,
			1,
			true,
			{ status: "completed" },
			["completed"],
			Symbol.iterator,
		];
		for (const value of foreign) {
			const narrowed = asTodoStatus(value);
			expect(TODO_STATUSES).toContain(narrowed);
			expect(isTerminalTodoStatus(narrowed)).toBe(false);
		}
	});

	/**
	 * `Object.prototype` member names are not statuses. This is not a hypothetical
	 * input: `in` walked the prototype chain here, so a board carrying
	 * `status: "toString"` narrowed to the string "toString" and then looked up
	 * `Object.prototype.toString`, a truthy function, which read as CLOSED. A
	 * board with open work on it collapsed to "Todo list done" — the reported
	 * defect, reachable from any session file or wire frame.
	 */
	it("does not accept a prototype key as a status", () => {
		for (const value of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"]) {
			expect(asTodoStatus(value)).toBe("pending");
			expect(isTerminalTodoStatus(asTodoStatus(value))).toBe(false);
			// The un-narrowed path too: the TUI card reads phases straight off a
			// session file, so `isTodoListDone` sees the raw string.
			expect(isTerminalTodoStatus(value as TodoStatus)).toBe(false);
			expect(isTodoListDone(boardOf([value as TodoStatus]))).toBe(false);
			expect(isTodoListDone(boardOf(["completed", value as TodoStatus]))).toBe(false);
		}
	});
});

describe("a board is done when it holds work and none of it is open", () => {
	it("is not done when there is nothing to finish", () => {
		expect(isTodoListDone([])).toBe(false);
		expect(isTodoListDone(boardOf([]))).toBe(false);
		expect(isTodoListDone(boardOf([], [], []))).toBe(false);
		// A phase whose `tasks` key is absent entirely (legacy transcript shape).
		expect(isTodoListDone([{}, {}])).toBe(false);
	});

	/**
	 * The full cross product for a single phase, up to three tasks. Every
	 * combination of every status, not the reported one: the defect class is a
	 * decision that happens to be right for the mixture someone had in mind.
	 */
	it("sweeps every one-phase board of up to three tasks", () => {
		let boards = 0;
		for (const a of TODO_STATUSES) {
			const one = boardOf([a]);
			expect(isTodoListDone(one)).toBe(expectedDone(one));
			boards++;
			for (const b of TODO_STATUSES) {
				const two = boardOf([a, b]);
				expect(isTodoListDone(two)).toBe(expectedDone(two));
				boards++;
				for (const c of TODO_STATUSES) {
					const three = boardOf([a, b, c]);
					expect(isTodoListDone(three)).toBe(expectedDone(three));
					boards++;
				}
			}
		}
		const n = TODO_STATUSES.length;
		expect(boards).toBe(n + n * n + n * n * n);
	});

	/**
	 * The same cross product spread across phases, including empty phases either
	 * side. Phase structure must not change the answer: a single open task in the
	 * last phase of a finished plan holds the whole plan open.
	 */
	it("sweeps every two-phase board and ignores empty phases", () => {
		for (const a of TODO_STATUSES) {
			for (const b of TODO_STATUSES) {
				const split = boardOf([a], [b]);
				const together = boardOf([a, b]);
				const padded = boardOf([], [a], [], [b], []);
				expect(isTodoListDone(split)).toBe(expectedDone(split));
				expect(isTodoListDone(together)).toBe(expectedDone(split));
				expect(isTodoListDone(padded)).toBe(expectedDone(split));
			}
		}
	});

	/** One open task of ANY open status holds a board of every closed status open. */
	it("keeps a board of closed work open when a single open task joins it", () => {
		const closed = TODO_STATUSES.filter(status => isTerminalTodoStatus(status));
		const open = TODO_STATUSES.filter(status => !isTerminalTodoStatus(status));
		expect(isTodoListDone(boardOf(closed))).toBe(true);
		for (const status of open) {
			// First, last, and middle: a short-circuit that stops at the first task
			// and a fold that only remembers the last one both fail one of these.
			expect(isTodoListDone(boardOf([status, ...closed]))).toBe(false);
			expect(isTodoListDone(boardOf([...closed, status]))).toBe(false);
			expect(isTodoListDone(boardOf(closed, [status], closed))).toBe(false);
		}
	});

	/**
	 * The reporter's clarification: "collapsed state should not persist". The
	 * answer is a pure function of the board handed in, so the same board object
	 * mutated between two calls answers differently on the second one. Nothing
	 * memoizes, and there is no argument that could carry a remembered collapse.
	 */
	it("recomputes from the board it is handed and remembers nothing", () => {
		const board = boardOf(["completed", "completed"]);
		expect(isTodoListDone(board)).toBe(true);
		expect(isTodoListDone(board)).toBe(true);

		board[0].tasks.push({ status: "pending" });
		expect(isTodoListDone(board)).toBe(false);

		board[0].tasks[2].status = "completed";
		expect(isTodoListDone(board)).toBe(true);

		// A second, structurally identical board is answered identically: nothing
		// is keyed on object identity either.
		expect(isTodoListDone(boardOf(["completed", "completed", "completed"]))).toBe(true);
		expect(isTodoListDone.length).toBe(1);
	});

	/** Termination: a wide board answers in bounded work, not by walking forever. */
	it("terminates on a large board", () => {
		const wide = boardOf(
			Array.from({ length: 5000 }, (_, index) => TODO_STATUSES[index % TODO_STATUSES.length]),
			["pending"],
		);
		expect(isTodoListDone(wide)).toBe(false);
		expect(isTodoListDone(boardOf(Array.from({ length: 5000 }, () => "completed" as TodoStatus)))).toBe(true);
	});
});
