import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@veyyon/coding-agent/task";
import type { TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import type { NativeScrollbackLiveRegion } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { warmNativeTextPath } from "./helpers/warm-native-text";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

describe("InteractiveMode todo HUD persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let settingsState: SettingsTestState | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-todo-clear-");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	/** `todoClearDelay` omitted means the shipped default, which is what the
	 *  board does for a user who has never opened this setting. Pass a value only
	 *  when the test is deliberately exercising a NON-DEFAULT configuration. */
	async function createMode(todoClearDelay?: number): Promise<void> {
		const overrides = todoClearDelay === undefined ? {} : { "tasks.todoClearDelay": todoClearDelay };
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides,
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(overrides),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
	}

	it("clears closed todos from the panel instantly without mutating session history", async () => {
		await createMode(0);
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "abandoned task", status: "abandoned" },
				],
			},
		];
		session.setTodoPhases(phases);

		mode.setTodos(session.getTodoPhases());

		expect(renderTodos(mode)).not.toContain("done task");
		expect(renderTodos(mode)).not.toContain("abandoned task");
		expect(session.getTodoPhases()).toEqual(phases);
	});

	/**
	 * The default. Finished work stays on the board for the rest of the session,
	 * because a row that disappears on its own reads as work being lost. The hour
	 * is deliberate: it clears the 60 seconds this used to wait by a wide margin,
	 * so the test still fails if someone reinstates a timer with a longer delay
	 * instead of no timer. The pending-timer count is what separates "never
	 * armed" from "armed and never reached", which render identically here and
	 * not at all identically to a process trying to exit. One clock that is not
	 * this one is kept out of the count: the first `Text` render loads the native
	 * addon, which schedules its own unref'd cache prune, so that render happens
	 * before the fake clock is installed.
	 *
	 * The board keeps one open task on purpose. A board with nothing open at all
	 * collapses to the single `Todo list done` line (see
	 * `test/modes/todo-hud-collapses-a-finished-board.test.ts`), which would hide
	 * the row this test reads to tell "kept" from "cleared".
	 */
	it("keeps closed todos on the board indefinitely at the default delay", async () => {
		await createMode();
		warmNativeTextPath();
		vi.useFakeTimers();

		mode.setTodos([
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "open task", status: "pending" },
				],
			},
		]);
		expect(renderTodos(mode)).toContain("done task");
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(3_600_000);
		expect(renderTodos(mode)).toContain("done task");
		expect(vi.getTimerCount()).toBe(0);
	});

	// NON-DEFAULT configuration: a one second delay is configured. This proves the
	// mechanism still works for anyone who wants it, and it is not evidence of
	// what an unconfigured board does. See the test above for that.
	it("clears closed todos after an explicitly configured delay", async () => {
		await createMode(1);
		vi.useFakeTimers();

		mode.setTodos([
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "open task", status: "pending" },
				],
			},
		]);
		expect(renderTodos(mode)).toContain("done task");
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(1);
		expect(renderTodos(mode)).not.toContain("done task");
	});

	it("keeps the anchored todo panel in the live region while visible", async () => {
		await createMode();

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "pending task", status: "pending" }] }]);
		const liveRegion = mode.todoContainer as unknown as NativeScrollbackLiveRegion;
		expect(liveRegion.getNativeScrollbackLiveRegionStart?.()).toBe(0);

		mode.setTodos([]);
		expect(liveRegion.getNativeScrollbackLiveRegionStart?.()).toBeUndefined();
	});

	it("marks todos complete when subagent reconciliation reports a finished agent", async () => {
		await createMode(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		session.setTodoPhases([
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "pending" }] },
		]);
		mode.setTodos(session.getTodoPhases());

		await mode.init();
		// Subagent lifecycle changes coalesce behind a 100ms observer UI sync
		// timer before todo reconciliation runs; flush it deterministically.
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ReviewFixer",
			index: 0,
			agent: "task",
			description: "Fix review comments",
			status: "completed",
			detached: true,
		});
		vi.advanceTimersByTime(100);

		expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
	});
});

describe("InteractiveMode todo HUD anchor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/**
	 * The board is a railed block now, not a connector tree, and the redesign moved
	 * two things this arm used to pin: the header states which phase the plan is on
	 * instead of a task count (a count on the header and a tally on every row said
	 * the same thing twice), and the stages already finished are not drawn at all —
	 * a collapsed board is the worked stage with its tasks, then one muted row per
	 * stage ahead of it, so the plan's shape is on screen without its history.
	 */
	it("renders the railed Todos board: the phase on the header, a tally per stage, the worked stage and the ones ahead of it", () => {
		mode.setTodos([
			{
				name: "Foundation",
				tasks: [
					{ content: "first task", status: "completed" },
					{ content: "second task", status: "in_progress" },
					{ content: "third task", status: "pending" },
				],
			},
			{
				name: "Verification",
				tasks: [{ content: "run tests", status: "pending" }],
			},
		]);

		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));

		// Lightened: no boxed top/bottom rules. The rail is the block's only rule, so
		// every drawn row opens on it and nothing else draws chrome.
		expect(lines.some(line => line === "─".repeat(80))).toBe(false);
		const rail = theme.symbol("block.rail");
		const drawn = lines.filter(line => line.trim().length > 0);
		expect(drawn.length).toBeGreaterThan(0);
		expect(drawn.every(line => line.trimStart().startsWith(rail))).toBe(true);
		// The header states the phase and carries no task count. A tally belongs to
		// the stage rows, which each have one.
		const root = lines.find(line => line.includes("Todos"));
		expect(root?.replace(rail, "").trim()).toBe("Todos · phase 1/2");
		// Each stage carries its own progress, numbered while there is more than one.
		expect(lines.some(line => line.includes("I. Foundation") && line.includes("1/3"))).toBe(true);
		expect(lines.some(line => line.includes("II. Verification") && line.includes("0/1"))).toBe(true);
		// One square vocabulary down the glyph column: in-progress breathes, the
		// finished task stays on the board rather than being sliced away, pending is
		// the hollow box. The mark is the cell immediately left of the task text, so
		// this reads it there rather than assuming what precedes it: a task row hangs
		// from the rail and then from the connectors of the stage above it.
		const glyphOf = (needle: string): string => {
			const row = lines.find(line => line.includes(needle)) ?? "";
			return row.slice(0, row.indexOf(needle)).trimEnd().slice(-1);
		};
		expect([theme.symbol("status.done"), theme.symbol("status.shadowed")]).toContain(glyphOf("second task"));
		expect(glyphOf("third task")).toBe(theme.checkbox.unchecked);
		expect(glyphOf("first task")).toBe(theme.checkbox.checked);
		// The stage ahead is one row and a tally. Its tasks belong to the expanded
		// board: listing them here is what made the block a wall of pending work.
		expect(lines.some(line => line.includes("run tests"))).toBe(false);
		// Nothing came off, so there is no overflow row to say so.
		expect(lines.some(line => line.includes("more"))).toBe(false);
	});

	it("renders nothing when there are no todos", () => {
		mode.setTodos([]);
		expect(mode.todoContainer.render(80)).toHaveLength(0);
	});

	it("omits the stage count and roman numeral for a single-phase list", () => {
		mode.setTodos([
			{
				name: "Tasks",
				tasks: [
					{ content: "alpha", status: "pending" },
					{ content: "beta", status: "pending" },
				],
			},
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		// One stage → no redundant "1/1" stage count on the root.
		const root = lines.find(line => line.includes("Todos"));
		expect(root).not.toContain("/");
		// The stage keeps its task progress; no roman numeral for a lone stage.
		expect(lines.some(line => line.includes("Tasks") && line.includes("0/2"))).toBe(true);
		expect(lines.some(line => line.includes("I. Tasks"))).toBe(false);
		expect(lines.some(line => line.includes("alpha"))).toBe(true);
	});

	/**
	 * A collapsed board draws the stage being worked and `SUBSEQUENT_PHASE_CAP`
	 * stages after it, in plan order, and no more: the block is a region above the
	 * composer that does not scroll, so a plan of any length has to end somewhere.
	 * How many ROWS come off when the window still exceeds the shared budget, and
	 * what the overflow row then says, is pinned in
	 * `a-worked-todo-board-moves-and-a-waiting-one-does-not.test.ts`, which can fix
	 * the budget; here the terminal's height is whatever the host reports.
	 */
	it("windows a long plan to the stage being worked and the stages just ahead of it", () => {
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		mode.setTodos([
			stage("Discovery"),
			stage("Two"),
			stage("Three"),
			stage("Four"),
			stage("Five"),
			stage("Six"),
			stage("Seven"),
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		// Which stages are in the window, and in which order. Sampling two of them
		// left everything between unstated: a window that dropped one, or listed them
		// out of order, or repeated one, satisfied the sample. Nothing is finished
		// here, so the window opens on the first stage and the tail is what came off.
		const stageHeadings = lines.flatMap(
			line => line.match(/\b(?:[IVX]+\. )?(?:Discovery|Two|Three|Four|Five|Six|Seven)\b(?! task)/) ?? [],
		);
		expect(stageHeadings).toEqual(["I. Discovery", "II. Two", "III. Three", "IV. Four", "V. Five"]);
		// The stages past the window are not on the board at all.
		for (const dropped of ["Six", "Seven"]) {
			expect(
				lines.some(line => line.includes(dropped)),
				dropped,
			).toBe(false);
		}
		// The header states which stage is being worked, out of how many the plan has.
		const root = lines.find(line => line.includes("Todos"));
		expect(root?.replace(theme.symbol("block.rail"), "").trim()).toBe("Todos · phase 1/7");
	});

	it("anchors the todo HUD as a native-scrollback live region while populated", () => {
		// The loader sits below this HUD, so the HUD must report its own seam or
		// its rows commit to scrollback as stale duplicates on short terminals.
		const seam = () =>
			(mode.todoContainer as Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
		expect(seam()).toBeUndefined();
		mode.setTodos([{ name: "Tasks", tasks: [{ content: "alpha", status: "pending" }] }]);
		expect(seam()).toBe(0);
		mode.setTodos([]);
		expect(seam()).toBeUndefined();
	});
});
