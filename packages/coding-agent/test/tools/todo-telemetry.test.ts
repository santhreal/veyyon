import { describe, expect, it } from "bun:test";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	type TodoOperation,
	type TodoPhase,
	type TodoTaskStateCounts,
	type TodoTaskTransitionCounts,
	TodoTool,
} from "@veyyon/coding-agent/tools/todo";

function createSession(level: InstrumentationLevel, initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	const settings = Settings.isolated();
	settings.set("session.instrumentation", level);
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

const ZERO_TRANSITIONS: TodoTaskTransitionCounts = {
	total: 0,
	added: 0,
	removed: 0,
	toPending: 0,
	toInProgress: 0,
	toDropped: 0,
	toCompleted: 0,
};

interface OperationCase {
	name: string;
	operation: TodoOperation;
	initial: TodoPhase[];
	params: Parameters<TodoTool["execute"]>[1];
	counts: TodoTaskStateCounts;
	transitions: TodoTaskTransitionCounts;
}

const TWO_OPEN: TodoPhase[] = [
	{
		name: "Work",
		tasks: [
			{ content: "one", status: "in_progress" },
			{ content: "two", status: "pending" },
		],
	},
];

const OPERATION_CASES: OperationCase[] = [
	{
		name: "init",
		operation: "init",
		initial: [],
		params: { op: "init", list: [{ phase: "Work", items: ["one", "two"] }] },
		counts: { total: 2, open: 2, inProgress: 1, dropped: 0, completed: 0 },
		transitions: { ...ZERO_TRANSITIONS, total: 2, added: 2 },
	},
	{
		name: "start",
		operation: "start",
		initial: TWO_OPEN,
		params: { op: "start", task: "two" },
		counts: { total: 2, open: 2, inProgress: 1, dropped: 0, completed: 0 },
		transitions: { ...ZERO_TRANSITIONS, total: 2, toPending: 1, toInProgress: 1 },
	},
	{
		name: "done",
		operation: "done",
		initial: TWO_OPEN,
		params: { op: "done", task: "one" },
		counts: { total: 2, open: 1, inProgress: 1, dropped: 0, completed: 1 },
		transitions: { ...ZERO_TRANSITIONS, total: 2, toInProgress: 1, toCompleted: 1 },
	},
	{
		name: "rm",
		operation: "rm",
		initial: TWO_OPEN,
		params: { op: "rm", task: "one" },
		counts: { total: 1, open: 1, inProgress: 1, dropped: 0, completed: 0 },
		transitions: { ...ZERO_TRANSITIONS, total: 2, removed: 1, toInProgress: 1 },
	},
	{
		name: "drop",
		operation: "drop",
		initial: TWO_OPEN,
		params: { op: "drop", task: "one" },
		counts: { total: 2, open: 1, inProgress: 1, dropped: 1, completed: 0 },
		transitions: { ...ZERO_TRANSITIONS, total: 2, toInProgress: 1, toDropped: 1 },
	},
	{
		name: "append",
		operation: "append",
		initial: TWO_OPEN,
		params: { op: "append", phase: "Work", items: ["three"] },
		counts: { total: 3, open: 3, inProgress: 1, dropped: 0, completed: 0 },
		transitions: { ...ZERO_TRANSITIONS, total: 1, added: 1 },
	},
	{
		name: "view",
		operation: "view",
		initial: [
			{
				name: "Work",
				tasks: [
					{ content: "one", status: "in_progress" },
					{ content: "two", status: "completed" },
				],
			},
		],
		params: { op: "view" },
		counts: { total: 2, open: 1, inProgress: 1, dropped: 0, completed: 1 },
		transitions: ZERO_TRANSITIONS,
	},
];

describe("todo task-state telemetry", () => {
	for (const operationCase of OPERATION_CASES) {
		it(`records ${operationCase.name} counts and transitions at basic granularity`, async () => {
			const result = await new TodoTool(createSession("basic", operationCase.initial)).execute(
				`call-${operationCase.name}`,
				operationCase.params,
			);

			expect(result.details?.telemetry).toEqual({
				operation: operationCase.operation,
				counts: operationCase.counts,
				transitions: operationCase.transitions,
			});
		});
	}

	it("keeps off-mode details compact and tool behavior byte-compatible", async () => {
		const params = { op: "init" as const, list: [{ phase: "Work", items: ["one", "two"] }] };
		const offResult = await new TodoTool(createSession("off")).execute("call-off", params);
		const basicResult = await new TodoTool(createSession("basic")).execute("call-basic", params);

		expect(JSON.stringify(offResult.details)).toBe(
			JSON.stringify({
				op: "init",
				phases: [
					{
						name: "Work",
						tasks: [
							{ content: "one", status: "in_progress" },
							{ content: "two", status: "pending" },
						],
					},
				],
				storage: "memory",
			}),
		);
		expect(basicResult.content).toEqual(offResult.content);
		expect(basicResult.details?.phases).toEqual(offResult.details?.phases);
		expect(basicResult.isError).toBe(offResult.isError);
	});

	it("adds pre-state and stable existing-representation references only at rich granularity", async () => {
		const basic = await new TodoTool(createSession("basic", TWO_OPEN)).execute("call-basic", {
			op: "start",
			task: "two",
		});
		const rich = await new TodoTool(createSession("rich", TWO_OPEN)).execute("call-rich", {
			op: "start",
			task: "two",
		});

		expect(basic.details?.telemetry?.before).toBeUndefined();
		expect(basic.details?.telemetry?.affectedPhases).toBeUndefined();
		expect(basic.details?.telemetry?.affectedTasks).toBeUndefined();
		expect(rich.details?.telemetry?.before).toEqual({
			total: 2,
			open: 2,
			inProgress: 1,
			dropped: 0,
			completed: 0,
		});
		expect(rich.details?.telemetry?.affectedPhases).toEqual([{ phase: "Work", phaseOrdinal: 1 }]);
		expect(rich.details?.telemetry?.affectedTasks).toEqual([
			{ phase: "Work", task: "one", phaseOrdinal: 1, taskOrdinal: 1 },
			{ phase: "Work", task: "two", phaseOrdinal: 1, taskOrdinal: 2 },
		]);
		expect(rich.details?.telemetry?.taskTransitions).toBeUndefined();
	});

	it("records per-task transitions at ultra with stable phase/task identity across operations", async () => {
		const tool = new TodoTool(createSession("ultra", TWO_OPEN));
		const started = await tool.execute("call-start", { op: "start", task: "two" });
		const completed = await tool.execute("call-done", { op: "done", task: "two" });
		const startedRef = started.details?.telemetry?.taskTransitions?.find(
			transition => transition.to === "in_progress",
		)?.ref;
		const completedTransition = completed.details?.telemetry?.taskTransitions?.find(
			transition => transition.from === "in_progress" && transition.to === "completed",
		);

		expect(startedRef).toEqual({ phase: "Work", task: "two", phaseOrdinal: 1, taskOrdinal: 2 });
		expect(completedTransition?.ref).toEqual(startedRef);
	});
});
