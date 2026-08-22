/**
 * WHY: an active goal came back paused with nothing in the session saying who paused it. Every
 * abort routes through `AgentSession#abort`, whose `goalReason` decided the goal's fate, and the
 * default was `interrupted` — the reading that pauses. So a site that aborted a turn to do its own
 * work and passed no reason paused the goal exactly as if the operator had pressed Esc, and the
 * only record of the difference was which call site happened to spell the option out.
 *
 * The class this closes: the reason vocabulary has one owner (`GoalAbortReason`), every member of
 * it is classified here, and adding a third member CANNOT compile until it is classified — the
 * sweep is keyed by a `Record<GoalAbortReason, …>`, so a new reason is a type error in this file
 * before it is a behavior nobody checked. The reasons are exercised through the real
 * `session.abort()` against a real goal, not through the runtime helper underneath it, because the
 * defect was in what `abort` passes down rather than in what the runtime does with it.
 *
 * What it does not catch: which reason a given call site SHOULD pass. That is a judgement per site
 * and the compiler cannot make it; this suite fixes what each reason means once it is passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { GoalAbortReason } from "@veyyon/coding-agent/goals/state";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * Every reason, and what an active goal does about it. Keyed by the union, so a new member fails
 * this file's typecheck until someone decides which column it belongs in.
 */
const REASONS: Record<GoalAbortReason, "pauses" | "keeps driving"> = {
	interrupted: "pauses",
	internal: "keeps driving",
};

describe("only an operator interrupt pauses an active goal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-abort-reason-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic test model");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "anthropic-test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it.each(Object.keys(REASONS) as GoalAbortReason[])("an abort for %s reaches the goal", async reason => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		expect(session.getGoalModeState()?.goal.status).toBe("active");

		await session.abort({ goalReason: reason });

		const expected = REASONS[reason] === "pauses" ? "paused" : "active";
		expect(session.getGoalModeState()?.goal.status).toBe(expected);
		// A pause keeps the goal enabled and restorable; it is not a drop.
		expect(session.getGoalModeState()?.goal.objective).toBe("Ship the release");
	});

	it("reads an abort that names no reason as the operator interrupting", async () => {
		// The default is the safe one: a site that has not thought about goals stops the goal
		// rather than driving on through whatever the abort was for.
		await session.goalRuntime.createGoal({ objective: "Ship the release" });

		await session.abort();

		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("leaves an already paused goal paused whichever reason aborts it", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await session.goalRuntime.pauseGoal();

		for (const reason of Object.keys(REASONS) as GoalAbortReason[]) {
			await session.abort({ goalReason: reason });
			expect(session.getGoalModeState()?.goal.status).toBe("paused");
		}
	});
});
