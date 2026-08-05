import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { applyOpsToPhases, type TodoPhase, TodoTool } from "@veyyon/coding-agent/tools/todo";

/**
 * `init` MERGES repeated phase entries and rejects duplicate task contents.
 *
 * History, because the record matters: merging was not decided by anyone. It
 * arrived in an orphaned refactor that also rewrote this file's first case to
 * defend it, replacing a rejection contract nobody had retired. It was ratified
 * deliberately on 2026-08-04 on one condition, the note channel below.
 *
 * Why merge won. Rejecting cannot lose structure but loses the write: an op
 * batch with any error is discarded whole, so a common parallel-planning shape
 * costs the entire init. Merging cannot lose the write but flattens structure.
 * The tiebreak is addressability: every phase op resolves the FIRST name match,
 * so a board that ended up holding two same-named phases would have a second
 * one no op can ever reach. Merging is the only outcome that leaves the board
 * operable.
 *
 * The condition. Merging silently would be the same defect as the rest of this
 * session: the harness returns something other than what was sent and says
 * nothing. So a merge emits a NOTE, which is not an error: the write landed,
 * the note names which phase collapsed, and the batch is applied.
 */

function createNoteSession(): { session: ToolSession; phases: () => TodoPhase[] } {
	let phases: TodoPhase[] = [];
	return {
		session: {
			cwd: "/tmp/test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		},
		phases: () => phases,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("todo init duplicate adversarial", () => {
	it("merges repeated phase entries into one addressable phase and says so in a note", () => {
		const { phases, errors, notes } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "Same", items: ["a"] },
						{ phase: "Same", items: ["b"] },
					],
				},
			],
		);
		// Two phases with one name would leave the second permanently
		// unaddressable, since every targeting op resolves the first match.
		expect(errors).toEqual([]);
		expect(phases).toHaveLength(1);
		expect(phases[0].name).toBe("Same");
		expect(phases[0].tasks.map(task => task.content)).toEqual(["a", "b"]);
		// The note names the phase that collapsed, so the model can see WHICH
		// structure it lost, and carries no item list.
		expect(notes).toEqual([
			'Merged 2 repeated "Same" phase entries into one phase; every task is addressable through it.',
		]);
		expect(notes[0]).not.toContain('"a"');
	});

	it("counts every repeat of one phase in a single note", () => {
		const { phases, notes } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "Same", items: ["a"] },
						{ phase: "Same", items: ["b"] },
						{ phase: "Same", items: ["c"] },
					],
				},
			],
		);

		expect(phases[0].tasks.map(task => task.content)).toEqual(["a", "b", "c"]);
		expect(notes).toEqual([
			'Merged 3 repeated "Same" phase entries into one phase; every task is addressable through it.',
		]);
	});

	/** The control that keeps the channel from becoming noise on every call. */
	it("emits no note for an init with distinct phases", () => {
		const { notes, errors } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "A", items: ["a"] },
						{ phase: "B", items: ["b"] },
					],
				},
			],
		);

		expect(errors).toEqual([]);
		expect(notes).toEqual([]);
	});

	/**
	 * An entry with NO phase name continues the previous phase. That is the
	 * documented shape, not a collision, so it must not spend the channel.
	 */
	it("emits no note when an unnamed entry continues the previous phase", () => {
		const { phases, notes } = applyOpsToPhases(
			[],
			[{ op: "init", list: [{ phase: "A", items: ["a"] }, { items: ["b"] }] }],
		);

		expect(phases).toHaveLength(1);
		expect(phases[0].tasks.map(task => task.content)).toEqual(["a", "b"]);
		expect(notes).toEqual([]);
	});

	it("a merge note means the write landed: the tool applies it and reports no error", async () => {
		const { session, phases } = createNoteSession();
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Same", items: ["a"] },
				{ phase: "Same", items: ["b"] },
			],
		});

		// Not an error, and the board really changed: this is what separates a
		// note from the `errors[]` channel, which discards the batch.
		expect(result.isError).toBeUndefined();
		expect(phases()).toEqual([
			{
				name: "Same",
				tasks: [
					{ content: "a", status: "in_progress" },
					{ content: "b", status: "pending" },
				],
			},
		]);
		expect(result.details?.notes).toEqual([
			'Merged 2 repeated "Same" phase entries into one phase; every task is addressable through it.',
		]);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("Applied with adjustments:");
		expect(text).not.toContain("Errors:");
	});

	it("keeps a duplicate-task init an error, with nothing applied and no note", async () => {
		const { session, phases } = createNoteSession();
		const tool = new TodoTool(session);

		const result = await tool.execute("call-2", {
			op: "init",
			list: [
				{ phase: "A", items: ["shared"] },
				{ phase: "B", items: ["shared"] },
			],
		});

		expect(result.isError).toBe(true);
		expect(result.details?.notes).toBeUndefined();
		// Discarded whole: the board is untouched.
		expect(phases()).toEqual([]);
	});

	it("duplicate task contents across phases produce errors", () => {
		const { errors } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "A", items: ["shared"] },
						{ phase: "B", items: ["shared"] },
					],
				},
			],
		);
		expect(errors.some(e => /duplicate task/i.test(e))).toBe(true);
	});

	it("duplicate tasks within one phase produce errors", () => {
		const { errors } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [{ phase: "A", items: ["x", "x"] }],
				},
			],
		);
		expect(errors.some(e => /duplicate task/i.test(e))).toBe(true);
	});
});
