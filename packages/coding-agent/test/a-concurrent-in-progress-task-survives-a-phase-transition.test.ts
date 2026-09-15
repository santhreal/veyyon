/**
 * WHY:
 * In the todo tool, `normalizeInProgressTask` and `applyEntry("start")` previously
 * enforced that at most one task could be `in_progress` at any time. Starting a second
 * task demoted any existing `in_progress` task to `pending`, and completing an active task
 * auto-promoted the earliest open task across phases even when another concurrent worker
 * was actively in progress.
 *
 * This test defends the observable contracts for concurrent tasks:
 * 1. Multiple tasks can remain `in_progress` concurrently (in the same phase or across phases).
 * 2. Starting a task never demotes already active concurrent tasks.
 * 3. Completing one active task preserves remaining concurrent active tasks without prematurely
 *    auto-promoting pending tasks.
 * 4. The phase auto-advance pointer advances only when all active tasks in a phase are resolved.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	type TodoPhase,
	TodoTool,
} from "@veyyon/coding-agent/tools/agent/todo";

function createSession(initialPhases: TodoPhase[] = []): { session: ToolSession; phases: () => TodoPhase[] } {
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

describe("concurrent in-progress tasks across phase transitions", () => {
	it("two tasks in progress in phase 1: completing one preserves the other and respects phase pointer", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		// Step 1: Initialize two phases
		const initResult = await tool.execute("call-init", {
			op: "init",
			list: [
				{ phase: "Phase 1", items: ["Task 1A", "Task 1B"] },
				{ phase: "Phase 2", items: ["Task 2A", "Task 2B"] },
			],
		});
		expect(initResult.isError).toBeUndefined();

		// Task 1A auto-starts as the first task; Task 1B and Phase 2 tasks start pending
		expect(phases()[0]?.tasks[0]?.status).toBe("in_progress");
		expect(phases()[0]?.tasks[1]?.status).toBe("pending");
		expect(phases()[1]?.tasks[0]?.status).toBe("pending");

		// Step 2: Concurrently start Task 1B in Phase 1
		const startResult = await tool.execute("call-start", {
			op: "start",
			task: "Task 1B",
		});
		expect(startResult.isError).toBeUndefined();

		// Both Task 1A and Task 1B must now be in_progress in Phase 1
		const phase1TasksAfterStart = phases()[0]?.tasks ?? [];
		expect(phase1TasksAfterStart.find(t => t.content === "Task 1A")?.status).toBe("in_progress");
		expect(phase1TasksAfterStart.find(t => t.content === "Task 1B")?.status).toBe("in_progress");
		expect(phases()[1]?.tasks[0]?.status).toBe("pending");

		// Step 3: Complete Task 1A
		const doneResultA = await tool.execute("call-done-a", {
			op: "done",
			task: "Task 1A",
		});
		expect(doneResultA.isError).toBeUndefined();

		// Task 1A is completed, and Task 1B MUST STAY in_progress
		const phase1TasksAfterDoneA = phases()[0]?.tasks ?? [];
		expect(phase1TasksAfterDoneA.find(t => t.content === "Task 1A")?.status).toBe("completed");
		expect(phase1TasksAfterDoneA.find(t => t.content === "Task 1B")?.status).toBe("in_progress");

		// Phase 2 tasks MUST NOT have auto-promoted because Task 1B is still active in Phase 1
		expect(phases()[1]?.tasks[0]?.status).toBe("pending");
		expect(phases()[1]?.tasks[1]?.status).toBe("pending");

		// Next actionable task is the remaining in-progress task in Phase 1
		expect(nextActionableTask(phases())?.content).toBe("Task 1B");

		// The mutation summary must show Task 1B in Phase 1 as next actionable
		const summaryDoneA = doneResultA.content.find(part => part.type === "text");
		if (summaryDoneA?.type !== "text") throw new Error("Expected text summary");
		expect(summaryDoneA.text).toBe("Completed: Task 1A. Next: Task 1B (Phase 1). Overall: 1/4 done, 3 open.");

		// A view call reflects Phase 1 as the active phase
		const viewResultA = await tool.execute("call-view-a", { op: "view" });
		const viewSummaryA = viewResultA.content.find(part => part.type === "text");
		if (viewSummaryA?.type !== "text") throw new Error("Expected text summary");
		expect(viewSummaryA.text).toContain("Active phase 1/2 \"Phase 1\"");
		// Step 4: Complete Task 1B
		const doneResultB = await tool.execute("call-done-b", {
			op: "done",
			task: "Task 1B",
		});
		expect(doneResultB.isError).toBeUndefined();

		// Now Phase 1 is fully completed, no active tasks remain, so pointer advances to Phase 2:
		// Task 2A auto-promotes to in_progress
		expect(phases()[0]?.tasks[0]?.status).toBe("completed");
		expect(phases()[0]?.tasks[1]?.status).toBe("completed");
		expect(phases()[1]?.tasks[0]?.status).toBe("in_progress");
		expect(phases()[1]?.tasks[1]?.status).toBe("pending");

		expect(nextActionableTask(phases())?.content).toBe("Task 2A");

		const summaryDoneB = doneResultB.content.find(part => part.type === "text");
		if (summaryDoneB?.type !== "text") throw new Error("Expected text summary");
		expect(summaryDoneB.text).toBe("Completed: Task 1B. Next: Task 2A (Phase 2). Overall: 2/4 done, 2 open.");

		// A view call reflects Phase 2 as the active phase
		const viewResultB = await tool.execute("call-view-b", { op: "view" });
		const viewSummaryB = viewResultB.content.find(part => part.type === "text");
		if (viewSummaryB?.type !== "text") throw new Error("Expected text summary");
		expect(viewSummaryB.text).toContain("Active phase 2/2 \"Phase 2\"");
	});

	it("starting a task in a later phase preserves existing in-progress task in earlier phase", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		await tool.execute("call-init", {
			op: "init",
			list: [
				{ phase: "Analysis", items: ["Investigate bug"] },
				{ phase: "Fix", items: ["Apply patch"] },
			],
		});

		expect(phases()[0]?.tasks[0]?.status).toBe("in_progress");

		// Start task in Phase 2
		const startResult = await tool.execute("call-start-fix", {
			op: "start",
			task: "Apply patch",
		});
		expect(startResult.isError).toBeUndefined();

		// Both tasks must remain in_progress across phases
		expect(phases()[0]?.tasks[0]?.status).toBe("in_progress");
		expect(phases()[1]?.tasks[0]?.status).toBe("in_progress");

		// Out of order completion: completing the later phase task preserves earlier phase task
		const doneFixResult = await tool.execute("call-done-fix", {
			op: "done",
			task: "Apply patch",
		});
		expect(doneFixResult.isError).toBeUndefined();

		expect(phases()[0]?.tasks[0]?.status).toBe("in_progress");
		expect(phases()[1]?.tasks[0]?.status).toBe("completed");
	});

	it("markdown import preserves multiple concurrent in-progress tasks", () => {
		const md = [
			"# Phase 1",
			"- [/] Concurrent Task 1",
			"- [/] Concurrent Task 2",
			"# Phase 2",
			"- [ ] Pending Task 3",
		].join("\n");

		const { phases, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		expect(phases[0]?.tasks[0]?.status).toBe("in_progress");
		expect(phases[0]?.tasks[1]?.status).toBe("in_progress");
		expect(phases[1]?.tasks[0]?.status).toBe("pending");

		const roundtrip = phasesToMarkdown(phases);
		expect(roundtrip).toContain("- [/] Concurrent Task 1");
		expect(roundtrip).toContain("- [/] Concurrent Task 2");
		expect(roundtrip).toContain("- [ ] Pending Task 3");
	});
});
