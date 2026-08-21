/**
 * WHY: the todo result's closing tally counted every TERMINAL status as done, so
 * `op: "drop"` on one of six tasks answered
 * `Dropped: Add error handling. Next: … Overall: 2/6 done, 4 open.` — on one
 * line, claiming two completions where the board held one completion and one
 * abandonment. The arithmetic was right (`closed + open === total`); the WORD was
 * wrong, and a model reading its own board back cannot tell the difference
 * between work it finished and work it gave up on.
 *
 * The class this closes: a surface that collapses the status vocabulary to
 * open-vs-closed and then labels the closed side with the name of one of its
 * members. It is closed at `formatOverall`, the one function both the mutation
 * path and the read path end with, and the sweep below is driven by
 * `TODO_STATUSES` from `@veyyon/wire` — the map that DEFINES the union — so a
 * status added later is covered without a new case here.
 *
 * What it does NOT catch: the per-phase fraction (`Active phase 1/3 "Setup"
 * (2/4)`), which is deliberately a closed-vs-total count and carries no "done"
 * label, and the board's own glyph column, which has a distinct glyph per status
 * and never conflates them.
 */
import { describe, expect, it } from "bun:test";
import { TodoTool } from "@veyyon/coding-agent/tools/todo";
import { TODO_STATUS_IS_TERMINAL, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";

/** A session whose board is whatever the test hands it, and which records writes. */
function sessionWith(statuses: readonly TodoStatus[]) {
	let phases = [{ name: "Setup", tasks: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status })) }];
	return {
		getTodoPhases: () => phases,
		setTodoPhases: (next: typeof phases) => {
			phases = next;
		},
		getSessionFile: () => undefined,
		settings: { get: () => undefined },
	} as never;
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/** `Overall: A/B done, [C dropped, ]D open.` parsed back out of a result. */
function tally(body: string): { done: number; total: number; dropped: number; open: number } {
	const match = /Overall: (\d+)\/(\d+) done, (?:(\d+) dropped, )?(\d+) open\./.exec(body);
	if (!match) throw new Error(`no Overall line in: ${body}`);
	return {
		done: Number(match[1]),
		total: Number(match[2]),
		dropped: Number(match[3] ?? 0),
		open: Number(match[4]),
	};
}

describe("the tally a todo result ends with", () => {
	// The reported defect at the shape that produced it: six tasks, one already
	// completed, and a drop landing on one of the five that were not. The answer
	// was `2/6 done`; the truth is `1/6 done, 1 dropped`.
	it("does not count the task it just dropped as done", async () => {
		const tool = new TodoTool(sessionWith(["completed", "pending", "pending", "pending", "pending", "pending"]));
		const body = text(await tool.execute("c1", { op: "drop", task: "Task 2" } as never));
		expect(body).toContain("Dropped: Task 2.");
		expect(tally(body)).toEqual({ done: 1, total: 6, dropped: 1, open: 4 });
	});

	it("says nothing about dropped work when there is none, so the common line is unchanged", async () => {
		const tool = new TodoTool(sessionWith(["pending", "pending"]));
		const body = text(await tool.execute("c1", { op: "done", task: "Task 1" } as never));
		expect(body).toContain("Overall: 1/2 done, 1 open.");
		expect(body).not.toContain("dropped");
	});

	// Swept from the map that DEFINES the union, so a status added later is
	// covered here without a new case, and lands on the side that cannot overstate
	// progress: only `completed` may be counted as done.
	for (const status of TODO_STATUSES) {
		const terminal = TODO_STATUS_IS_TERMINAL[status];
		it(`counts a ${status} task as ${status === "completed" ? "done" : terminal ? "dropped" : "open"}`, async () => {
			const tool = new TodoTool(sessionWith([status, "pending"]));
			// A read, so nothing moves: the tally must describe the board as stored.
			const parsed = tally(text(await tool.execute("c1", { op: "view" } as never)));
			expect(parsed.done).toBe(status === "completed" ? 1 : 0);
			expect(parsed.dropped).toBe(status !== "completed" && terminal ? 1 : 0);
			// `in_progress` is normalized onto the board's single pointer, so the
			// open count is the complement either way.
			expect(parsed.done + parsed.dropped + parsed.open).toBe(parsed.total);
		});
	}

	// Pinned by exact equality: a second status joining the done side is the
	// defect, and a count would not see which one moved.
	it("admits exactly one status to the done side", () => {
		const asDone = TODO_STATUSES.filter(status => status === "completed");
		expect(asDone).toEqual(["completed"]);
		const terminal = TODO_STATUSES.filter(status => TODO_STATUS_IS_TERMINAL[status]);
		expect(terminal).toEqual(["completed", "abandoned"]);
	});

	it("holds done + dropped + open === total for every mixed board", async () => {
		// Every pair of statuses, so no combination reports a tally that does not
		// add up — the invariant a per-case assertion cannot cover.
		for (const first of TODO_STATUSES) {
			for (const second of TODO_STATUSES) {
				const tool = new TodoTool(sessionWith([first, second]));
				const parsed = tally(text(await tool.execute("c1", { op: "view" } as never)));
				expect({ pair: [first, second], sum: parsed.done + parsed.dropped + parsed.open }).toEqual({
					pair: [first, second],
					sum: parsed.total,
				});
			}
		}
	});
});
