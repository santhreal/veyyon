/**
 * WHY THIS FILE EXISTS
 *
 * The board has a row budget and nothing pinned what happens when a plan exceeds
 * it. `TODO_REMINDER_PREVIEW_LIMIT` task rows fit; the rest are counted into a
 * `… N more todos` tail. The reminder surface has a test for its own tail
 * (`todo-reminder-rendering`); the CARD's tail had none, so the arithmetic that
 * tells a reader how much of the plan they are not looking at was unguarded.
 *
 * THE CLASS THIS CLOSES: a board that misreports what it withheld. That covers
 * an off-by-one in the count, a tail that appears when nothing was withheld, a
 * tail that goes missing when something was, and a tail row that makes the
 * block's height vary with the entrance frame — which is the blank-band and
 * tearing class the row count is held constant to avoid.
 *
 * It also pins the contract that PHASE rows are unbudgeted: every phase gets a
 * row no matter how many there are, and only tasks are withheld. That is the
 * current behaviour and it is deliberate — a phase row is the index of the plan,
 * and a board that hides phases cannot be used to find the work — but it means
 * card height grows with phase count without limit, so a future change that
 * decides to budget them has to come past this file and record the decision.
 *
 * The sizes are derived from the budget constant at run time, so raising
 * `TODO_REMINDER_PREVIEW_LIMIT` moves every case with it rather than leaving a
 * file full of stale literals that pass for the wrong reason.
 *
 * WHAT IT DOES NOT CATCH: whether the five rows it keeps are the RIGHT five.
 * Which tasks survive the budget is `prioritizeTodoItems`' contract and is
 * pinned where that ordering lives; this file only asserts that whatever was
 * dropped is counted honestly.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TodoPhase } from "@veyyon/coding-agent/tools/todo";
import {
	TODO_BOARD_TOTAL_FRAMES,
	TODO_REMINDER_PREVIEW_LIMIT,
	todoToolRenderer,
} from "@veyyon/coding-agent/tools/todo";

// The board asks the theme for its checkbox glyphs and its colours, so an
// uninitialised theme is a crash rather than a plain-text render. Every
// assertion here is on stripped text, so the default `plain` ANSI policy is
// correct and deliberate: `theme.fg` is identity under it and the row contents
// are readable without unwrapping escapes.
beforeAll(async () => {
	await initTheme();
});

const WIDTH = 100;

/** `phaseCount` phases of `perPhase` pending tasks each, named so every row is distinct. */
function plan(phaseCount: number, perPhase: number): TodoPhase[] {
	return Array.from({ length: phaseCount }, (_, p) => ({
		name: `Phase${p + 1}`,
		tasks: Array.from({ length: perPhase }, (_, t) => ({
			content: `phase ${p + 1} task ${t + 1}`,
			status: "pending" as const,
		})),
	}));
}

function boardRows(phases: TodoPhase[], options: { expanded?: boolean; frame?: number } = {}): string[] {
	const component = todoToolRenderer.renderResult(
		{ content: [{ type: "text", text: "Todo updated" }], details: { op: "done", phases, storage: "session" } },
		{ expanded: options.expanded ?? false, isPartial: false, spinnerFrame: options.frame },
		theme,
	);
	return component.render(WIDTH);
}

/** The withheld count the board printed, or null when it printed no tail. */
function tailCount(rows: readonly string[]): number | null {
	for (const row of rows) {
		const match = /… (\d+) more todos?\b/.exec(row);
		if (match) return Number(match[1]);
	}
	return null;
}

/** Rows that carry one of the plan's task contents, which is what the budget caps. */
function taskRows(rows: readonly string[], phases: readonly TodoPhase[]): string[] {
	const contents = phases.flatMap(phase => phase.tasks.map(task => task.content));
	return rows.filter(row => contents.some(content => row.includes(content)));
}

describe("a board too long to print", () => {
	/**
	 * The arithmetic, swept across the budget boundary from under it to well past
	 * it. `printed + withheld === total` is the invariant; everything else about
	 * the tail is a consequence of it.
	 */
	it("accounts for every task it did not print", () => {
		const total = TODO_REMINDER_PREVIEW_LIMIT * 3;
		const observed: [number, number, number | null][] = [];
		for (let tasks = 1; tasks <= total; tasks++) {
			const phases = plan(1, tasks);
			const rows = boardRows(phases);
			const printed = taskRows(rows, phases).length;
			const withheld = tailCount(rows);
			observed.push([tasks, printed, withheld]);
			expect(printed + (withheld ?? 0)).toBe(tasks);
			// The budget is a cap, not a target: a short plan prints all of it.
			expect(printed).toBe(Math.min(tasks, TODO_REMINDER_PREVIEW_LIMIT));
		}
		// A tail exists exactly when something was withheld, and never otherwise.
		for (const [tasks, , withheld] of observed) {
			if (tasks <= TODO_REMINDER_PREVIEW_LIMIT) expect(withheld).toBeNull();
			else expect(withheld).toBe(tasks - TODO_REMINDER_PREVIEW_LIMIT);
		}
	});

	/**
	 * The tail is singular at one. `formatMoreItems` pluralizes, and a board that
	 * says "1 more todos" is the kind of thing a reader reads as a rendering bug
	 * in everything else on the panel.
	 */
	it("says one more todo, not one more todos", () => {
		const rows = boardRows(plan(1, TODO_REMINDER_PREVIEW_LIMIT + 1));
		expect(rows.some(row => row.includes("… 1 more todo") && !row.includes("todos"))).toBe(true);
	});

	/**
	 * Phase rows are not budgeted. Ten phases of one task each is eleven rows of
	 * content: every phase named, five tasks, five withheld.
	 */
	it("prints every phase row and withholds only tasks", () => {
		const phases = plan(10, 1);
		const rows = boardRows(phases);
		const named = phases.filter(phase => rows.some(row => row.includes(phase.name)));

		expect(named).toHaveLength(10);
		expect(taskRows(rows, phases)).toHaveLength(TODO_REMINDER_PREVIEW_LIMIT);
		expect(tailCount(rows)).toBe(10 - TODO_REMINDER_PREVIEW_LIMIT);
	});

	/**
	 * The height of the block cannot depend on the frame. The tail is a row like
	 * any other and it is staged like any other, so a plan with a tail has to hold
	 * its row count across the whole entrance envelope.
	 */
	it("keeps its row count constant across every frame of the entrance", () => {
		const phases = plan(4, 4);
		const settled = boardRows(phases).length;
		const perFrame = new Map<number, number>();
		for (let frame = 0; frame <= TODO_BOARD_TOTAL_FRAMES; frame++) {
			perFrame.set(frame, boardRows(phases, { frame }).length);
		}

		expect([...new Set(perFrame.values())]).toEqual([settled]);
		// And the tail is present the whole way through rather than arriving late.
		for (let frame = 0; frame <= TODO_BOARD_TOTAL_FRAMES; frame++) {
			expect(tailCount(boardRows(phases, { frame }))).toBe(16 - TODO_REMINDER_PREVIEW_LIMIT);
		}
	});

	/**
	 * Expanded is the reader asking for the whole thing, so there is nothing left
	 * to withhold and no tail to print.
	 */
	it("withholds nothing when expanded", () => {
		const phases = plan(4, 4);
		const rows = boardRows(phases, { expanded: true });

		expect(taskRows(rows, phases)).toHaveLength(16);
		expect(tailCount(rows)).toBeNull();
	});
});
