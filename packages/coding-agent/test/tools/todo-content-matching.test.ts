import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { applyOpsToPhases, type TodoPhase, TodoTool } from "@veyyon/coding-agent/tools/todo";

/**
 * A todo task has exactly one identity: its free-text content, retyped by the
 * model from an earlier tool result. Every targeting op used raw `===` on it,
 * so a trailing period, a capitalized word, or an en dash where a hyphen was
 * missed the task, and a miss is not soft: the op batch is discarded whole and
 * the board write is lost. That is a second, independent cause of the
 * "updating the todo list fails half the time" the operator reported, on top of
 * the `TodoWrite` shape mismatch already recorded in the failure log.
 *
 * These tests fix the comparison contract: exact text wins, normalized text
 * (lowercased, punctuation and whitespace runs collapsed) is the fallback, and
 * two rows that normalize alike are reported as ambiguous rather than silently
 * resolved to the first, because no op could ever address the second.
 */

function createSession(initialPhases: TodoPhase[]): { session: ToolSession; phases: () => TodoPhase[] } {
	let phases = initialPhases;
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

const board = (): TodoPhase[] => [
	{
		name: "Release prep",
		tasks: [
			{ content: "Rewrite multi-OS install docs", status: "pending" },
			{ content: "Smoke test release readiness", status: "pending" },
		],
	},
];

beforeAll(async () => {
	await initTheme();
});

describe("todo content matching", () => {
	it("marks a task done when the model retypes it with a trailing period and different case", () => {
		const { phases, errors } = applyOpsToPhases(board(), [{ op: "done", task: "rewrite multi-os install docs." }]);

		expect(errors).toEqual([]);
		// The surviving open row is auto-promoted to in_progress by the tool's
		// single-active normalization, which is what makes "completed" here proof
		// that the drifted text resolved rather than silently doing nothing.
		expect(phases[0].tasks).toEqual([
			{ content: "Rewrite multi-OS install docs", status: "completed" },
			{ content: "Smoke test release readiness", status: "in_progress" },
		]);
	});

	it("matches across an en dash the model substituted for a hyphen", () => {
		const { phases, errors } = applyOpsToPhases(
			[{ name: "Fix", tasks: [{ content: "Fix multi-OS install docs", status: "pending" }] }],
			[{ op: "start", task: "Fix multi\u2013OS install docs" }],
		);

		expect(errors).toEqual([]);
		expect(phases[0].tasks[0]).toEqual({ content: "Fix multi-OS install docs", status: "in_progress" });
	});

	it("prefers the exactly matching task over a normalized rival", () => {
		const { phases, errors } = applyOpsToPhases(
			[
				{
					name: "Fix",
					tasks: [
						{ content: "ship it.", status: "pending" },
						{ content: "Ship it", status: "pending" },
					],
				},
			],
			[{ op: "done", task: "Ship it" }],
		);

		expect(errors).toEqual([]);
		expect(phases[0].tasks).toEqual([
			{ content: "ship it.", status: "in_progress" },
			{ content: "Ship it", status: "completed" },
		]);
	});

	it("names both candidates instead of silently picking one when the text is ambiguous", () => {
		const { phases, errors } = applyOpsToPhases(
			[
				{
					name: "Fix",
					tasks: [
						{ content: "Ship it", status: "pending" },
						{ content: "ship it.", status: "pending" },
					],
				},
			],
			// Matches neither exactly, and both after normalization.
			[{ op: "done", task: "SHIP IT!" }],
		);

		expect(errors).toEqual([
			'Task "SHIP IT!" matches 2 tasks ("Ship it", "ship it."); pass the exact text of the one you mean',
		]);
		// Nothing moved: an ambiguous target must not close an arbitrary task.
		expect(phases[0].tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	it("refuses to append a task that only differs from an existing one by punctuation", () => {
		const { phases, errors } = applyOpsToPhases(board(), [
			{ op: "append", phase: "Release prep", items: ["smoke test release readiness!"] },
		]);

		expect(errors).toEqual(['Task "smoke test release readiness!" already exists']);
		expect(phases[0].tasks).toHaveLength(2);
	});

	it("merges init phases that differ only in case and rejects tasks that normalize alike", () => {
		const { phases, errors } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "Release prep", items: ["Encode fixes in tests"] },
						{ phase: "release PREP", items: ["encode fixes in tests."] },
					],
				},
			],
		);

		// One addressable phase, keeping the first-seen spelling.
		expect(phases.map(phase => phase.name)).toEqual(["Release prep"]);
		expect(errors).toEqual(['Duplicate task "encode fixes in tests." in init list']);
	});

	it("lands a TodoWrite completion whose contents drifted from the recorded board", async () => {
		const { session, phases } = createSession(board());
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", {
			merge: true,
			todos: [
				{ id: "1", content: "rewrite multi-OS install docs.", status: "completed" },
				{ id: "2", content: "Smoke test release readiness", status: "completed" },
			],
		});

		expect(result.isError).toBeUndefined();
		// No third row invented from the drifted text, and both rows closed.
		expect(phases()[0].tasks).toEqual([
			{ content: "Rewrite multi-OS install docs", status: "completed" },
			{ content: "Smoke test release readiness", status: "completed" },
		]);
	});

	it("does not resolve punctuation-only text against unrelated punctuation-only tasks", () => {
		const { errors } = applyOpsToPhases(
			[{ name: "Fix", tasks: [{ content: "***", status: "pending" }] }],
			[{ op: "done", task: "???" }],
		);

		expect(errors).toEqual(['Task "???" not found']);
	});
});
