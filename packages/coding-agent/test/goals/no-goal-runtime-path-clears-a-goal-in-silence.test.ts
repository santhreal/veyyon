/**
 * WHY: a goal disappeared from a session with nothing saying so. The record was gone, the footline
 * stopped showing it, and the only way to find out was to ask why the agent had stopped driving.
 * Every write to goal state goes through one object, `GoalRuntime`, and each of its methods decides
 * on its own whether the goal keeps driving, stops, or is erased — so one method that erased state
 * without announcing it was enough to lose a goal in silence, and nothing in the suite noticed
 * because nothing enumerated the methods.
 *
 * The class this closes: the roster is read from `GoalRuntime.prototype` at run time and pinned
 * against the decision table below by exact set equality, so a method added to the runtime turns
 * this file RED until someone classifies it. Each classified method is then invoked against a real
 * active goal on a real `AgentSession` — the production host, which is what persists the mode change
 * and emits the session event — and the resulting state, announcement, and persisted mode are all
 * asserted. A path that stops or erases a goal MUST emit a `goal_updated` describing it; a path that
 * keeps the goal MUST NOT emit one that says otherwise.
 *
 * What it does not catch: which method a given call site SHOULD call, and whether a caller passes
 * the right abort reason — `only-an-operator-interrupt-pauses-a-goal.test.ts` owns that question.
 * It also does not judge private helpers: `#`-private members are not properties, so they cannot be
 * enumerated, and they reach state only through the public methods swept here. Two variants get
 * past it: a row whose invoker does not really reach its method (the roster proves the method
 * exists, not that the call arrived), and a clear that happens outside this class —
 * `a-goal-is-never-unset-in-silence.test.ts` fences the session-manager and mode-reconcile paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GoalRuntime } from "@veyyon/coding-agent/goals/runtime";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";

/** What an active goal looks like after the method ran. */
type Fate =
	/** Still driving: enabled, status active. */
	| "keeps driving"
	/** Stopped but restorable: state present, status paused. */
	| "pauses"
	/** Finished: state present, status complete. */
	| "completes"
	/** Erased: no state left. The announcement is what stops this being silent. */
	| "erases"
	/** Rejected: the call throws and the goal is untouched. */
	| "refuses";

interface Classified {
	fate: Fate;
	/** The mode the session journal must record, when the method persists one. */
	persists?: "goal" | "goal_paused" | "none";
	invoke: (session: AgentSession) => unknown;
}

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

/**
 * Every method `GoalRuntime` exposes, and what it does to an active goal. Adding a method to the
 * runtime without adding a row here fails the roster test below.
 */
const RUNTIME_PATHS: Record<string, Classified> = {
	snapshot: { fate: "keeps driving", invoke: session => session.goalRuntime.snapshot },
	clearAccounting: { fate: "keeps driving", invoke: session => session.goalRuntime.clearAccounting() },
	onTurnStart: { fate: "keeps driving", invoke: session => session.goalRuntime.onTurnStart("turn-1", USAGE) },
	onToolCompleted: { fate: "keeps driving", invoke: session => session.goalRuntime.onToolCompleted("read") },
	onGoalToolCompleted: { fate: "keeps driving", invoke: session => session.goalRuntime.onGoalToolCompleted() },
	onAgentEnd: { fate: "keeps driving", invoke: session => session.goalRuntime.onAgentEnd() },
	flushUsage: { fate: "keeps driving", invoke: session => session.goalRuntime.flushUsage("suppressed") },
	buildActivePrompt: { fate: "keeps driving", invoke: session => session.goalRuntime.buildActivePrompt() },
	buildContinuationPrompt: { fate: "keeps driving", invoke: session => session.goalRuntime.buildContinuationPrompt() },
	// Reached only through `AgentSession#abort`, which always names a reason; driven here through
	// that caller so the sweep sees the pause a real interrupt produces.
	onTaskAborted: { fate: "pauses", persists: "goal_paused", invoke: session => session.abort() },
	// Resuming a thread stops an active goal rather than driving on in a session the operator just
	// reopened. It stays restorable, and it says so.
	onThreadResumed: {
		fate: "pauses",
		persists: "goal_paused",
		invoke: session => session.goalRuntime.onThreadResumed(),
	},
	pauseGoal: { fate: "pauses", persists: "goal_paused", invoke: session => session.goalRuntime.pauseGoal() },
	resumeGoal: { fate: "keeps driving", persists: "goal", invoke: session => session.goalRuntime.resumeGoal() },
	replaceGoal: {
		fate: "keeps driving",
		persists: "goal",
		invoke: session => session.goalRuntime.replaceGoal({ objective: "Ship the next release" }),
	},
	completeGoalFromTool: {
		fate: "completes",
		persists: "goal",
		invoke: session => session.goalRuntime.completeGoalFromTool(),
	},
	dropGoal: { fate: "erases", persists: "none", invoke: session => session.goalRuntime.dropGoal() },
	// A session may hold one goal, so creating a second one is refused rather than overwriting the
	// first — the overwrite is how a goal used to vanish.
	createGoal: { fate: "refuses", invoke: session => session.goalRuntime.createGoal({ objective: "Something else" }) },
	// Budgets are off by default, so the knob refuses instead of quietly editing the goal.
	onBudgetMutated: { fate: "refuses", invoke: session => session.goalRuntime.onBudgetMutated(1000) },
};

const STOPS: Record<Fate, boolean> = {
	"keeps driving": false,
	pauses: true,
	completes: true,
	erases: true,
	refuses: false,
};

describe("no goal runtime path clears a goal in silence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let announcements: AgentSessionEvent[];
	let modeChanges: string[];

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-runtime-sweep-");
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
		announcements = [];
		modeChanges = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "goal_updated") announcements.push(event);
		});
		const appendModeChange = session.sessionManager.appendModeChange.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "appendModeChange").mockImplementation((mode, extra) => {
			modeChanges.push(mode);
			return appendModeChange(mode, extra);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function activeGoal(): Promise<void> {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		announcements = [];
		modeChanges = [];
	}

	/** Runs one classified path and returns the error it refused with, if it refused. */
	async function drive(classified: Classified): Promise<Error | undefined> {
		try {
			await classified.invoke(session);
			return undefined;
		} catch (err) {
			return err as Error;
		}
	}

	it("classifies every method the runtime exposes", () => {
		const roster = Object.getOwnPropertyNames(GoalRuntime.prototype).filter(name => name !== "constructor");
		// Exact equality both ways: an unclassified new method fails here, and so does a row for a
		// method that no longer exists.
		expect(new Set(roster)).toEqual(new Set(Object.keys(RUNTIME_PATHS)));
	});

	it.each(Object.keys(RUNTIME_PATHS))("%s leaves the goal in the state it claims", async name => {
		const classified = RUNTIME_PATHS[name];
		if (!classified) throw new Error(`no classification for ${name}`);
		await activeGoal();

		const refusal = await drive(classified);

		const state = session.getGoalModeState();
		switch (classified.fate) {
			case "keeps driving":
				expect(refusal).toBeUndefined();
				expect(state?.enabled).toBe(true);
				expect(state?.goal.status).toBe("active");
				break;
			case "pauses":
				expect(refusal).toBeUndefined();
				expect(state?.goal.status).toBe("paused");
				expect(state?.enabled).toBe(false);
				// A pause keeps the record the operator can resume from.
				expect(state?.goal.objective).toBe("Ship the release");
				break;
			case "completes":
				expect(refusal).toBeUndefined();
				expect(state?.goal.status).toBe("complete");
				break;
			case "erases":
				expect(refusal).toBeUndefined();
				expect(state).toBeUndefined();
				break;
			case "refuses":
				expect(refusal?.message.length ?? 0).toBeGreaterThan(0);
				expect(state?.enabled).toBe(true);
				expect(state?.goal.status).toBe("active");
				break;
		}
	});

	it.each(Object.keys(RUNTIME_PATHS))("%s announces a goal it stops", async name => {
		const classified = RUNTIME_PATHS[name];
		if (!classified) throw new Error(`no classification for ${name}`);
		await activeGoal();

		await drive(classified);

		const stopped = announcements.filter(
			event => event.type === "goal_updated" && (event.goal === null || event.goal.status !== "active"),
		);
		if (STOPS[classified.fate]) {
			// The whole point: the state a session ends up in was announced, so nothing vanishes.
			expect(stopped.length).toBeGreaterThan(0);
			const last = stopped.at(-1);
			if (last?.type !== "goal_updated") throw new Error("expected a goal_updated announcement");
			const expected =
				classified.fate === "pauses" ? "paused" : classified.fate === "completes" ? "complete" : "dropped";
			expect(last.goal?.status).toBe(expected);
			expect(last.goal?.objective).toBe("Ship the release");
		} else {
			expect(stopped).toEqual([]);
		}
	});

	it.each(Object.keys(RUNTIME_PATHS).filter(name => RUNTIME_PATHS[name]?.persists))(
		"%s persists the mode it claims",
		async name => {
			const classified = RUNTIME_PATHS[name];
			if (!classified?.persists) throw new Error(`no persisted mode for ${name}`);
			await activeGoal();

			await drive(classified);

			// The journal is what a reopened session reads, so a fate that is not written there is a
			// fate the next launch cannot see.
			expect(modeChanges.at(-1)).toBe(classified.persists);
		},
	);

	it("erasing a goal announces it before the state is gone", async () => {
		await activeGoal();

		const dropped = await session.goalRuntime.dropGoal();

		expect(dropped?.status).toBe("dropped");
		expect(session.getGoalModeState()).toBeUndefined();
		// One announcement, carrying the dropped goal. The erasure itself emits nothing, so a reader
		// that missed this event would have no other chance to learn the goal existed.
		expect(announcements.length).toBe(1);
		const only = announcements[0];
		if (only?.type !== "goal_updated") throw new Error("expected a goal_updated announcement");
		expect(only.goal?.status).toBe("dropped");
		expect(only.state?.enabled).toBe(false);
	});
});
