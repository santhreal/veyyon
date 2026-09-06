import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	renderTodoBoardLines,
	type TodoBoardOptions,
	todoBoardIsLive,
	todoBoardRailTravels,
} from "@veyyon/coding-agent/modes/components/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	incompleteTodoItems,
	renderTodoContinuationReminder,
	renderTodoStatePreview,
} from "@veyyon/coding-agent/session/todo-reminder";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	type TodoPhase,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_TOTAL_PREVIEW_WIDTH,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@veyyon/coding-agent/tools/todo";

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

function boardOptions(overrides: Partial<TodoBoardOptions> = {}): TodoBoardOptions {
	return {
		columns: 100,
		maxRows: 14,
		expanded: true,
		owned: new Set<string>(),
		frame: 0,
		animate: true,
		live: true,
		...overrides,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("concurrent todo tasks: production-path regression and backtest", () => {
	/**
	 * Production reproduction of the reported defect:
	 * Starting a second task across different phases previously demoted earlier
	 * active tasks to "pending" at applyEntry(start) and normalizeInProgressTask.
	 */
	it("starting a second task across phases preserves both tasks as in_progress", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		// Step 1: Initialize 3 phases
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Analysis", items: ["Investigate API surface"] },
				{ phase: "Core", items: ["Implement concurrent support"] },
				{ phase: "Verification", items: ["Verify GUI motion across phases"] },
			],
		});

		// First task is auto-started on init because no active task exists
		expect(phases()[0]!.tasks[0]!.status).toBe("in_progress");
		expect(phases()[1]!.tasks[0]!.status).toBe("pending");
		expect(phases()[2]!.tasks[0]!.status).toBe("pending");

		// Step 2: Start a task in Phase 2
		const startResult = await tool.execute("call-2", {
			op: "start",
			task: "Implement concurrent support",
		});
		expect(startResult.isError).toBeUndefined();

		const current = phases();
		const taskPhase1 = current[0]!.tasks[0]!;
		const taskPhase2 = current[1]!.tasks[0]!;
		const taskPhase3 = current[2]!.tasks[0]!;

		// CRITICAL DEFECT CHECK:
		// Previously, taskPhase1 was demoted to "pending". Both MUST remain "in_progress".
		expect(taskPhase1.status).toBe("in_progress");
		expect(taskPhase2.status).toBe("in_progress");
		expect(taskPhase3.status).toBe("pending");

		// Summaries distinguish focus (nextActionableTask returns the leading active task) from concurrency
		expect(nextActionableTask(current)?.content).toBe("Investigate API surface");
	});

	/**
	 * GUI + motion across phases:
	 * When multiple tasks are in progress across different phases, the board renderer
	 * must draw both with active working marks and animate both without dropping one to [ ].
	 */
	it("renders active working marks and pulsing motion across multiple phases", () => {
		const phases: TodoPhase[] = [
			{ name: "Analysis", tasks: [{ content: "Investigate API surface", status: "in_progress" }] },
			{ name: "Core", tasks: [{ content: "Implement concurrent support", status: "in_progress" }] },
			{ name: "Verification", tasks: [{ content: "Verify GUI motion across phases", status: "pending" }] },
		];

		expect(todoBoardIsLive(phases, new Set())).toBe(true);
		expect(todoBoardRailTravels({ transitions: true, agentInMotion: true, live: todoBoardIsLive(phases, new Set()) })).toBe(true);

		// Frame 0 rendering
		const linesFrame0 = renderTodoBoardLines(phases, boardOptions({ frame: 0, animate: true }));
		const textFrame0 = linesFrame0.map(l => Bun.stripANSI(l)).join("\n");

		// Both tasks must appear with active glyphs, neither as pending checkbox "[ ]"
		expect(textFrame0).toContain("Investigate API surface");
		expect(textFrame0).toContain("Implement concurrent support");
		expect(textFrame0).toContain("Verify GUI motion across phases");

		// Verification is pending, so it should carry unchecked checkbox glyph
		const verificationLine = linesFrame0.find(l => Bun.stripANSI(l).includes("Verify GUI motion across phases")) ?? "";
		expect(verificationLine).toContain(theme.checkbox.unchecked);

		// Both Phase 1 and Phase 2 lines carry the active workingMark (accent), not unchecked checkbox
		const phase1Line0 = linesFrame0.find(l => Bun.stripANSI(l).includes("Investigate API surface")) ?? "";
		const phase2Line0 = linesFrame0.find(l => Bun.stripANSI(l).includes("Implement concurrent support")) ?? "";
		expect(phase1Line0).not.toContain(theme.checkbox.unchecked);
		expect(phase2Line0).not.toContain(theme.checkbox.unchecked);
		expect(phase1Line0).toContain(theme.symbol("status.shadowed"));
		expect(phase2Line0).toContain(theme.symbol("status.shadowed"));

		// Frame 1 rendering: alternation of working mark proves pulsing motion on both
		const linesFrame1 = renderTodoBoardLines(phases, boardOptions({ frame: 1, animate: true }));
		const phase1Line1 = linesFrame1.find(l => Bun.stripANSI(l).includes("Investigate API surface")) ?? "";
		const phase2Line1 = linesFrame1.find(l => Bun.stripANSI(l).includes("Implement concurrent support")) ?? "";
		expect(phase1Line1).toContain(theme.symbol("status.done"));
		expect(phase2Line1).toContain(theme.symbol("status.done"));
	});

	/**
	 * Completion and drop lifecycle:
	 * Completing one concurrent active task preserves other active tasks and does NOT
	 * prematurely auto-promote pending tasks until all active tasks finish.
	 */
	it("completion and drop preserve remaining concurrent tasks without premature autopromotion", async () => {
		const { session, phases } = createSession([
			{ name: "Phase 1", tasks: [{ content: "Task A", status: "in_progress" }] },
			{ name: "Phase 2", tasks: [{ content: "Task B", status: "in_progress" }] },
			{ name: "Phase 3", tasks: [{ content: "Task C", status: "pending" }] },
		]);
		const tool = new TodoTool(session);

		// Complete Task A: Task B is still in progress, so Task C MUST NOT be auto-promoted
		const doneResult = await tool.execute("call-done-a", { op: "done", task: "Task A" });
		expect(doneResult.isError).toBeUndefined();

		expect(phases()[0]!.tasks[0]!.status).toBe("completed");
		expect(phases()[1]!.tasks[0]!.status).toBe("in_progress");
		expect(phases()[2]!.tasks[0]!.status).toBe("pending"); // NOT promoted because Task B is still active

		// Now complete Task B: now NO tasks are active, so Task C is auto-promoted to in_progress
		const doneResultB = await tool.execute("call-done-b", { op: "done", task: "Task B" });
		expect(doneResultB.isError).toBeUndefined();

		expect(phases()[0]!.tasks[0]!.status).toBe("completed");
		expect(phases()[1]!.tasks[0]!.status).toBe("completed");
		expect(phases()[2]!.tasks[0]!.status).toBe("in_progress"); // Auto-promoted because 0 active tasks remained
	});

	/**
	 * Markdown import/export roundtrip must preserve multiple in_progress tasks without demoting to pending.
	 */
	it("markdown import/export preserves multiple concurrent in_progress tasks", () => {
		const md = [
			"# Phase 1",
			"- [/] Concurrent Task 1",
			"# Phase 2",
			"- [/] Concurrent Task 2",
			"# Phase 3",
			"- [ ] Queued Task 3",
		].join("\n");

		const { phases, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		expect(phases).toHaveLength(3);
		// DEFECT CHECK: normalizeInProgressTask previously demoted Concurrent Task 2 to "pending"
		expect(phases[0]!.tasks[0]!.status).toBe("in_progress");
		expect(phases[1]!.tasks[0]!.status).toBe("in_progress");
		expect(phases[2]!.tasks[0]!.status).toBe("pending");

		// Round-trip back to markdown
		const backMd = phasesToMarkdown(phases);
		expect(backMd).toContain("- [/] Concurrent Task 1");
		expect(backMd).toContain("- [/] Concurrent Task 2");
		expect(backMd).toContain("- [ ] Queued Task 3");
	});

	/**
	 * Compatibility TodoWrite batches:
	 * Whole-board writes with multiple in_progress items must not demote extra active tasks.
	 */
	it("TodoWrite compatibility whole-board write retains multiple in_progress tasks", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		const result = await tool.execute("compat-1", {
			merge: false,
			todos: [
				{ content: "Worker Alpha task", status: "in_progress" },
				{ content: "Worker Beta task", status: "in_progress" },
				{ content: "Pending task", status: "pending" },
			],
		});
		expect(result.isError).toBeUndefined();

		const current = phases();
		const inProgress = current[0]!.tasks.filter(t => t.status === "in_progress");
		// DEFECT CHECK: Previously only 1 task remained in_progress
		expect(inProgress).toHaveLength(2);
		expect(inProgress.map(t => t.content)).toEqual(["Worker Alpha task", "Worker Beta task"]);
	});

	/**
	 * Session persistence & restore:
	 * Entries with multiple concurrent tasks retain their status on restore, and subsequent
	 * operations on the restored session do not trigger demotion.
	 */
	it("preserves concurrent task status across session entries and subsequent operations", async () => {
		const initialPhases: TodoPhase[] = [
			{ name: "Phase 1", tasks: [{ content: "Task 1", status: "in_progress" }] },
			{ name: "Phase 2", tasks: [{ content: "Task 2", status: "in_progress" }] },
		];

		const entries = [
			{
				type: "custom" as const,
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: initialPhases },
			},
		];

		const restored = getLatestTodoPhasesFromEntries(entries);
		expect(restored[0]!.tasks[0]!.status).toBe("in_progress");
		expect(restored[1]!.tasks[0]!.status).toBe("in_progress");

		// Run a subsequent operation in a session initialized with restored phases
		const { session, phases } = createSession(restored);
		const tool = new TodoTool(session);

		// Append a task to Phase 3
		await tool.execute("call-append", {
			op: "append",
			phase: "Phase 3",
			items: ["Task 3"],
		});

		// Both Task 1 and Task 2 must remain in_progress
		expect(phases()[0]!.tasks[0]!.status).toBe("in_progress");
		expect(phases()[1]!.tasks[0]!.status).toBe("in_progress");
		expect(phases()[2]!.tasks[0]!.status).toBe("pending");
	});

	/**
	 * B1: TodoWrite explicit incoming pending resets targeted active tasks while
	 * preserving omitted active items under merge.
	 */
	it("TodoWrite explicit pending resets targeted active tasks without demoting omitted items", async () => {
		const { session, phases } = createSession([
			{
				name: "Phase 1",
				tasks: [
					{ content: "Task A", status: "in_progress" },
					{ content: "Task B", status: "pending" },
				],
			},
			{
				name: "Phase 2",
				tasks: [{ content: "Task C", status: "in_progress" }],
			},
		]);
		const tool = new TodoTool(session);

		// Incoming write explicitly marks Task A as pending, Task B as in_progress, and omits Task C
		const result = await tool.execute("compat-explicit-pending", {
			merge: true,
			todos: [
				{ content: "Task A", status: "pending" },
				{ content: "Task B", status: "in_progress" },
			],
		});
		expect(result.isError).toBeUndefined();

		const current = phases();
		// Task A: was in_progress, explicitly sent as pending -> MUST be pending (no stale active accumulated)
		expect(current[0]!.tasks.find(t => t.content === "Task A")?.status).toBe("pending");
		// Task B: was pending, explicitly sent as in_progress -> MUST be in_progress
		expect(current[0]!.tasks.find(t => t.content === "Task B")?.status).toBe("in_progress");
		// Task C: was in_progress, omitted from incoming list with merge: true -> MUST remain in_progress (merge semantics preserved)
		expect(current[1]!.tasks.find(t => t.content === "Task C")?.status).toBe("in_progress");
	});

	/**
	 * N1: Default collapsed board renders tasks for ALL active phases with in-progress work.
	 */
	it("default collapsed board renders tasks for all phases holding in-progress tasks", () => {
		const phases: TodoPhase[] = [
			{ name: "Phase 1", tasks: [{ content: "Task 1", status: "in_progress" }] },
			{ name: "Phase 2", tasks: [{ content: "Task 2", status: "in_progress" }] },
			{ name: "Phase 3", tasks: [{ content: "Task 3", status: "pending" }] },
		];

		// Render in default collapsed mode (expanded: false)
		const lines = renderTodoBoardLines(phases, boardOptions({ expanded: false }));
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");

		// Both Phase 1 and Phase 2 tasks MUST be drawn, not hidden
		expect(text).toContain("Task 1");
		expect(text).toContain("Task 2");

		// Phase 3 has only pending tasks and is not activeIdx, so its tasks are not drawn when collapsed
		expect(text).not.toContain("Task 3");
		expect(text).toContain("Phase 3"); // But its header is present
	});

	/**
	 * N2: Agent-session state preview and continuation reminder represent concurrent active tasks truthfully.
	 */
	it("agent-session state preview and continuation reminder represent multiple active tasks truthfully", () => {
		const phases: TodoPhase[] = [
			{ name: "Phase 1", tasks: [{ content: "Active Task 1", status: "in_progress" }] },
			{ name: "Phase 2", tasks: [{ content: "Active Task 2", status: "in_progress" }] },
			{ name: "Phase 3", tasks: [{ content: "Pending Task 3", status: "pending" }] },
		];

		const preview = renderTodoStatePreview(phases);
		// Truthful multi-active representation: lists active tasks with [/], does not falsely reduce to single Active/next
		expect(preview).toContain("Active items (2 in progress):");
		expect(preview).toContain("- [/] Active Task 1 (Phase 1)");
		expect(preview).toContain("- [/] Active Task 2 (Phase 2)");

		const reminder = renderTodoContinuationReminder({
			items: incompleteTodoItems(phases),
			attempt: 1,
			maxAttempts: 3,
			echoFullList: false,
		});
		expect(reminder).toContain("Active items (2 in progress):");
		expect(reminder).toContain("[/] Active Task 1 (Phase 1)");
		expect(reminder).toContain("[/] Active Task 2 (Phase 2)");
	});

	/**
	 * Real observable tests for op: "pending" (targeted task, targeted phase, no-target all tasks)
	 * and summary formatting without 'undefined'.
	 */
	it("op pending resets targeted task, targeted phase, and all tasks without undefined in summary", async () => {
		const { session, phases } = createSession([
			{
				name: "Phase 1",
				tasks: [
					{ content: "Task 1A", status: "in_progress" },
					{ content: "Task 1B", status: "in_progress" },
				],
			},
			{
				name: "Phase 2",
				tasks: [
					{ content: "Task 2A", status: "in_progress" },
					{ content: "Task 2B", status: "completed" },
				],
			},
		]);
		const tool = new TodoTool(session);

		// 1. Target single task
		const resTask = await tool.execute("call-p-task", { op: "pending", task: "Task 1A" });
		expect(resTask.isError).toBeUndefined();
		expect(phases()[0]!.tasks.find(t => t.content === "Task 1A")?.status).toBe("pending");
		expect(phases()[0]!.tasks.find(t => t.content === "Task 1B")?.status).toBe("in_progress");
		const summaryTask = resTask.content.find(c => c.type === "text")?.text ?? "";
		expect(summaryTask).toContain("Reset to pending: Task 1A.");
		expect(summaryTask).not.toContain("undefined");

		// 2. Target phase
		const resPhase = await tool.execute("call-p-phase", { op: "pending", phase: "Phase 1" });
		expect(resPhase.isError).toBeUndefined();
		expect(phases()[0]!.tasks.every(t => t.status === "pending")).toBe(true);
		const summaryPhase = resPhase.content.find(c => c.type === "text")?.text ?? "";
		expect(summaryPhase).toContain("Reset phase to pending: Phase 1.");
		expect(summaryPhase).not.toContain("undefined");

		// 3. No target: resets all tasks
		const resAll = await tool.execute("call-p-all", { op: "pending" });
		expect(resAll.isError).toBeUndefined();
		const summaryAll = resAll.content.find(c => c.type === "text")?.text ?? "";
		expect(summaryAll).toContain("Reset all tasks to pending.");
		expect(summaryAll).not.toContain("undefined");

		// 4. Verify no-target done and drop summaries never contain "undefined"
		const resDone = await tool.execute("call-d-all", { op: "done" });
		const summaryDone = resDone.content.find(c => c.type === "text")?.text ?? "";
		expect(summaryDone).toContain("Completed all tasks.");
		expect(summaryDone).not.toContain("undefined");

		const resDrop = await tool.execute("call-drop-all", { op: "drop" });
		const summaryDrop = resDrop.content.find(c => c.type === "text")?.text ?? "";
		expect(summaryDrop).toContain("Dropped all tasks.");
		expect(summaryDrop).not.toContain("undefined");
	});

	/**
	 * Bounded overflow notice for active phases beyond SUBSEQUENT_PHASE_CAP in collapsed view.
	 */
	it("displays bounded overflow notice for active phases beyond cap in collapsed view", () => {
		const phases: TodoPhase[] = Array.from({ length: 8 }, (_, i) => ({
			name: `Phase ${i + 1}`,
			tasks: [
				{
					content: `Task ${i + 1}`,
					// Phase 1 is activeIdx, Phase 7 is beyond SUBSEQUENT_PHASE_CAP (4) and holds in_progress work
					status: i === 0 || i === 6 ? "in_progress" : "pending",
				},
			],
		}));

		const lines = renderTodoBoardLines(phases, boardOptions({ expanded: false }));
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");

		// Must display bounded overflow notice naming the active phase beyond cap
		expect(text).toContain("… 1 more active phase(s) (Phase 7)");
	});

	/**
	 * Explicit pending operations (sole-task, last-active phase, all-task, TodoWrite)
	 * must persist an all-pending state without auto-promoting a task to in_progress.
	 */
	it("preserves all-pending state on sole-task, last-active phase, all-task, and TodoWrite pending resets", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		// 1. Initialize with single task
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Solo", items: ["Only Task"] }],
		});
		expect(phases()[0]!.tasks[0]!.status).toBe("in_progress");

		// Reset the sole active task to pending
		const soleRes = await tool.execute("call-2", {
			op: "pending",
			task: "Only Task",
		});
		expect(soleRes.isError).toBeUndefined();
		expect(phases()[0]!.tasks[0]!.status).toBe("pending");
		expect(phases().flatMap(p => p.tasks).some(t => t.status === "in_progress")).toBe(false);

		// 2. Multiple phases: Phase 1 completed, Phase 2 in_progress
		await tool.execute("call-3", {
			op: "init",
			list: [
				{ phase: "DonePhase", items: ["Completed Task"] },
				{ phase: "ActivePhase", items: ["Pending Task", "Active Task"] },
			],
		});
		await tool.execute("call-4", { op: "done", task: "Completed Task" });
		await tool.execute("call-5", { op: "start", task: "Active Task" });
		expect(phases()[1]!.tasks[1]!.status).toBe("in_progress");

		// Reset the only phase holding an active task
		const phaseRes = await tool.execute("call-6", { op: "pending", phase: "ActivePhase" });
		expect(phaseRes.isError).toBeUndefined();
		expect(phases()[1]!.tasks[0]!.status).toBe("pending");
		expect(phases()[1]!.tasks[1]!.status).toBe("pending");
		expect(phases().flatMap(p => p.tasks).some(t => t.status === "in_progress")).toBe(false);

		// 3. Reset all tasks
		await tool.execute("call-7", { op: "start", task: "Pending Task" });
		expect(phases()[1]!.tasks[0]!.status).toBe("in_progress");
		const allRes = await tool.execute("call-8", { op: "pending" });
		expect(allRes.isError).toBeUndefined();
		expect(phases().flatMap(p => p.tasks).every(t => t.status !== "in_progress")).toBe(true);

		// 4. TodoWrite compatibility with all pending tasks
		const writeRes = await tool.execute("call-9", {
			todos: [
				{ content: "Write A", status: "pending" },
				{ content: "Write B", status: "pending" },
			],
			merge: false,
		} as unknown as Parameters<typeof tool.execute>[1]);
		expect(writeRes.isError).toBeUndefined();
		expect(phases().flatMap(p => p.tasks).every(t => t.status === "pending")).toBe(true);
	});

	/**
	 * Multi-active reminders must enforce TODO_TOTAL_PREVIEW_WIDTH and TODO_REMINDER_PREVIEW_LIMIT together.
	 */
	it("bounds multi-active reminders by row limit and total preview width", () => {
		const longName = "A".repeat(100);
		const phases: TodoPhase[] = Array.from({ length: 10 }, (_, i) => ({
			name: `Phase ${i + 1}`,
			tasks: [{ content: `Long task ${i + 1} ${longName}`, status: "in_progress" }],
		}));

		const statePreview = renderTodoStatePreview(phases);
		expect(statePreview).toContain("Active items (10 in progress):");
		expect(statePreview.length).toBeLessThanOrEqual(TODO_TOTAL_PREVIEW_WIDTH + 200);
		expect(statePreview).toContain("more active item(s)");

		const reminder = renderTodoContinuationReminder({
			items: incompleteTodoItems(phases),
			attempt: 1,
			maxAttempts: 3,
			previewItemWidth: TODO_ITEM_PREVIEW_WIDTH,
		});
		expect(reminder).toContain("Active items (10 in progress):");
		const activeLines = reminder.split("\n").filter(l => l.trim().startsWith("[/]"));
		const itemsLength = activeLines.reduce((acc, l) => acc + l.length, 0);
		expect(itemsLength).toBeLessThanOrEqual(TODO_TOTAL_PREVIEW_WIDTH);
		expect(reminder.length).toBeLessThanOrEqual(TODO_TOTAL_PREVIEW_WIDTH + 400);
		expect(reminder).toContain("more active item(s)");
	});

	/**
	 * Collapsed todo board row cap: nonblank rows must never exceed maxRows.
	 */
	it("strictly caps collapsed todo board rows at maxRows under overflow conditions", () => {
		const phases: TodoPhase[] = [
			{ name: "P1", tasks: [{ content: "T1", status: "in_progress" }] },
			{ name: "P2", tasks: [{ content: "T2", status: "pending" }] },
			{ name: "P3", tasks: [{ content: "T3", status: "pending" }] },
			{ name: "P4", tasks: [{ content: "T4", status: "pending" }] },
			{ name: "P5", tasks: [{ content: "T5", status: "pending" }] },
			{ name: "P6", tasks: [{ content: "T6", status: "pending" }] },
			{ name: "P7", tasks: [{ content: "T7", status: "in_progress" }] },
		];

		// Case 1: body.length === budget and a later active phase requires notice
		const maxRows = 6;
		const lines = renderTodoBoardLines(phases, boardOptions({ expanded: false, maxRows }));
		const nonBlankLines = lines.filter(l => l.trim() !== "");
		expect(nonBlankLines.length).toBeLessThanOrEqual(maxRows);
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");
		expect(text).toContain("more active phase(s) (P7)");

		// Case 2: Very small maxRows (e.g. 1 or 2)
		const smallLines1 = renderTodoBoardLines(phases, boardOptions({ expanded: false, maxRows: 1 }));
		expect(smallLines1.filter(l => l.trim() !== "").length).toBeLessThanOrEqual(1);

		const smallLines2 = renderTodoBoardLines(phases, boardOptions({ expanded: false, maxRows: 2 }));
		expect(smallLines2.filter(l => l.trim() !== "").length).toBeLessThanOrEqual(2);

		// Case 3: Both unrendered active phases AND hidden rows overflow
		const linesWithBoth = renderTodoBoardLines(phases, boardOptions({ expanded: false, maxRows: 4 }));
		expect(linesWithBoth.filter(l => l.trim() !== "").length).toBeLessThanOrEqual(4);
		const textBoth = linesWithBoth.map(l => Bun.stripANSI(l)).join("\n");
		expect(textBoth).toContain("more active phase(s)");
		expect(textBoth).toContain("more");
	});
});
