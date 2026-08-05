/**
 * Contract: EVERY session-scoped surface above the composer belongs to the
 * VIEWED session, in both directions — on focus attach, on Esc detach, and on
 * the registry-driven auto-unfocus that fires when the viewed agent dies.
 *
 * THE DEFECT FAMILY THIS SUITE WAS WRITTEN AGAINST. Focusing into an agent
 * retargets the transcript, the status line and the editor
 * (`SessionFocusController#attach`), but three surfaces kept painting the
 * driving session's state underneath the agent's view:
 *
 *   1. The todo HUD. Todos are per-session (`AgentSession#todoPhases`) and the
 *      board is the loudest block above the composer. Every other session
 *      switch (new, resume, branch, handoff, collab welcome) reloads it
 *      explicitly; the focus transitions never did, AND `#loadTodoList` read
 *      `session` rather than `viewSession`, so even an explicit reload while
 *      focused re-fetched the driving session's board. Inside an agent that
 *      owned no todos the operator read the parent's checklist as the agent's.
 *   2. The pinned error banner. `resetTranscriptAnchors` drops the transcript
 *      component the banner mirrors but never cleared the banner container, so
 *      the main session's failed turn stayed pinned above the composer for the
 *      whole time the view was inside an agent, with nothing behind it — and an
 *      agent's failure stayed pinned after Esc returned to main.
 *   3. The running-agent count badge. The HUD beside it already lists only the
 *      viewed agent's spawns; the badge kept counting the whole conversation,
 *      so a leaf agent's view reported running agents that had no row anywhere
 *      in it. That is the HUD's own defect, one number wide.
 *
 * The fix is one choke point, not three special cases: `clearTransientSessionUi`
 * runs on every focus transition after the focus controller has swapped the
 * target, and re-derives all of them against the new view.
 *
 * Assertions are on the exact rendered bytes of each container (ANSI included
 * where the restored view is compared to the original), because the leak is
 * precisely "the bytes did not change when the view did".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@veyyon/coding-agent/task";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 110;

describe("session-scoped surfaces while the view is focused on an agent", () => {
	let tempDir: TempDir | undefined;
	let childTempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let mainSession: AgentSession | undefined;
	let childSession: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let terminal: VirtualTerminal | undefined;
	let eventBus: EventBus | undefined;

	beforeAll(async () => {
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-focus-surfaces-");
		childTempDir = TempDir.createSync("@pi-focus-surfaces-child-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		mainSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		childSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Child"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(childTempDir.path(), childTempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});

		eventBus = new EventBus();
		mode = new InteractiveMode(mainSession, "test", undefined, undefined, undefined, eventBus);
		terminal = new VirtualTerminal(WIDTH, 30);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await mainSession?.dispose();
		await childSession?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		childTempDir?.removeSync();
		mode = undefined;
		mainSession = undefined;
		childSession = undefined;
		terminal = undefined;
		eventBus = undefined;
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		stopThemeWatcher();
	});

	function booted(): { mode: InteractiveMode; terminal: VirtualTerminal } {
		if (!mode || !terminal) throw new Error("mode not booted");
		return { mode, terminal };
	}

	/** Register the child under Main and focus the view on it, the `/agents` Enter path. */
	async function focusChild(id = "AuthLoader"): Promise<void> {
		const { mode: m, terminal: t } = booted();
		if (!childSession) throw new Error("childSession not booted");
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childSession,
			status: "running",
		});
		await m.focusAgentSession(id);
		await t.waitForRender();
	}

	/**
	 * Emit an observer lifecycle event and drive the 100ms coalesce window on the
	 * fake clock, the way the HUD suite does: the flush that re-renders and
	 * reconciles is a setTimeout, and faking only around the emit keeps
	 * VirtualTerminal.waitForRender (real-time) working.
	 */
	async function emitLifecycle(
		id: string,
		index: number,
		description: string,
		status: SubagentLifecyclePayload["status"],
	): Promise<void> {
		const { mode: m, terminal: t } = booted();
		if (!eventBus) throw new Error("eventBus not booted");
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index,
			agent: "task",
			agentSource: "bundled",
			description,
			status,
			parentToolCallId: `call-${id}`,
			detached: true,
		} satisfies SubagentLifecyclePayload);
		vi.advanceTimersByTime(150);
		vi.useRealTimers();
		m.ui.requestRender();
		await t.waitForRender();
	}

	describe("the todo HUD", () => {
		/**
		 * Leak 1, attach direction: the driving session's board painted inside an
		 * agent that owns no todos at all.
		 */
		it("clears to the focused agent's own empty board and restores the driving board byte for byte", async () => {
			const { mode: m, terminal: t } = booted();
			mainSession?.setTodoPhases([
				{ name: "Todos", tasks: [{ content: "Ship the parser rewrite", status: "in_progress" }] },
			]);
			await m.reloadTodos();
			await t.waitForRender();

			const mainTodos = m.todoContainer.render(WIDTH).join("\n");
			expect(Bun.stripANSI(mainTodos)).toContain("Ship the parser rewrite");

			await focusChild();

			// The agent set no todos, so its board is empty and the block must be
			// gone. Exact bytes: an empty container renders to nothing at all.
			expect(m.todoContainer.render(WIDTH)).toEqual([]);

			await m.unfocusSession();
			await t.waitForRender();

			// Exact bytes, styling included: the restored board is the same frame,
			// not merely the same words.
			expect(m.todoContainer.render(WIDTH).join("\n")).toBe(mainTodos);
		});

		/** Leak 1, the other direction: the agent's board must reach the screen. */
		it("paints the focused agent's own board rather than the driving session's", async () => {
			const { mode: m, terminal: t } = booted();
			mainSession?.setTodoPhases([{ name: "Todos", tasks: [{ content: "Parent work", status: "pending" }] }]);
			childSession?.setTodoPhases([{ name: "Todos", tasks: [{ content: "Child work", status: "in_progress" }] }]);
			await m.reloadTodos();
			await t.waitForRender();

			await focusChild();

			const focused = Bun.stripANSI(m.todoContainer.render(WIDTH).join("\n"));
			expect(focused).toContain("Child work");
			expect(focused).not.toContain("Parent work");

			await m.unfocusSession();
			await t.waitForRender();

			const restored = Bun.stripANSI(m.todoContainer.render(WIDTH).join("\n"));
			expect(restored).toContain("Parent work");
			expect(restored).not.toContain("Child work");
		});

		/**
		 * Leak 1, detach direction under the registry-driven auto-unfocus: a
		 * viewed agent that dies returns the view to main WITHOUT an Esc, through
		 * `SessionFocusController#onRegistryEvent`. The board has to come back on
		 * that path too, or the only way to recover it is another manual switch.
		 */
		it("restores the driving board when the viewed agent dies and the view auto-unfocuses", async () => {
			const { mode: m, terminal: t } = booted();
			mainSession?.setTodoPhases([{ name: "Todos", tasks: [{ content: "Parent work", status: "pending" }] }]);
			await m.reloadTodos();
			await t.waitForRender();
			const mainTodos = m.todoContainer.render(WIDTH).join("\n");

			await focusChild();
			expect(m.todoContainer.render(WIDTH)).toEqual([]);

			AgentRegistry.global().setStatus("AuthLoader", "aborted");
			// The registry handler auto-unfocuses through a floating promise, so the
			// return lands a few microtasks after the status write. Drained, not
			// slept on: the chain is microtask-only, so no wall clock is involved.
			for (let i = 0; i < 20 && m.focusedAgentId !== undefined; i++) await Promise.resolve();
			expect(m.focusedAgentId).toBeUndefined();
			await t.waitForRender();

			expect(m.todoContainer.render(WIDTH).join("\n")).toBe(mainTodos);
		});

		/**
		 * Leak 1, WRITE side. `#reconcileTodosWithSubagents` auto-completes a todo
		 * whose wording matches a finished spawn. It read the whole observer list
		 * and persisted the result into `session`, so once the board on screen
		 * became the focused agent's, one observer event copied that agent's board
		 * onto the DRIVING session and wrote it to that session's file. A surface
		 * that re-scopes its reads and not its writes is half-fixed in the
		 * direction that leaves damage behind.
		 */
		it("auto-completes into the viewed session and never writes the agent's board onto the driving one", async () => {
			const { mode: m } = booted();
			mainSession?.setTodoPhases([{ name: "Todos", tasks: [{ content: "Parent work", status: "pending" }] }]);
			childSession?.setTodoPhases([
				{ name: "Todos", tasks: [{ content: "Migrate the users table", status: "in_progress" }] },
			]);
			await m.reloadTodos();
			await focusChild();

			await emitLifecycle("AuthLoader.Migrator", 0, "Migrate the users table", "completed");

			expect(childSession?.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			// The driving session is untouched: same one task, still open, and its
			// board never acquired a task it does not own.
			expect(mainSession?.getTodoPhases()).toEqual([
				{ name: "Todos", tasks: [{ content: "Parent work", status: "pending" }] },
			]);
		});
	});

	describe("the pinned error banner", () => {
		/**
		 * Leak 2: a banner is one session's failed turn. Focusing away from it left
		 * it pinned above the composer inside the agent's view, orphaned — the
		 * transcript component it mirrors was already dropped by
		 * `resetTranscriptAnchors`.
		 */
		it("does not follow the view into a focused agent", async () => {
			const { mode: m, terminal: t } = booted();
			m.showPinnedError("Provider returned 529 overloaded");
			await t.waitForRender();
			expect(Bun.stripANSI(m.errorBannerContainer.render(WIDTH).join("\n"))).toContain("529 overloaded");

			await focusChild();

			expect(m.errorBannerContainer.render(WIDTH)).toEqual([]);
			expect(t.getViewport().join("\n")).not.toContain("529 overloaded");
		});

		/** Leak 2, detach direction: an agent's failure must not survive the way out. */
		it("does not follow the view back out to the main session", async () => {
			const { mode: m, terminal: t } = booted();
			await focusChild();
			m.showPinnedError("Agent turn failed");
			await t.waitForRender();
			expect(Bun.stripANSI(m.errorBannerContainer.render(WIDTH).join("\n"))).toContain("Agent turn failed");

			await m.unfocusSession();
			await t.waitForRender();

			expect(m.errorBannerContainer.render(WIDTH)).toEqual([]);
			expect(t.getViewport().join("\n")).not.toContain("Agent turn failed");
		});
	});

	describe("the running-agent count badge", () => {
		function registerRunning(id: string, parentId: string): void {
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId,
				session: null,
				status: "running",
			});
		}

		/**
		 * Leak 3: the badge is the HUD's one-number summary. Inside a leaf agent
		 * the HUD is empty by design, so a badge still reporting the conversation's
		 * three running spawns named agents with no row anywhere in that view.
		 */
		it("counts the viewed agent's subtree while focused and the whole conversation after Esc", async () => {
			const { mode: m, terminal: t } = booted();
			registerRunning("SchemaMigrator", MAIN_AGENT_ID);
			registerRunning("AuthLoader.Deep", "AuthLoader");
			await focusChild();

			// AuthLoader is registered by focusChild, so the conversation holds three
			// running spawns; only one of them is below the viewed agent.
			expect(m.statusLine.subagentCount).toBe(1);

			await m.unfocusSession();
			await t.waitForRender();

			expect(m.statusLine.subagentCount).toBe(3);
		});

		/** A leaf agent's honest answer is zero, not the parent's tally. */
		it("reports zero inside a leaf agent that spawned nothing", async () => {
			const { mode: m } = booted();
			registerRunning("SchemaMigrator", MAIN_AGENT_ID);
			await focusChild();

			expect(m.statusLine.subagentCount).toBe(0);
		});
	});

	describe("the composer chip band", () => {
		/**
		 * Leak 4, a DEAD AFFORDANCE rather than stale content. Both chips name keys
		 * that do something else inside an agent's view: `esc` returns to the main
		 * session instead of interrupting, and the dequeue key drains the DRIVING
		 * session's queue into the editor the agent is looking at. The band was
		 * built from the driving session and never rebuilt on a focus transition,
		 * so it advertised both.
		 */
		it("drops the interrupt and dequeue chips inside a focused agent and brings them back on Esc", async () => {
			const { mode: m, terminal: t } = booted();
			if (!mainSession) throw new Error("mainSession not booted");
			// Accessor properties: `vi.spyOn` cannot stub a getter under bun, and the
			// band only reads these two, so define them directly on the instance.
			Object.defineProperty(mainSession, "isStreaming", { get: () => true, configurable: true });
			Object.defineProperty(mainSession, "queuedMessageCount", { get: () => 1, configurable: true });
			m.refreshComposerShortcuts();
			const mainBand = m.composerShortcuts.render(WIDTH).join("\n");
			expect(Bun.stripANSI(mainBand)).toContain("interrupt");
			expect(Bun.stripANSI(mainBand)).toContain("dequeue");

			await focusChild();

			const focusedBand = Bun.stripANSI(m.composerShortcuts.render(WIDTH).join("\n"));
			expect(focusedBand).not.toContain("interrupt");
			expect(focusedBand).not.toContain("dequeue");

			await m.unfocusSession();
			await t.waitForRender();

			// Exact bytes: the restored band is the same row, not merely one that
			// mentions the same words.
			expect(m.composerShortcuts.render(WIDTH).join("\n")).toBe(mainBand);
		});
	});
});

/**
 * The subtree filter behind the badge. Kept as a unit here because the count is
 * the registry's own answer about its spawn tree, and the interactive suite
 * above only proves the wiring reaches it.
 */
describe("AgentRegistry.runningSubagentCount", () => {
	function seed(): AgentRegistry {
		const registry = new AgentRegistry();
		for (const [id, parentId] of [
			["Anna", MAIN_AGENT_ID],
			["Anna.Bob", "Anna"],
			["Anna.Bob.Carol", "Anna.Bob"],
			["Zed", MAIN_AGENT_ID],
		] as const) {
			registry.register({ id, displayName: id, kind: "sub", parentId, session: null, status: "running" });
		}
		return registry;
	}

	it("counts every running spawn when no agent is focused", () => {
		expect(seed().runningSubagentCount(undefined, undefined)).toBe(4);
	});

	it("counts the whole subtree below a focused agent, not just its direct children", () => {
		expect(seed().runningSubagentCount(undefined, "Anna")).toBe(2);
	});

	it("excludes the focused agent itself, which is the view rather than work inside it", () => {
		expect(seed().runningSubagentCount(undefined, "Anna.Bob")).toBe(1);
		expect(seed().runningSubagentCount(undefined, "Anna.Bob.Carol")).toBe(0);
	});

	it("ignores spawns that are not running", () => {
		const registry = seed();
		registry.setStatus("Anna.Bob", "parked");
		expect(registry.runningSubagentCount(undefined, "Anna")).toBe(1);
	});
});
