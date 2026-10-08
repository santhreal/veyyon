/**
 * WHY: the goal runtime records the goal each time a tool call spends tokens on it, and each record
 * was a `mode_change` holding the whole goal. The objective, often kilobytes, was written again on
 * every tool call: one long goal session held 43,000 copies, 97MB of a 720MB transcript, all of it
 * parsed again on every resume.
 *
 * The class this closes: a goal record that repeats what the branch already holds. Every write
 * goes through `recordGoal` and every read through `readRecordedGoal`, and this suite drives both
 * through the production host (`AgentSession`'s goal runtime) across every kind of change the
 * runtime makes — usage, budget, pause, resume, replace, complete, the post-completion token
 * reconciliation and drop — asserting after each step that the branch reads back as exactly the
 * goal the runtime holds, and that only a change of goal, mode, status or budget writes the
 * objective. Each of those four changes is driven twice, once right after a full record and once
 * right after a usage record, because the writer compares against whichever is nearest. A restart
 * through `InteractiveMode` proves the reader the product calls sees the latest counters, a branch
 * moved back to an earlier record proves the reader follows the active branch rather than the
 * newest line in the file, and a usage record of another goal proves the reader takes counters
 * only from the goal it restores.
 *
 * What it does not catch: a new `GoalRuntime` method that writes state without going through the
 * host's `persist` (the roster in `no-goal-runtime-path-clears-a-goal-in-silence.test.ts` fences
 * the methods), a second writer of goal records outside `recordGoal`, and a full record that
 * lacks its objective, which no build writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GOAL_PROGRESS_CUSTOM_TYPE, readRecordedGoal } from "@veyyon/coding-agent/goals/goal-record";
import type { GoalTokenUsage } from "@veyyon/coding-agent/goals/state";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

// The runtime stores a trimmed objective, so the fixtures carry no trailing space.
const OBJECTIVE = "Ship the release with every installer verified. ".repeat(40).trim();
const REPLACEMENT = "Cut the next patch once the release is out. ".repeat(40).trim();

function usage(input: number): GoalTokenUsage {
	return { input, output: input / 10, cacheRead: 0, cacheWrite: 0 };
}

/** What the goal record nearest the leaf is, as a word: `goal`, `goal_paused`, `none` or `progress`. */
function recordKind(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type === "mode_change") return entry.mode;
	if (entry?.type === "custom" && entry.customType === GOAL_PROGRESS_CUSTOM_TYPE) return "progress";
	return undefined;
}

let shared: { authStorage: AuthStorage; modelRegistry: ModelRegistry; model: Model; baseDir: TempDir };

beforeAll(async () => {
	initTheme();
	const baseDir = TempDir.createSync("@pi-goal-record-shared-");
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

describe("a goal usage record does not repeat the objective", () => {
	const live: { session: AgentSession; mode?: InteractiveMode; dir: TempDir }[] = [];

	async function build(options: { dir?: TempDir; attachTo?: string; interactive?: boolean } = {}) {
		resetSettingsForTest();
		const dir = options.dir ?? TempDir.createSync("@pi-goal-record-");
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": true,
			"goal.modelBudgetsEnabled": true,
		});
		const sessionManager = SessionManager.create(dir.path(), dir.path());
		if (options.attachTo) await sessionManager.setSessionFile(options.attachTo);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: shared.model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: shared.modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		const mode = options.interactive ? new InteractiveMode(session, "test") : undefined;
		live.push({ session, mode, dir });
		return { session, sessionManager, mode, dir };
	}

	afterEach(async () => {
		for (const { session, mode } of live.reverse()) {
			mode?.stop();
			await session.dispose();
		}
		const dirs = new Set(live.map(entry => entry.dir));
		live.length = 0;
		for (const dir of dirs) dir.removeSync();
		resetSettingsForTest();
	});

	it("reads back as the runtime's goal after every change, and writes the objective only when the goal changes", async () => {
		const { session, sessionManager } = await build();
		const runtime = session.goalRuntime;
		const steps: [string, () => Promise<unknown>, string][] = [
			["create", () => runtime.createGoal({ objective: OBJECTIVE }), "goal"],
			// A budget change right after a full record.
			["budget before any usage", () => runtime.onBudgetMutated(1_000_000), "goal"],
			["first usage", () => runtime.flushUsage("suppressed", usage(100)), "progress"],
			["second usage", () => runtime.flushUsage("suppressed", usage(200)), "progress"],
			// A budget change right after a usage record.
			["budget after usage", () => runtime.onBudgetMutated(2_000_000), "goal"],
			["usage under a budget", () => runtime.flushUsage("suppressed", usage(300)), "progress"],
			["pause", () => runtime.pauseGoal(), "goal_paused"],
			["resume", () => runtime.resumeGoal(), "goal"],
			// A new goal under the same mode, status and budget, right after a full record.
			[
				"replace before any usage",
				() => runtime.replaceGoal({ objective: REPLACEMENT, tokenBudget: 2_000_000 }),
				"goal",
			],
			["usage of the replacement", () => runtime.flushUsage("suppressed", usage(400)), "progress"],
			// A new goal under the same mode, status and budget, right after a usage record.
			["replace after usage", () => runtime.replaceGoal({ objective: OBJECTIVE, tokenBudget: 2_000_000 }), "goal"],
			["usage of the second replacement", () => runtime.flushUsage("suppressed", usage(500)), "progress"],
			// A status change right after a usage record.
			["complete after usage", () => runtime.completeGoalFromTool(), "goal"],
			["tokens spent finishing the turn", () => runtime.onAgentEnd({ currentUsage: usage(600) }), "progress"],
			// An interrupt while the completing turn finishes: the mode changes and the status does not.
			["pause the completed goal after usage", () => runtime.pauseGoal(), "goal_paused"],
			["drop", () => runtime.dropGoal(), "none"],
			["create again", () => runtime.createGoal({ objective: REPLACEMENT }), "goal"],
			// A status change right after a full record.
			["complete before any usage", () => runtime.completeGoalFromTool(), "goal"],
			// A mode change alone, right after a full record.
			["pause the completed goal before any usage", () => runtime.pauseGoal(), "goal_paused"],
			["drop again", () => runtime.dropGoal(), "none"],
		];
		runtime.onTurnStart("turn-1");

		const kinds: string[] = [];
		// The mode a reader resolves is the one the last full record wrote; a usage record keeps it.
		let recordedMode = "none";
		for (const [label, step, expectedKind] of steps) {
			const before = sessionManager.getEntries().length;
			await step();
			const leaf = sessionManager.getLeafEntry();
			// Every step in the table writes exactly one record, and it is the leaf.
			expect({ label, written: sessionManager.getEntries().length - before }).toEqual({ label, written: 1 });
			kinds.push(recordKind(leaf) ?? `unexpected ${leaf?.type}`);
			if (expectedKind !== "progress") recordedMode = expectedKind;

			const context = sessionManager.buildSessionContext();
			const held = session.getGoalModeState();
			expect({ label, goal: readRecordedGoal(sessionManager, context.modeData) }).toEqual({
				label,
				goal: held?.goal,
			});
			expect({ label, mode: context.mode }).toEqual({ label, mode: recordedMode });
			if (leaf?.type === "custom") expect({ label, data: leaf.data }).not.toHaveProperty("data.objective");
			if (leaf?.type === "mode_change" && leaf.mode !== "none") {
				// A build that predates `goal_progress` reads only this record, so it must hold the whole goal.
				const recorded = leaf.data?.goal as { objective?: unknown } | undefined;
				expect({ label, objective: recorded?.objective }).toEqual({
					label,
					objective: held?.goal.objective,
				});
			}
		}
		expect(kinds).toEqual(steps.map(([, , kind]) => kind));
	});

	it("restores the latest counters after a restart while the file holds the objective once", async () => {
		const first = await build({ interactive: true });
		const runtime = first.session.goalRuntime;
		await runtime.createGoal({ objective: OBJECTIVE });
		runtime.onTurnStart("turn-1");
		for (let turn = 1; turn <= 20; turn++) await runtime.flushUsage("suppressed", usage(turn * 100));
		await runtime.onAgentEnd({ currentUsage: usage(2_100) });
		const before = first.session.getGoalModeState()?.goal;
		if (!before) throw new Error("expected a goal before the restart");
		expect(before.tokensUsed).toBe(2_310);
		expect(before.turnsCompleted).toBe(1);

		const sessionFile = first.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persistent session file");
		await first.sessionManager.ensureOnDisk();
		await first.sessionManager.close();
		const text = await fs.readFile(sessionFile, "utf8");
		expect(text.split(OBJECTIVE).length - 1).toBe(1);

		const second = await build({ dir: first.dir, attachTo: sessionFile, interactive: true });
		await second.mode?.init();

		const restored = second.session.getGoalModeState()?.goal;
		expect(restored).toMatchObject({
			id: before.id,
			objective: OBJECTIVE,
			tokensUsed: before.tokensUsed,
			timeUsedSeconds: before.timeUsedSeconds,
			turnsCompleted: before.turnsCompleted,
			// A goal that was driving when the session closed comes back paused.
			status: "paused",
		});
	});

	it("reads the counters of the active branch, not of the newest record in the file", async () => {
		const { session, sessionManager } = await build();
		const runtime = session.goalRuntime;
		await runtime.createGoal({ objective: OBJECTIVE });
		runtime.onTurnStart("turn-1");
		await runtime.flushUsage("suppressed", usage(100));
		const firstUsage = sessionManager.getLeafId();
		if (!firstUsage) throw new Error("expected a usage record");
		await runtime.flushUsage("suppressed", usage(200));
		expect(readRecordedGoal(sessionManager, sessionManager.buildSessionContext().modeData)?.tokensUsed).toBe(220);

		sessionManager.branch(firstUsage);

		expect(readRecordedGoal(sessionManager, sessionManager.buildSessionContext().modeData)).toMatchObject({
			objective: OBJECTIVE,
			tokensUsed: 110,
		});
	});

	it("takes counters only from a usage record of the goal it restores", async () => {
		const { session, sessionManager } = await build();
		await session.goalRuntime.createGoal({ objective: OBJECTIVE });
		const held = session.getGoalModeState()?.goal;
		if (!held) throw new Error("expected a goal");
		sessionManager.appendCustomEntry(GOAL_PROGRESS_CUSTOM_TYPE, {
			mode: "goal",
			goalId: `${held.id}-other`,
			status: held.status,
			tokensUsed: 9_999,
			timeUsedSeconds: 99,
			turnsCompleted: 9,
			updatedAt: held.updatedAt + 1,
		});

		expect(readRecordedGoal(sessionManager, sessionManager.buildSessionContext().modeData)).toEqual(held);
	});
});
