/**
 * The exact sentence every tool throws when a cancellation lands mid-sequence.
 *
 * WHY THIS SUITE EXISTS. Three tools do work in steps and can be stopped between them: a
 * multi-file `edit`, a multi-PR `pr_checkout`, and a multi-item `retain`. Each wrote its own
 * version of the same four-clause message, and the shape drifted on the very first attempt --
 * the edit tool shipped `1 of 3 entrys`, because the plural was built by suffixing "s". That is
 * the whole argument for one owner: the clauses, their order, the separator, the count, and
 * which clauses vanish when empty are shared, and only the nouns and the advice are not.
 *
 * The assertions here are on WHOLE MESSAGES rather than fragments. A message assembled from
 * optional clauses fails by having the wrong separator, a stray trailing clause, or an empty
 * list rendered as `already applied: `, and none of those are visible to a `toContain`.
 */

import { describe, expect, it } from "bun:test";
import { abortedPartway } from "@veyyon/coding-agent/tools/aborted-partway";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";

const FILES = { one: "file", many: "files" };

describe("the abort message for a sequence cancelled partway", () => {
	/**
	 * The full shape, every clause present. This is the message an operator actually reads
	 * after pressing Escape during a three-file edit, so it is pinned byte for byte.
	 */
	it("reads as one sentence with the count, what is done, what is not, and the advice", () => {
		const error = abortedPartway(
			{
				operation: "Edit",
				unit: FILES,
				done: ["src/a.ts", "src/b.ts"],
				pending: ["src/c.ts"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
				advice: "re-read the affected files before re-issuing",
			},
			undefined,
		);

		expect(error.message).toBe(
			"Edit cancelled after 2 of 3 files; already applied: src/a.ts, src/b.ts; NOT applied: src/c.ts; re-read the affected files before re-issuing",
		);
	});

	/**
	 * Nothing finished, so the "already" clause is absent rather than empty. An empty list
	 * rendered as `already applied: ` reads as data loss the reader cannot account for.
	 */
	it("omits the done clause entirely when nothing finished", () => {
		const error = abortedPartway(
			{
				operation: "Edit",
				unit: FILES,
				done: [],
				pending: ["src/a.ts", "src/b.ts"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
				advice: "re-read the affected files before re-issuing",
			},
			undefined,
		);

		expect(error.message).toBe(
			"Edit cancelled after 0 of 2 files; NOT applied: src/a.ts, src/b.ts; re-read the affected files before re-issuing",
		);
	});

	/** Everything finished before the signal was noticed: no "NOT" clause to write. */
	it("omits the pending clause when the sequence had already finished", () => {
		const error = abortedPartway(
			{
				operation: "Edit",
				unit: FILES,
				done: ["src/a.ts"],
				pending: [],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
			},
			undefined,
		);

		expect(error.message).toBe("Edit cancelled after 1 of 1 file; already applied: src/a.ts");
	});

	/**
	 * THE REGRESSION THIS OWNER EXISTS FOR. `entry` + "s" is `entrys`, which shipped once.
	 * Both members of the unit pair are spelled out and the singular is used at a total of one.
	 */
	it("uses the spelled-out singular and plural, never a suffixed one", () => {
		const singular = abortedPartway(
			{
				operation: "Edit",
				unit: { one: "entry", many: "entries" },
				done: [],
				pending: ["one"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
			},
			undefined,
		);
		const plural = abortedPartway(
			{
				operation: "Edit",
				unit: { one: "entry", many: "entries" },
				done: [],
				pending: ["one", "two"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
			},
			undefined,
		);

		expect(singular.message).toBe("Edit cancelled after 0 of 1 entry; NOT applied: one");
		expect(plural.message).toBe("Edit cancelled after 0 of 2 entries; NOT applied: one, two");
		expect(plural.message).not.toContain("entrys");
	});

	/**
	 * `adviceWhenDone` is for the thing the reader must know only because something landed:
	 * worktrees on disk, memories in the store. With nothing done there is nothing left behind
	 * and saying so would send the reader looking for it.
	 */
	it("adds the leftover-state advice only when something finished", () => {
		const parts = {
			operation: "PR checkout",
			unit: { one: "pull request", many: "pull requests" },
			pending: ["8"],
			doneLabel: "already checked out",
			pendingLabel: "NOT checked out",
			adviceWhenDone: "the worktrees above are on disk and were left in place",
		};

		const withWork = abortedPartway({ ...parts, done: ["pr-7 at /tmp/wt/pr-7"] }, undefined);
		const withoutWork = abortedPartway({ ...parts, done: [] }, undefined);

		expect(withWork.message).toBe(
			"PR checkout cancelled after 1 of 2 pull requests; already checked out: pr-7 at /tmp/wt/pr-7; NOT checked out: 8; the worktrees above are on disk and were left in place",
		);
		expect(withoutWork.message).toBe("PR checkout cancelled after 0 of 1 pull request; NOT checked out: 8");
	});

	/**
	 * Both advice clauses, in the order a reader needs them: what was left behind first, then
	 * what to do next. Pinned because the two are independent options and their order is not
	 * recoverable from either one alone.
	 */
	it("puts the leftover-state advice before the what-to-do-next advice", () => {
		const error = abortedPartway(
			{
				operation: "Retain",
				unit: { one: "memory", many: "memories" },
				done: ["deploy notes"],
				pending: ["rollback notes"],
				doneLabel: "already stored",
				pendingLabel: "NOT stored",
				adviceWhenDone: "the memories above are in the store and were not rolled back",
				advice: "recall before retaining them again",
			},
			undefined,
		);

		expect(error.message).toBe(
			"Retain cancelled after 1 of 2 memories; already stored: deploy notes; NOT stored: rollback notes; the memories above are in the store and were not rolled back; recall before retaining them again",
		);
	});

	/**
	 * The TYPE is the half the agent loop branches on: a `ToolError` means read the failure and
	 * retry, a `ToolAbortError` means the operator said stop. Tools that folded a cancellation
	 * into an ordinary error result had an Escape answered by a retry of the work just stopped.
	 */
	it("is a ToolAbortError, not an ordinary error", () => {
		const error = abortedPartway(
			{
				operation: "Edit",
				unit: FILES,
				done: [],
				pending: ["src/a.ts"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
			},
			undefined,
		);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect(error.name).toBe("ToolAbortError");
	});

	/**
	 * The cause travels, because it is what distinguishes an Escape from a deadline. It is
	 * carried as `cause` rather than folded into the message, which already has a job.
	 */
	it("carries whatever the signal was aborted with as the cause", () => {
		const reason = new Error("turn deadline expired");
		const error = abortedPartway(
			{
				operation: "Edit",
				unit: FILES,
				done: [],
				pending: ["src/a.ts"],
				doneLabel: "already applied",
				pendingLabel: "NOT applied",
			},
			reason,
		);

		expect(error.cause).toBe(reason);
		expect(error.message).not.toContain("deadline");
	});
});
