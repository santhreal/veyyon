/**
 * WHY: a goal set in a session came back unset, with nothing on screen, in the log, or on the
 * branch saying which path took it. Three paths could clear one, and every one of them was mute:
 *
 *   1. THE SESSION FILE WAS DELETED. `isDraftOnlyMetadataEntry` classified `mode_change` as
 *      startup selector state, so a session whose only entries were the goal record plus a model
 *      pick counted as empty and `#dropIfEmptyAndNoDraft` removed the file on close. A goal set
 *      before the first turn — the ordinary way one is set — took the objective with it.
 *   2. A SETTINGS TOGGLE ATE IT. `goal.enabled` off with a stored goal recorded
 *      `mode_change("none")`, which is not a suppression, it is a deletion: turning Goal Mode back
 *      on restored nothing, because the objective was gone from the branch.
 *   3. AN UNREADABLE RECORD CLEARED WITHOUT A WORD. A `mode_change` whose `data.goal` fails the
 *      shape check is cleared, correctly — a record that cannot be parsed cannot be restored — but
 *      silently, which is what made the whole class read as "the goal unsets itself".
 *
 * The class this closes: a goal that was set is either RESTORED or REPORTED. Every path that
 * declines to restore one says so, and no path destroys the record for a reason the operator can
 * reverse.
 *
 * What it does not catch: a branch switch that walks to a leaf whose path carries an older
 * `mode_change` — the goal is genuinely not on that branch, and the reconciler cannot tell that
 * from a session that never had one. Nor a peer process rewriting the file underneath.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { isEnoent, TempDir } from "@veyyon/utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** The shape `GoalRuntime` persists through `appendModeChange`, as it lands on the branch. */
function storedGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "goal-1",
		objective: "Ship the release",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turnsCompleted: 0,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		...overrides,
	};
}

let shared: { authStorage: AuthStorage; modelRegistry: ModelRegistry; model: Model; baseDir: TempDir };

beforeAll(async () => {
	initTheme();
	const baseDir = TempDir.createSync("@pi-goal-silence-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	shared = { authStorage, modelRegistry, model, baseDir };
});

afterAll(() => {
	shared.authStorage.close();
	shared.baseDir.removeSync();
});

describe("the session file keeps a goal that has no conversation yet", () => {
	it("keeps a session whose only durable entry is an active goal", async () => {
		using tempDir = TempDir.createSync("@pi-goal-keeps-file-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("anthropic/claude-sonnet-4-5");
		session.appendModeChange("goal", { goal: storedGoal() });

		await session.saveDraft("some unsent text");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("keeps a session whose only durable entry is a paused goal", async () => {
		using tempDir = TempDir.createSync("@pi-goal-keeps-file-paused-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModeChange("goal_paused", { goal: storedGoal({ status: "paused" }) });

		await session.saveDraft("some unsent text");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	/**
	 * The behavior the goal exemption must not widen. `plan.defaultOnStartup` writes its
	 * `mode_change` before the draft is restored, so a plan entry beside a cleared draft is still
	 * an abandoned session and is still dropped. Kept here so the exemption stays goal-shaped.
	 */
	it("still drops a session whose only entries are a plan mode change and a model pick", async () => {
		using tempDir = TempDir.createSync("@pi-goal-still-drops-plan-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("anthropic/claude-sonnet-4-5");
		session.appendModeChange("plan", { planFilePath: "local://PLAN.md" });

		await session.saveDraft("plan-mode draft");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	/** A goal that was dropped leaves `mode_change("none")`, which is selector state again. */
	it("drops a session whose goal was already cleared to none", async () => {
		using tempDir = TempDir.createSync("@pi-goal-dropped-then-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModeChange("goal", { goal: storedGoal() });
		session.appendModeChange("none");

		await session.saveDraft("draft");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});
});

describe("a reconcile that declines to restore a goal says so", () => {
	type Harness = {
		tempDir: TempDir;
		settings: Settings;
		sessionManager: SessionManager;
		session: AgentSession;
		mode: InteractiveMode;
	};
	const live: Harness[] = [];
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let session: AgentSession;
	let mode: InteractiveMode;

	/**
	 * A fresh process over the same session directory. `attachTo` is what a restart
	 * looks like: the journal is on disk and a new mode reconciles from it, which is
	 * the only way to observe a setting flipped between runs.
	 */
	const build = async (options: { goalEnabled: boolean; attachTo?: string }): Promise<Harness> => {
		resetSettingsForTest();
		const dir = options.attachTo ? tempDir : TempDir.createSync("@pi-goal-silence-");
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const built: Settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": options.goalEnabled,
			"plan.enabled": true,
		});
		const toolSession: ToolSession = {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => options.attachTo ?? null,
			getSessionSpawns: () => "*",
			settings: built,
		};
		const initialTools = await createTools(toolSession, ["read"]);
		const manager = SessionManager.create(dir.path(), dir.path());
		if (options.attachTo) await manager.setSessionFile(options.attachTo);
		const agentSession = new AgentSession({
			agent: new Agent({
				initialState: { model: shared.model, systemPrompt: ["Test"], tools: initialTools, messages: [] },
			}),
			sessionManager: manager,
			settings: built,
			modelRegistry: shared.modelRegistry,
			toolRegistry: new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const)),
			builtInToolNames: ["read", "goal"],
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		const harness: Harness = {
			tempDir: dir,
			settings: built,
			sessionManager: manager,
			session: agentSession,
			mode: new InteractiveMode(agentSession, "test"),
		};
		live.push(harness);
		({ tempDir, sessionManager, session, mode } = harness);
		return harness;
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		for (const harness of live.reverse()) {
			harness.mode.stop();
			await harness.session.dispose();
		}
		const dirs = new Set(live.map(harness => harness.tempDir));
		live.length = 0;
		for (const dir of dirs) dir.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("names the objective it is leaving inactive when Goal Mode is off, and keeps the record", async () => {
		await build({ goalEnabled: false });
		sessionManager.appendModeChange("goal", { goal: storedGoal() });
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.init();

		expect(showWarning).toHaveBeenCalledWith(
			'Goal Mode is off in settings, so "Ship the release" stays stored and inactive.',
		);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(mode.goalModeEnabled).toBe(false);
		// The record survives, so flipping the setting back on restores the goal rather than
		// finding a session that never had one.
		expect(sessionManager.buildSessionContext().mode).toBe("goal");
	});

	it("restores the very goal a disabled run left behind once the setting is back on", async () => {
		const off = await build({ goalEnabled: false });
		off.sessionManager.appendModeChange("goal", { goal: storedGoal() });
		vi.spyOn(off.mode, "showWarning").mockImplementation(() => {});
		await off.mode.init();
		expect(off.session.getGoalModeState()).toBeUndefined();
		const sessionFile = off.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		// A goal-only session is metadata-only, so force the journal onto disk the way a
		// draft save or a first turn would: the restart has to read the record, not memory.
		await off.sessionManager.ensureOnDisk();
		await off.sessionManager.close();
		expect(await fileExists(sessionFile)).toBe(true);

		const on = await build({ goalEnabled: true, attachTo: sessionFile });
		await on.mode.init();

		expect(on.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
	});

	it("truncates a long objective in the notice rather than printing the whole thing", async () => {
		await build({ goalEnabled: false });
		const objective = "a".repeat(200);
		sessionManager.appendModeChange("goal", { goal: storedGoal({ objective }) });
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.init();

		const message = showWarning.mock.calls.at(0)?.[0] ?? "";
		expect(message).toContain(`"${"a".repeat(47)}…"`);
		expect(message).not.toContain("a".repeat(49));
	});

	/** Every member of the record's shape, not the one field that was reported. */
	it.each([
		["a goal that is not an object", "not-a-record"],
		["a missing id", storedGoal({ id: undefined })],
		["a missing objective", storedGoal({ objective: undefined })],
		["a missing status", storedGoal({ status: undefined })],
		["a non-numeric tokensUsed", storedGoal({ tokensUsed: "0" })],
		["a non-numeric timeUsedSeconds", storedGoal({ timeUsedSeconds: null })],
		["a missing createdAt", storedGoal({ createdAt: undefined })],
		["a missing updatedAt", storedGoal({ updatedAt: undefined })],
	])("reports the clear when the stored record is unreadable: %s", async (_label, goal) => {
		await build({ goalEnabled: true });
		sessionManager.appendModeChange("goal", { goal });
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.init();

		expect(showWarning).toHaveBeenCalledWith("This session's stored goal could not be read and was cleared.");
		expect(session.getGoalModeState()).toBeUndefined();
		// Unreadable is the one case that clears the branch: nothing could restore it.
		expect(sessionManager.buildSessionContext().mode).toBe("none");
	});

	/** A readable goal is restored, and restoring one is not an occasion for a warning. */
	it("restores a readable goal without warning about it", async () => {
		await build({ goalEnabled: true });
		sessionManager.appendModeChange("goal", { goal: storedGoal() });
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.init();

		expect(showWarning).not.toHaveBeenCalled();
		expect(session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		// An active goal auto-pauses on resume, which the status line reports; the goal itself is
		// still there, which is the difference between paused and unset.
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});
});
