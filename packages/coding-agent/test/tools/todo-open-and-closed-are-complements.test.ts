/**
 * WHY: the other half of "a display decision that asks about SOME statuses".
 *
 * THE DEFECT CLASS. The board that would not collapse was one symptom of a
 * habit: code that wants to know whether a task has closed writes
 * `status === "completed" || status === "abandoned"` and code that wants the
 * complement writes `status === "pending" || status === "in_progress"`. The fix
 * that put a `Todo list done` line on the card moved the CARD onto one owner in
 * `@veyyon/wire` and left six of those pairs behind in the model-facing text the
 * same tool returns: the "Overall: X/Y done, Z open" line, the remaining-items
 * count, the active-phase progress, the worked-ahead note, the preview markers
 * and the next-task pointer. A fifth status would have been counted as neither
 * done nor open, so `X + Z < Y`, on a line the model reads to decide what to do
 * next.
 *
 * THE INVARIANT, at the choke point every board crosses: closed and open are
 * COMPLEMENTS of one decision. For any board, whatever statuses it holds:
 *
 *   done + open === total, and every task counted open is one the owner calls
 *   non-terminal.
 *
 * ENUMERATION. Boards are built from `TODO_STATUSES` at run time and swept as a
 * cross product, so a status added to the vocabulary is swept without anyone
 * editing this file, and the compile-time `satisfies never` guards in the tool
 * stop the build until it has a tally, a marker and a glyph.
 *
 * WHAT IT DOES NOT CATCH. The wording of these lines. The assertions are on the
 * arithmetic and on which task is named next, not on the prose around them, so a
 * reworded summary passes here and is caught by the tool's own summary tests.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	type TodoPhase,
	type TodoTaskStateCounts,
	TodoTool,
} from "@veyyon/coding-agent/tools/todo";
import { isTerminalTodoStatus, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";
import { makeToolSession } from "../helpers/tool-session";

interface TodoHarness {
	session: ToolSession;
	/** The board the tool actually stored, which is the oracle after a mutation. */
	stored: () => TodoPhase[];
}

function sessionWith(phases: TodoPhase[]): TodoHarness {
	let current = phases;
	const session = makeToolSession({
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// Telemetry is only recorded above `off`, and the counts are one of the
		// things this file is about, so the tool runs the way an instrumented
		// session runs it.
		settings: Settings.isolated({ "session.instrumentation": "ultra" }),
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
	});
	return { session, stored: () => current };
}

/** A board, one argument per phase. */
function board(...phases: TodoStatus[][]): TodoPhase[] {
	return phases.map((statuses, index) => ({
		name: `Phase ${index + 1}`,
		tasks: statuses.map((status, task) => ({ content: `p${index}-t${task}-${status}`, status })),
	}));
}

/**
 * The model-facing summary for a board, produced by the real tool through its
 * read-only `view` op. This is the text the model reads, not a helper's return
 * value.
 */
async function summaryFor(phases: TodoPhase[]): Promise<string> {
	const result = await new TodoTool(sessionWith(phases).session).execute("c1", { op: "view" });
	return result.content.find(entry => entry.type === "text")?.text ?? "";
}

/** `Overall: <done>/<total> done, <open> open.` parsed back out of the summary. */
function overall(summary: string): { done: number; total: number; open: number } {
	const match = summary.match(/Overall: (\d+)\/(\d+) done, (\d+) open\./);
	if (!match) throw new Error(`summary has no Overall line:\n${summary}`);
	return { done: Number(match[1]), total: Number(match[2]), open: Number(match[3]) };
}

/**
 * The recorded counts, pulled out of the tool result without trusting its
 * shape: a missing telemetry block throws here instead of quietly making the
 * assertions below vacuous.
 */
function telemetryCounts(details: unknown): TodoTaskStateCounts {
	if (!details || typeof details !== "object" || !("telemetry" in details)) {
		throw new Error("tool result carries no telemetry");
	}
	const telemetry = details.telemetry;
	if (!telemetry || typeof telemetry !== "object" || !("counts" in telemetry)) {
		throw new Error("telemetry carries no counts");
	}
	const counts = telemetry.counts;
	if (!counts || typeof counts !== "object") throw new Error("counts is not an object");
	const numbers: Record<string, number> = {};
	for (const field of ["total", "open", "inProgress", "dropped", "completed"]) {
		const value = field in counts ? Reflect.get(counts, field) : undefined;
		if (typeof value !== "number") throw new Error(`counts.${field} is not a number`);
		numbers[field] = value;
	}
	return {
		total: numbers.total,
		open: numbers.open,
		inProgress: numbers.inProgress,
		dropped: numbers.dropped,
		completed: numbers.completed,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("the model-facing todo summary partitions every status", () => {
	it("sweeps a variant space taken from the vocabulary at run time", () => {
		expect(TODO_STATUSES.length).toBeGreaterThan(0);
		expect(TODO_STATUSES.filter(status => isTerminalTodoStatus(status)).length).toBeGreaterThan(0);
		expect(TODO_STATUSES.filter(status => !isTerminalTodoStatus(status)).length).toBeGreaterThan(0);
	});

	/**
	 * The full cross product of two tasks, in one phase and split across two. The
	 * counts must add up and must agree with the owner, board by board — a
	 * partition that is right for `completed` + `pending` and wrong for
	 * `abandoned` + `in_progress` is the defect, not a near miss.
	 */
	it("reports done + open === total for every board of two tasks", async () => {
		let checked = 0;
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const expectedDone = [first, second].filter(status => isTerminalTodoStatus(status)).length;
				for (const phases of [board([first, second]), board([first], [second])]) {
					const counts = overall(await summaryFor(phases));

					expect(counts.total).toBe(2);
					expect(counts.done).toBe(expectedDone);
					expect(counts.open).toBe(2 - expectedDone);
					expect(counts.done + counts.open).toBe(counts.total);
					checked++;
				}
			}
		}
		const statuses = TODO_STATUSES.length;
		expect(checked).toBe(statuses * statuses * 2);
	});

	/** A board of one task of each status, so every member is counted at once. */
	it("counts a board holding every status exactly once", async () => {
		const counts = overall(await summaryFor(board([...TODO_STATUSES])));

		expect(counts.total).toBe(TODO_STATUSES.length);
		expect(counts.done).toBe(TODO_STATUSES.filter(status => isTerminalTodoStatus(status)).length);
		expect(counts.open).toBe(TODO_STATUSES.filter(status => !isTerminalTodoStatus(status)).length);
	});

	/**
	 * The remaining-items line and the Overall open count are the same number
	 * read twice. They were computed by two different hand-written status lists,
	 * which is how they could disagree.
	 */
	it("agrees with itself about how much work is left", async () => {
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const summary = await summaryFor(board([first], [second]));
				const counts = overall(summary);
				const remaining = summary.match(/Remaining items: (none|\d+)\./);

				expect(remaining).not.toBeNull();
				const reported = remaining?.[1] === "none" ? 0 : Number(remaining?.[1]);
				expect(reported).toBe(counts.open);
			}
		}
	});

	/**
	 * The per-phase progress count is the same decision applied to one phase, and
	 * "Active phase: none" claims every phase is closed. Both must follow from the
	 * same owner, or a board reports an active phase with nothing open in it.
	 */
	it("names an active phase exactly when open work remains", async () => {
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const phases = board([first], [second]);
				const summary = await summaryFor(phases);
				const anyOpen = [first, second].some(status => !isTerminalTodoStatus(status));

				if (anyOpen) {
					const expectedPhase = isTerminalTodoStatus(first) ? 2 : 1;
					expect(summary).toContain(`Active phase ${expectedPhase}/2`);
					expect(summary).not.toContain("Active phase: none");
				} else {
					expect(summary).toContain("Active phase: none (all 2 phases are closed).");
				}
			}
		}
	});

	/**
	 * The progress fraction inside the active-phase line, and the worked-ahead
	 * note beside it. Both count closed tasks, one within the active phase and
	 * one across the phases after it, and both were hand-written status lists.
	 * A phase reading "(1/2)" when two of its tasks are closed is the same defect
	 * as the board that would not collapse, one scope down.
	 */
	it("reports the active phase progress and the worked-ahead note from the same decision", async () => {
		const WORKED_AHEAD = "earliest phase with open tasks";
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				for (const third of TODO_STATUSES) {
					const phases = board([first, second], [third]);
					const summary = await summaryFor(phases);
					const activeIdx = phases.findIndex(phase =>
						phase.tasks.some(task => !isTerminalTodoStatus(task.status)),
					);

					if (activeIdx === -1) {
						expect(summary).toContain("Active phase: none (all 2 phases are closed).");
						expect(summary).not.toContain(WORKED_AHEAD);
						continue;
					}
					const active = phases[activeIdx];
					const done = active.tasks.filter(task => isTerminalTodoStatus(task.status)).length;
					expect(summary).toContain(
						`Active phase ${activeIdx + 1}/2 "${active.name}" (${done}/${active.tasks.length})`,
					);

					const workedAhead = phases.some(
						(phase, idx) => idx > activeIdx && phase.tasks.some(task => isTerminalTodoStatus(task.status)),
					);
					expect(summary.includes(WORKED_AHEAD)).toBe(workedAhead);
				}
			}
		}
	});

	/**
	 * The line a MUTATION returns. It is built by a different function from the
	 * `view` body above and carries its own closed count, which is exactly how
	 * one of the two could be fixed and the other left behind. The board the
	 * tool stored is the oracle, so the normalization the mutation runs is part
	 * of the expectation rather than an assumption.
	 */
	it("partitions the same way on the line a mutation returns", async () => {
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const harness = sessionWith(board([first], [second]));
				const result = await new TodoTool(harness.session).execute("c1", {
					op: "append",
					phase: "Phase 1",
					items: ["appended task"],
				});
				const text = result.content.find(entry => entry.type === "text")?.text ?? "";
				const stored = harness.stored().flatMap(phase => phase.tasks);
				const counts = overall(text);

				expect(counts.total).toBe(stored.length);
				expect(counts.done).toBe(stored.filter(task => isTerminalTodoStatus(task.status)).length);
				expect(counts.open).toBe(counts.total - counts.done);
			}
		}
	});

	/**
	 * "Next" is the pointer the model follows. It must name an OPEN task whenever
	 * one exists, and say none only when the board is finished. The pointer named
	 * two open statuses by hand; the fallback now asks the owner.
	 */
	it("points at an open task whenever the board holds one", () => {
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const phases = board([first, second]);
				const next = nextActionableTask(phases);
				const open = phases[0].tasks.filter(task => !isTerminalTodoStatus(task.status));

				if (open.length === 0) {
					expect(next).toBeUndefined();
				} else {
					expect(next).toBeDefined();
					expect(isTerminalTodoStatus(next?.status ?? "completed")).toBe(false);
					// In-progress wins; otherwise the earliest open task.
					const inProgress = open.find(task => task.status === "in_progress");
					expect(next?.content).toBe((inProgress ?? open[0]).content);
				}
			}
		}
	});

	/** An empty board reports nothing done, nothing open, and no next task. */
	it("reports an empty board as empty rather than finished", async () => {
		const summary = await summaryFor([]);

		expect(summary).toBe("Todo list is empty.");
		expect(nextActionableTask([])).toBeUndefined();
	});

	/**
	 * The preview rows under the counts are the part of the summary that names
	 * individual tasks, and each status has its own bracket marker there. Two
	 * statuses sharing a marker makes closed work read as open on the line the
	 * model actually looks at, with the arithmetic above it still correct.
	 *
	 * The markers are pinned by exact equality rather than read back from the
	 * tool, so a status added to the vocabulary has to be given one here before
	 * this passes, and a marker quietly changed to an existing one fails.
	 */
	it("prints a distinct pinned marker for every status in the preview rows", async () => {
		const PINNED_PREVIEW_MARKERS: Record<string, string> = {
			pending: "[ ]",
			in_progress: "[/]",
			completed: "[X]",
			abandoned: "[-]",
		};

		expect(Object.keys(PINNED_PREVIEW_MARKERS).sort()).toEqual([...TODO_STATUSES].sort());
		expect(new Set(Object.values(PINNED_PREVIEW_MARKERS)).size).toBe(TODO_STATUSES.length);

		const phases = board([...TODO_STATUSES]);
		const summary = await summaryFor(phases);

		for (const [index, status] of TODO_STATUSES.entries()) {
			expect(summary).toContain(`- ${PINNED_PREVIEW_MARKERS[status]} p0-t${index}-${status} (Phase 1)`);
		}
	});

	/**
	 * The same partition, on the machine-readable side. `details.telemetry.counts`
	 * is what the session records and what goal verification reads back, and its
	 * `open` was a second hand-written list of the open spellings. A board is
	 * mutated through the real tool and the counts are checked against the board
	 * the tool actually stored, so the normalization the mutation runs is part of
	 * the oracle instead of an assumption.
	 */
	it("counts open work in the recorded telemetry as the complement of closed", async () => {
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const harness = sessionWith(board([first], [second]));
				const result = await new TodoTool(harness.session).execute("c1", {
					op: "append",
					phase: "Phase 1",
					items: ["appended task"],
				});

				const stored = harness.stored().flatMap(phase => phase.tasks);
				const counts = telemetryCounts(result.details);

				expect(counts.total).toBe(stored.length);
				expect(counts.open).toBe(stored.filter(task => !isTerminalTodoStatus(task.status)).length);
				expect(counts.completed + counts.dropped + counts.open).toBe(counts.total);
				expect(counts.inProgress).toBeLessThanOrEqual(counts.open);
			}
		}
	});
});

describe("the markdown round trip keeps every status", () => {
	/**
	 * `phasesToMarkdown` and `markdownToPhases` are the `/todo` editor's two
	 * halves. A status with a marker on the way out and no marker on the way back
	 * silently becomes `pending` when the user saves the file, which turns closed
	 * work back into open work — the collapse defect running backwards through the
	 * editor. Swept over the vocabulary so a new status has to bring both halves.
	 *
	 * The parse normalizes the board to exactly one in-progress task, so the
	 * fixtures below are already normalized and the round trip is an identity.
	 */
	it("round-trips a board holding every status", () => {
		const original = board([...TODO_STATUSES]);
		const { phases, errors } = markdownToPhases(phasesToMarkdown(original));

		expect(errors).toEqual([]);
		expect(phases).toEqual(original);
	});

	it("round-trips each status on its own", () => {
		for (const status of TODO_STATUSES) {
			// An in-progress anchor AFTER the task under test keeps the parse's
			// normalization a no-op for it: a lone `pending` would be promoted, and
			// a second `in_progress` is demoted only when it comes later.
			const original: TodoPhase[] = [
				{ name: "Alpha", tasks: [{ content: `only-${status}`, status }] },
				{ name: "Anchor", tasks: [{ content: "anchor", status: "in_progress" }] },
			];
			const { phases, errors } = markdownToPhases(phasesToMarkdown(original));

			expect(errors).toEqual([]);
			expect(phases[0]?.tasks[0]?.status).toBe(status);
			expect(phases[0]?.tasks[0]?.content).toBe(`only-${status}`);
		}
	});

	/** Every status gets its own marker; two statuses sharing one cannot round-trip. */
	it("gives every status a distinct marker", () => {
		const markers = TODO_STATUSES.map(status => {
			const line = phasesToMarkdown(board([status]))
				.split("\n")
				.find(entry => entry.startsWith("- ["));
			return line?.slice(0, 5);
		});

		expect(new Set(markers).size).toBe(TODO_STATUSES.length);
		expect(markers.filter(marker => marker === undefined)).toEqual([]);
	});
});
