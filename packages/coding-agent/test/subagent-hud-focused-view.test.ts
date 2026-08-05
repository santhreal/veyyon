/**
 * Contract: the in-transcript "Subagents" HUD and the composer footline belong
 * to the VIEWED session, not to the driving session.
 *
 * THE DEFECT THIS SUITE WAS WRITTEN AGAINST. Focusing into an agent from
 * `/agents` retargets the transcript, the status line and the editor at that
 * agent's session (SessionFocusController), but the anchored subagent HUD kept
 * rendering the MAIN session's observer list: inside the agent's view the
 * block still named the parent's running agents, which is false (the viewed
 * agent spawned none of them), and it was also the reason the two views were
 * indistinguishable. And the one badge that named the viewed agent and the way
 * out (`focusExitBadge`, "esc to go back") hung off `getTopBorder`, a method
 * the borderless composer never calls, so nothing persistent on screen said
 * whose session you were in or that Esc leaves it.
 *
 * The fix scopes the HUD at the caller: `getSessionsSpawnedBy(focusedAgentId)`
 * hands the renderer the viewed session's own spawn scope (empty for a leaf
 * agent, so the block clears itself through the existing empty-array path),
 * and the focus badge rides the quiet footline, the one persistent status
 * surface the borderless composer has.
 *
 * Frames are asserted on the VirtualTerminal viewport: what the operator sees,
 * not what a component would render in isolation. Set HUD_FRAME_DUMP=1 to print
 * the captured frames.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
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

const DUMP = process.env.HUD_FRAME_DUMP === "1";
function dumpFrame(title: string, lines: string[]): void {
	if (!DUMP) return;
	console.log(`\n===== ${title} =====`);
	for (const line of lines) console.log(line);
	console.log(`===== end ${title} =====\n`);
}

function makeLifecycle(id: string, index: number, description: string): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: `call-${id}`,
		detached: true,
	};
}

describe("the subagent HUD while the view is focused on an agent", () => {
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
		tempDir = TempDir.createSync("@pi-hud-focus-");
		childTempDir = TempDir.createSync("@pi-hud-focus-child-");
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
		terminal = new VirtualTerminal(110, 30);
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

	/** The HUD block's painted bytes: the exact lines the anchored container hands the frame. */
	function hudText(): string {
		if (!mode) throw new Error("mode not booted");
		return Bun.stripANSI(mode.subagentContainer.render(110).join("\n"));
	}

	function viewportText(): string {
		if (!terminal) throw new Error("terminal not booted");
		return terminal.getViewport().join("\n");
	}

	/**
	 * Emit the spawn, then drive the observer coalesce window (100ms,
	 * SUBAGENT_OBSERVER_UI_COALESCE_MS) on the fake clock: the flush that
	 * re-renders the HUD is a setTimeout, and faking only around the emit keeps
	 * VirtualTerminal.waitForRender (itself real-time) working. The flush's
	 * requestRender lands on the fake clock too, so re-request on the real
	 * clock or the paint it scheduled is discarded with the fake timers.
	 */
	async function spawnDetached(id: string, index: number, description: string): Promise<void> {
		if (!eventBus) throw new Error("eventBus not booted");
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, index, description));
		vi.advanceTimersByTime(150);
		vi.useRealTimers();
		mode?.ui.requestRender();
		await terminal?.waitForRender();
	}

	it("scopes the HUD to the viewed session and names the view and the way out", async () => {
		await spawnDetached("AuthLoader", 0, "Refactoring the auth flow");
		await spawnDetached("SchemaMigrator", 1, "Migrating the users table");

		const mainHud = hudText();
		const mainFrame = viewportText();
		dumpFrame("MAIN VIEW HUD (two detached subagents running)", mainHud.split("\n"));
		dumpFrame("MAIN VIEWPORT", mainFrame.split("\n"));
		expect(mainHud).toContain("Subagents");
		expect(mainHud).toContain("AuthLoader: Refactoring the auth flow");
		expect(mainHud).toContain("SchemaMigrator: Migrating the users table");
		// The main view carries no focus badge.
		expect(mainFrame).not.toContain("esc to go back");

		// Focus into AuthLoader, the /agents "Enter opens one in the main view" path.
		if (!childSession) throw new Error("childSession not booted");
		AgentRegistry.global().register({
			id: "AuthLoader",
			displayName: "AuthLoader",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childSession,
			status: "running",
		});
		if (!mode) throw new Error("mode not booted");
		await mode.focusAgentSession("AuthLoader");
		await terminal?.waitForRender();

		const focusedHud = hudText();
		const focusedFrame = viewportText();
		dumpFrame("FOCUSED VIEW HUD (inside AuthLoader)", focusedHud.split("\n"));
		dumpFrame("FOCUSED VIEWPORT (inside AuthLoader)", focusedFrame.split("\n"));

		// Requirement 1: the HUD lists the VIEWED session's own spawns. AuthLoader
		// is a leaf (nested spawn depth 0), so the block clears itself; the
		// parent's agents must not appear in its view.
		expect(focusedHud).not.toContain("Subagents");
		expect(focusedHud).not.toContain("SchemaMigrator");
		expect(focusedHud).not.toContain("AuthLoader: Refactoring the auth flow");

		// Requirement 2: a persistent indicator names the agent you are inside.
		// The badge rides the pinned composer footline, so it is in the viewport
		// bytes of every frame while focused; the HUD row form is gone (asserted
		// above), so the remaining "AuthLoader" is the badge's.
		expect(focusedFrame).toContain("AuthLoader");

		// Requirement 3: the way out is on screen whenever you are inside one.
		// "esc to go back" exists only in the focus badge; the transient flash
		// focusAgent prints says something else ("Esc returns to main").
		expect(focusedFrame).toContain("esc to go back");

		// Leaving restores the driving session's scope, unchanged.
		await mode.unfocusSession();
		await terminal?.waitForRender();
		const restoredHud = hudText();
		const restoredFrame = viewportText();
		dumpFrame("MAIN VIEW HUD RESTORED (after esc)", restoredHud.split("\n"));
		expect(restoredHud).toContain("Subagents");
		expect(restoredHud).toContain("AuthLoader: Refactoring the auth flow");
		expect(restoredHud).toContain("SchemaMigrator: Migrating the users table");
		expect(restoredFrame).not.toContain("esc to go back");
	});
});

describe("SessionObserverRegistry.getSessionsSpawnedBy", () => {
	function seed(): SessionObserverRegistry {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Anna", 0, "top level work"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Anna.Bob", 1, "nested work"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Anna.Bob.Carol", 2, "doubly nested work"));
		return registry;
	}

	it("scopes the driving session to top-level spawns only", () => {
		const ids = seed()
			.getSessionsSpawnedBy(undefined)
			.map(session => session.id);
		expect(ids).toEqual(["Anna"]);
	});

	it("scopes a focused agent to its direct children, not the whole subtree", () => {
		const ids = seed()
			.getSessionsSpawnedBy("Anna")
			.map(session => session.id);
		expect(ids).toEqual(["Anna.Bob"]);
	});

	it("answers empty for a leaf agent, the truth rather than a fallback", () => {
		expect(seed().getSessionsSpawnedBy("Anna.Bob.Carol")).toEqual([]);
		expect(seed().getSessionsSpawnedBy("NeverSpawned")).toEqual([]);
	});
});
