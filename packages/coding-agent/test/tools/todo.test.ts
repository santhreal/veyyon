import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	nextActionableTask,
	resolveTodoMarkdownPath,
	TODO_BOARD_TOTAL_FRAMES,
	TODO_STRIKE_HOLD_FRAMES,
	type TodoPhase,
	TodoTool,
	todoMatchesAnyDescription,
	todoToolRenderer,
} from "@veyyon/coding-agent/tools/todo";
import type { Component } from "@veyyon/tui";
import { type } from "arktype";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("resolveTodoMarkdownPath", () => {
	it("defaults to TODO.md under cwd", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});

	it("strips surrounding double quotes before resolving", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath('"my todos.md"', cwd)).toBe(path.join(cwd, "my todos.md"));
	});

	it("rejects internal URL schemes", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(() => resolveTodoMarkdownPath("artifact://todo", cwd)).toThrow("internal scheme");
	});
});

describe("TodoTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toBe("Initialized 2 tasks in 1 phase. Next: status (Execution). Overall: 0/2 done, 2 open.");
	});

	/**
	 * Provider repair sometimes drops only the operation discriminator while
	 * preserving the complete init list. The tool infers init from that
	 * unambiguous shape instead of rejecting the whole plan before execution.
	 */
	it("infers init when op is missing but a phased list is present", async () => {
		const tool = new TodoTool(createSession());
		const parsed = tool.parameters({
			list: [
				{ phase: "Parallel", items: ["S1 package"] },
				{ phase: "Parallel", items: ["S2 engine"] },
			],
		});
		expect(parsed instanceof type.errors).toBe(false);

		const result = await tool.execute("call-missing-op", {
			list: [
				{ phase: "Parallel", items: ["S1 package"] },
				{ phase: "Parallel", items: ["S2 engine"] },
			],
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("init");
		expect(result.details?.phases).toEqual([
			{
				name: "Parallel",
				tasks: [
					{ content: "S1 package", status: "in_progress" },
					{ content: "S2 engine", status: "pending" },
				],
			},
		]);
	});

	/**
	 * A missing discriminator is inferred only for safe unambiguous shapes.
	 * Task-targeting input remains an error so the tool cannot guess a mutation.
	 */
	it("rejects ambiguous missing-op mutations without changing state", async () => {
		const initial: TodoPhase[] = [
			{
				name: "Work",
				tasks: [{ content: "Keep this task", status: "in_progress" }],
			},
		];
		const tool = new TodoTool(createSession(initial));

		const result = await tool.execute("call-ambiguous-op", { task: "Keep this task" });

		expect(result.isError).toBe(true);
		expect(result.details?.op).toBeUndefined();
		expect(result.details?.phases).toEqual(initial);
		const summary = result.content.find(part => part.type === "text");
		expect(summary?.type === "text" ? summary.text : "").toContain("Missing op");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = await tool.execute("call-2", { op: "done", task: "status" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "status" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toBe("Completed: status. Next: diagnostics (Execution). Overall: 1/2 done, 1 open.");
		const completedResult = await tool.execute("call-3", { op: "done", task: "diagnostics" });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo");
		}
		expect(completedSummary.text).toBe("Completed: diagnostics. Next: none. Overall: 2/2 done, 0 open.");
	});
});

describe("nextActionableTask", () => {
	it("returns the in-progress task before the first pending task across phases", () => {
		const task = nextActionableTask([
			{
				name: "First",
				tasks: [{ content: "queued first", status: "pending" }],
			},
			{
				name: "Second",
				tasks: [{ content: "active second", status: "in_progress" }],
			},
		]);

		expect(task?.content).toBe("active second");
	});

	it("falls back to the first pending task when nothing is in progress", () => {
		const task = nextActionableTask([
			{
				name: "Done",
				tasks: [{ content: "finished", status: "completed" }],
			},
			{
				name: "Next",
				tasks: [{ content: "first pending", status: "pending" }],
			},
		]);

		expect(task?.content).toBe("first pending");
	});
});

// The board keeps a second task so it is still OPEN: a board whose every task
// has closed collapses to the one-line "Todo list done" summary and has no rows
// left to strike through (see todo-done-collapse.test.ts).
//
// Two things are pinned here, and both are about a shared field.
//
// FRAME 0 IS THE SETTLED BOARD. `spinnerFrame` is not owned by this renderer:
// surfaces that animate nothing pass a fixed 0 and render once — `veyyon gallery`,
// an HTML export, a collab guest. If frame 0 drew the first step of the entrance,
// every one of them would show a column of empty cells and no tasks, permanently.
//
// THE TWO ANIMATIONS ARE SEQUENCED. A row types itself in, settles checked, and
// only then crosses out. A strike drawn over a half-written row reads as neither.
it("settles at frame zero, then writes in, holds checked, and strikes through", async () => {
	const tool = new TodoTool(createSession());
	await tool.execute("call-1", { op: "init", list: [{ phase: "Execution", items: ["finish", "carry on"] }] });
	const result = await tool.execute("call-2", { op: "done", task: "finish" });
	const options: RenderResultOptions = { expanded: true, isPartial: false, spinnerFrame: 0 };
	const component = todoToolRenderer.renderResult(result, options, theme);

	// Frame 0: the finished board, struck through, exactly as a still consumer sees it.
	const staticFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(staticFrame)).toContain("finish");
	expect(staticFrame).toContain("\x1b[9m");

	// Frame 1 opens the entrance: the row has barely been written, so its text is
	// not on the board yet.
	options.spinnerFrame = 1;
	expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("finish");

	// The hold frame: written, checked, and not yet struck.
	options.spinnerFrame = TODO_STRIKE_HOLD_FRAMES;
	const heldFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(heldFrame)).toContain("finish");
	expect(heldFrame).not.toContain("\x1b[9m");

	options.spinnerFrame = TODO_STRIKE_HOLD_FRAMES + 1;
	const revealFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(revealFrame)).toContain("finish");
	expect(revealFrame).toContain("\x1b[9m");

	// Past the envelope, and with no frame at all, the board is settled either way.
	options.spinnerFrame = TODO_BOARD_TOTAL_FRAMES;
	expect(component.render(120).join("\n")).toBe(staticFrame);
	options.spinnerFrame = undefined;
	expect(component.render(120).join("\n")).toBe(staticFrame);
});

describe("TodoTool operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});

		const result = await tool.execute("call-2", { op: "start", task: "third" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
		expect(result.details?.op).toBe("start");
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});

		const result = await tool.execute("call-2", { op: "start", task: "b1" });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Work",
			items: ["Second"],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = await tool.execute("call-2", { op: "done", phase: "Work" });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "rm" });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "drop", phase: "Work" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});

	it("view echoes state without mutating it", async () => {
		const session = createSession([
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", { op: "view" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		// A read never normalizes or writes session state back.
		expect(session.getTodoPhases?.()?.[0]?.tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("First");
		expect(summary.text).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "view" });
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list is empty.");
		expect(result.isError).toBeUndefined();
	});
});

describe("TodoTool model-facing mutation feedback", () => {
	/**
	 * Mutation results must report only the state transition, next actionable
	 * task, and counters. Repeating a large plan after every completion consumed
	 * more context than the actual work and buried the transition that mattered.
	 */
	it("keeps large-plan mutation summaries compact and actionable", async () => {
		const items = Array.from({ length: 40 }, (_, index) => `Task ${index + 1}`);
		const tool = new TodoTool(createSession());
		const initialized = await tool.execute("call-init", {
			op: "init",
			list: [{ phase: "Execution", items }],
		});
		const initSummary = initialized.content.find(part => part.type === "text");
		if (initSummary?.type !== "text") throw new Error("Expected text summary");
		expect(initSummary.text).toBe(
			"Initialized 40 tasks in 1 phase. Next: Task 1 (Execution). Overall: 0/40 done, 40 open.",
		);
		expect(new TextEncoder().encode(initSummary.text).byteLength).toBeLessThanOrEqual(256);
		expect(initSummary.text).not.toContain("Task 40");

		const completed = await tool.execute("call-done", { op: "done", task: "Task 1" });
		const doneSummary = completed.content.find(part => part.type === "text");
		if (doneSummary?.type !== "text") throw new Error("Expected text summary");
		expect(doneSummary.text).toBe("Completed: Task 1. Next: Task 2 (Execution). Overall: 1/40 done, 39 open.");
		expect(new TextEncoder().encode(doneSummary.text).byteLength).toBeLessThanOrEqual(256);
		expect(doneSummary.text).not.toContain("Task 40");
	});

	/**
	 * `view` retains the complete plan in machine details while its model-facing
	 * projection stays bounded and keeps the actionable prefix.
	 */
	it("bounds explicit view text without truncating machine-owned state", async () => {
		const items = Array.from({ length: 40 }, (_, index) => `Task ${index + 1}`);
		const tool = new TodoTool(createSession());
		await tool.execute("call-init", {
			op: "init",
			list: [{ phase: "Execution", items }],
		});

		const viewed = await tool.execute("call-view", { op: "view" });
		const summary = viewed.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(viewed.details?.phases[0]?.tasks).toHaveLength(40);
		expect(summary.text).toContain("- [/] Task 1 (Execution)");
		expect(summary.text).toContain("- [ ] Task 5 (Execution)");
		expect(summary.text).toContain("- … 35 more item(s) retained in machine todo state.");
		expect(summary.text).not.toContain("Task 6");
		expect(summary.text).not.toContain("Task 40");
		expect(summary.text).toContain("Overall: 0/40 done, 40 open.");
		expect(new TextEncoder().encode(summary.text).byteLength).toBeLessThanOrEqual(1_024);
	});

	it("sanitizes and globally bounds view text while retaining exact task state", async () => {
		const phase = `Execution\u001b]8;;https://example.com\u0007\n${"P".repeat(400)}`;
		const items = Array.from(
			{ length: 20 },
			(_, index) => `Task ${index + 1}\u001b]8;;https://example.com\u0007\n${"x".repeat(400)}`,
		);
		const tool = new TodoTool(createSession());
		await tool.execute("call-init", { op: "init", list: [{ phase, items }] });

		const viewed = await tool.execute("call-view", { op: "view" });
		const summary = viewed.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");

		expect(viewed.details?.phases[0]).toEqual({
			name: phase,
			tasks: items.map((content, index) => ({
				content,
				status: index === 0 ? "in_progress" : "pending",
			})),
		});
		expect(summary.text).not.toContain("\u001b");
		expect(summary.text).not.toContain("\u0007");
		expect(summary.text).toContain("Task 1 x");
		expect(summary.text.match(/^- \[(?:X|\/|-| )\] /gm)?.length ?? 0).toBeGreaterThan(0);
		expect(summary.text.match(/^- \[(?:X|\/|-| )\] /gm)?.length ?? 0).toBeLessThanOrEqual(5);
		expect(summary.text.length).toBeLessThanOrEqual(1_024);
	});

	it("reports no active phase when a viewed plan is fully closed", async () => {
		const tool = new TodoTool(
			createSession([
				{ name: "Finished", tasks: [{ content: "Done", status: "completed" }] },
				{ name: "Skipped", tasks: [{ content: "Dropped", status: "abandoned" }] },
			]),
		);

		const viewed = await tool.execute("call-view", { op: "view" });
		const summary = viewed.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Active phase: none (all 2 phases are closed).");
		expect(summary.text).not.toContain("Active phase 2/2");
	});

	it("describes removal of the last named task rather than a list-wide clear", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-init", { op: "init", list: [{ phase: "Work", items: ["Only task"] }] });

		const removed = await tool.execute("call-rm", { op: "rm", task: "Only task" });
		const summary = removed.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toBe("Removed: Only task. Next: none. Overall: 0/0 done, 0 open.");
	});
});

describe("TodoTool lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", items: ["First", "Second"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Tasks"]);
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", phase: "Cleanup", items: ["Remove dead code"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Cleanup"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("still errors when init has neither list nor items", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init" });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing list for init operation");
	});

	/**
	 * A repaired or truncated payload can lose its discriminator. An empty list
	 * without `op` must fail closed instead of becoming a destructive init.
	 */
	it("rejects an implicit empty init without clearing existing state", async () => {
		const session = createSession();
		const tool = new TodoTool(session);
		await tool.execute("call-1", { op: "init", items: ["Keep this task"] });

		const result = await tool.execute("call-2", { list: [] });

		expect(result.isError).toBe(true);
		expect(result.details?.phases[0]?.tasks).toEqual([{ content: "Keep this task", status: "in_progress" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("an empty list cannot initialize or clear todos");
	});
});

describe("TodoTool empty items tolerance", () => {
	// Regression: a stray `items: []` on an op that ignores items (here `view`)
	// must not be a hard schema rejection. The top-level `items` array dropped
	// its `atLeastLength(1)` so callers don't get "items must be tasks to append"
	// for an irrelevant empty array; length is enforced per-op at runtime.
	it("accepts op:view with an empty items array at the schema boundary", () => {
		const schema = new TodoTool(createSession()).parameters;
		expect(schema({ op: "view", items: [] }) instanceof type.errors).toBe(false);
	});

	it("defers empty append items to an op-specific runtime error", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { op: "append", phase: "Work", items: [] });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing items for append operation");
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(todoMatchesAnyDescription("Sonnet #1: AGENTS audit", ["Sonnet #1: AGENTS audit"])).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", ["sonnet #1: agents audit"])).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", ["Sonnet #2"])).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(todoMatchesAnyDescription("Sonnet #3", ["Sonnet #3: git blame / history check"])).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(false);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("returns true on the first match without scanning further descriptions", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["unrelated agent task", "Sonnet #2", "Sonnet #3"]),
		).toBe(true);
	});

	it("returns false when no description overlaps the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["Reviewer1AgentsAdherence", "git blame"])).toBe(
			false,
		);
	});

	it("ignores punctuation differences in identifiers", () => {
		// One side has a method-prefix '#', the other doesn't. Reproduced
		// from a real run where 3 subagents were spawned but only 2 of 3
		// matched todos lit up because the matcher's normalizer collapsed
		// whitespace but left punctuation intact.
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		// Dotted abbreviations like AGENTS.md collapse to a space too.
		expect(todoMatchesAnyDescription("Audit AGENTS.md compliance", ["Audit AGENTS md compliance"])).toBe(true);
	});
});
describe("todoToolRenderer.renderResult phase collapsing", () => {
	async function buildThreePhaseAfterDone() {
		const tool = new TodoTool(createSession());
		await tool.execute("init", {
			op: "init",
			list: [
				{ phase: "Alpha", items: ["a1", "a2"] },
				{ phase: "Beta", items: ["b1", "b2"] },
				{ phase: "Gamma", items: ["c1", "c2"] },
			],
		});
		// `done a1` keeps the active task inside Alpha (auto-promotes a2), leaving
		// Beta and Gamma untouched by this update.
		return tool.execute("done", { op: "done", task: "a1" });
	}
	function innerLines(component: Component): string[] {
		const lines = Bun.stripANSI(component.render(100).join("\n")).split("\n");
		return lines.slice(1, -1).map(line => line.replace(/^│/, "").replace(/│\s*$/, "").trim());
	}
	/**
	 * Collapsed multi-phase output is one global actionable preview: every phase is
	 * NAMED ONCE, on its own row, carrying its own standing, and the open work of
	 * every phase competes for one shared row budget.
	 *
	 * The phase used to be a dim `(Alpha)` suffix repeated on every row, which is
	 * what the negative control here pins out. Closed history is off the board apart
	 * from the task that closed on THIS write, which is the row whose strikethrough
	 * is playing.
	 */
	it("names each phase once, with its own standing, over one shared row budget", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		const rendered = Bun.stripANSI(component.render(100).join("\n"));

		// One row per phase, never a per-row tag.
		expect(rendered.match(/Alpha/g)).toHaveLength(1);
		expect(rendered.match(/Beta/g)).toHaveLength(1);
		expect(rendered.match(/Gamma/g)).toHaveLength(1);
		expect(rendered).not.toContain("(Alpha)");
		expect(rendered).not.toContain("(Beta)");
		expect(rendered).not.toContain("(Gamma)");

		// Each phase states where it stands, and the header states the whole board.
		expect(rendered).toContain("1/2");
		expect(rendered).toContain("0/2");
		expect(rendered).toContain("1/6 tasks");

		// Open work from every phase, plus the task that just closed.
		expect(rendered).toContain("a2");
		expect(rendered).toContain("b1");
		expect(rendered).toContain("c1");
		expect(rendered).toContain("a1");
		expect(rendered).toContain("1 more todo");
	});

	/**
	 * A transcript rebuilt from session entries has no call arguments, and must
	 * produce the SAME board — not a similar one. Byte equality is the assertion
	 * because the contract is that the fourth parameter changes nothing at all;
	 * naming particular rows would let a layout change hide a divergence.
	 */
	it("renders byte-identically with and without call args", async () => {
		const result = await buildThreePhaseAfterDone();
		const withArgs = todoToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, theme, { op: "done", task: "a1" })
			.render(100)
			.join("\n");
		const withoutArgs = todoToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, theme)
			.render(100)
			.join("\n");

		expect(withoutArgs).toBe(withArgs);
		expect(Bun.stripANSI(withoutArgs)).toContain("a2");
		expect(Bun.stripANSI(withoutArgs)).toContain("1 more todo");
	});

	/** Phase count must not multiply the collapsed line budget. */
	it("caps a many-phase plan to the global collapsed item limit", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("init-many", {
			op: "init",
			list: Array.from({ length: 12 }, (_, index) => ({
				phase: `Phase ${index + 1}`,
				items: [`task-${index + 1}`],
			})),
		});
		const component = todoToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
		const rendered = Bun.stripANSI(component.render(100).join("\n"));

		expect(rendered).toContain("task-1");
		expect(rendered).toContain("task-5");
		expect(rendered).not.toContain("task-6");
		expect(rendered).not.toContain("task-12");
		expect(rendered).toContain("7 more todos");
	});
	it("shows every phase fully when manually expanded", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("b1");
		expect(rendered).toContain("b2");
		expect(rendered).toContain("c1");
		expect(rendered).toContain("c2");
	});

	it("keeps every item and phase visible when a large plan is expanded", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("init-many", {
			op: "init",
			list: Array.from({ length: 12 }, (_, index) => ({
				phase: `Phase ${index + 1}`,
				items: [`task-${index + 1}`],
			})),
		});
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme);
		const rendered = Bun.stripANSI(component.render(100).join("\n"));

		for (let index = 1; index <= 12; index++) {
			expect(rendered).toContain(`Phase ${index}`);
			expect(rendered).toContain(`task-${index}`);
		}
		expect(rendered).not.toContain("more todo");
	});
	it("drops blank separator lines between phases", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		// No empty body line survives between phases.
		expect(innerLines(component).every(line => line.length > 0)).toBe(true);
	});
});

describe("todoToolRenderer.renderCall malformed-args regression (#2005)", () => {
	// Reporter saw `TypeError: args?.ops?.map is not a function` against
	// Xiaomi Token Plan's Anthropic protocol because `parseStreamingJson`
	// surfaced `{ ops: "[..." }` shapes mid-stream. The renderer is invoked
	// on every streaming delta, so any non-array `ops` (string, object,
	// number) must NOT crash the TUI render loop and trigger the spam-warn /
	// retry cascade.
	const renderOptions = { expanded: false, isPartial: true } as const;

	it("does not throw when op is a streaming-truncated number", () => {
		// Mid-stream the new flat shape can surface `{ op: 1 }` before the
		// discriminator string lands.
		const args = { op: 1 } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw when a flat op's items field is a non-array", () => {
		const args = {
			op: "append",
			phase: "Work",
			items: "Second" as unknown as string[],
		} as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw on the legacy streaming-truncated `ops` string", () => {
		// Old transcripts/collab-web still carry `{ ops: "[{" }` mid-stream;
		// `normalizeTodoArg` must keep tolerating the legacy batch shape.
		const args = { ops: '[{"op":"init"' } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("renders op summary metadata for a well-formed flat call", () => {
		const args = { op: "init", items: ["a", "b", "c"] };
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		// `Text(text, 0, 0)` from `@veyyon/tui` exposes the content via .render().
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
	});

	it("still renders legacy multi-op `ops` arrays from old transcripts", () => {
		const args = {
			ops: [
				{ op: "init", items: ["a", "b", "c"] },
				{ op: "done", task: "a" },
				{ op: "append", phase: "Cleanup", items: ["d"] },
			],
		};
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
		expect(rendered).toContain("done");
		expect(rendered).toContain("append");
		expect(rendered).toContain("Cleanup");
		expect(rendered).toContain("1 item");
	});
});
