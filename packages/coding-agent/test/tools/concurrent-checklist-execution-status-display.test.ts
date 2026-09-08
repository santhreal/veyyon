import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { renderTodoBoardLines, type TodoBoardOptions } from "@veyyon/coding-agent/modes/components/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type TodoPhase, TodoTool, todoToolRenderer } from "@veyyon/coding-agent/tools/todo";

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
		expanded: false,
		owned: new Set<string>(),
		frame: 0,
		animate: false,
		live: true,
		...overrides,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("concurrent checklist execution status display", () => {
	/**
	 * Defect 1:
	 * When a second task is started while an earlier task is already in_progress,
	 * todoToolRenderer.renderResult in collapsed mode previously selected the first active task
	 * in allTasks as "moved", masking the newly started task and omitting the concurrent active count.
	 *
	 * It must display the newly started task and clearly reflect the concurrent active count.
	 */
	it("renders the newly started task and concurrent active count in collapsed tool result", async () => {
		const { session } = createSession([
			{
				name: "Phase A",
				tasks: [
					{ content: "Task A1", status: "in_progress" },
					{ content: "Task A2", status: "pending" },
				],
			},
			{
				name: "Phase B",
				tasks: [{ content: "Task B1", status: "pending" }],
			},
		]);
		const tool = new TodoTool(session);

		// Execute start on Task B1 in Phase B
		const result = await tool.execute("call-start-b1", { op: "start", task: "Task B1" });
		expect(result.isError).toBeUndefined();

		const component = todoToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme, {
			op: "start",
			task: "Task B1",
		});

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		// Must indicate 2 tasks are in progress concurrently
		expect(rendered).toContain("2 in progress");
		// Must indicate Phase B and Task B1 (the task newly started by this operation)
		expect(rendered).toContain("Phase B");
		expect(rendered).toContain("Task B1");
	});

	it.each([true, false])("restores normalized start targets with call arguments=%s", async withArgs => {
		const { session } = createSession([
			{ name: "Earlier", tasks: [{ content: "Task A", status: "in_progress" }] },
			{ name: "Later", tasks: [{ content: "Task B", status: "pending" }] },
		]);
		const args = { op: "start" as const, task: "task b" };
		const result = await new TodoTool(session).execute("normalized-start", args);
		expect(result.isError).toBeUndefined();
		const restored = JSON.parse(JSON.stringify(result));
		const component = todoToolRenderer.renderResult(
			restored,
			{ expanded: false, isPartial: false },
			theme,
			withArgs ? args : undefined,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("2 in progress");
		expect(rendered).toContain("Later");
		expect(rendered).toContain("Task B");
	});

	/**
	 * Defect 2:
	 * In collapsed mode, when a phase has multiple pending tasks followed by an in_progress task
	 * beyond ACTIVE_TASK_CAP (5), collapsedTasks previously sliced only the first 5 open tasks,
	 * dropping the in_progress task completely from the board.
	 *
	 * in_progress tasks must be prioritized so all active work is visible.
	 */
	it("prioritizes in_progress tasks in collapsed phase preview when open tasks exceed cap", () => {
		const phase: TodoPhase = {
			name: "Heavy Phase",
			tasks: [
				{ content: "Pending 1", status: "pending" },
				{ content: "Pending 2", status: "pending" },
				{ content: "Pending 3", status: "pending" },
				{ content: "Pending 4", status: "pending" },
				{ content: "Pending 5", status: "pending" },
				{ content: "Active Concurrent Task", status: "in_progress" },
			],
		};

		const lines = renderTodoBoardLines([phase], boardOptions({ expanded: false, maxRows: 14 }));
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");

		// Active Concurrent Task MUST be rendered on the board with active working mark, not dropped
		expect(text).toContain("Active Concurrent Task");
		const activeLine = lines.find(l => Bun.stripANSI(l).includes("Active Concurrent Task")) ?? "";
		expect(activeLine).toContain(theme.symbol("status.done"));
		expect(activeLine).not.toContain(theme.checkbox.unchecked);
	});

	/**
	 * Defect 3:
	 * When an active phase is within SUBSEQUENT_PHASE_CAP, but preceding phases/tasks consume
	 * the maxRows budget, the active phase is trimmed by body.slice(0, maxShown).
	 * Previously, unrenderedActivePhases only checked phases beyond SUBSEQUENT_PHASE_CAP,
	 * completely concealing the row-trimmed active phase under a generic "… N more" notice.
	 *
	 * It must detect row-trimmed active phases and announce them in the overflow notice.
	 */
	it("detects and announces row-trimmed active phases in the overflow notice", () => {
		const phases: TodoPhase[] = [
			{
				name: "Phase 1",
				tasks: [
					{ content: "P1 Task 1", status: "in_progress" },
					{ content: "P1 Task 2", status: "pending" },
					{ content: "P1 Task 3", status: "pending" },
					{ content: "P1 Task 4", status: "pending" },
					{ content: "P1 Task 5", status: "pending" },
				],
			},
			{
				name: "Phase 2",
				tasks: [{ content: "P2 Concurrent Active", status: "in_progress" }],
			},
		];

		// maxRows is 6:
		// Header = 1 line
		// Body budget = 5 lines
		// Phase 1 has header + 5 tasks = 6 lines
		// Phase 2 is inside slice (index 1 < 1 + 4), but lines 6-7 are trimmed off by maxRows!
		const lines = renderTodoBoardLines(phases, boardOptions({ expanded: false, maxRows: 6 }));
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");

		// Phase 2 must be announced in the active phase overflow notice
		expect(text).toContain("more active phase(s) (Phase 2)");
	});
});
