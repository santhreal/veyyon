/**
 * WHY: `/goal show` answered `Status: paused (paused)`. The report appended `" (paused)"` whenever
 * goal mode was not driving, and every path that stops the mode writes a status that already says
 * so -- an operator interrupt, `/goal pause` and a session resume all write `paused`, and a
 * completion writes `complete`. So the suffix either repeated the word in front of it or
 * contradicted it: a finished goal read `complete (paused)`, and a dropped one `dropped (paused)`.
 *
 * THE CLASS: the status field states the goal's status once, and names the mode only where the
 * status does not already carry it. The sweep is over `GOAL_STATUSES`, the one spelling of
 * `GoalStatus` -- the type is derived from that tuple, so there is no way to add a status without
 * adding it here -- crossed with both mode states, and `MODE_IS_NEWS` is keyed by the union, so a
 * sixth status cannot compile until someone classifies it. The report is read out of the real
 * controller through `/goal show`, not out of the private method that formats it.
 *
 * The objective is the report's one free-text field -- an operator types it, or a model writes it
 * through the goal tool -- and it reached a `Text` component with nothing done to it, so the cells
 * below drive each control-character class that has a distinct effect on a terminal through the
 * same path.
 *
 * WHAT THIS DOES NOT CATCH: the goal tool's own card, whose badge carries the raw status by design
 * and is pinned by `a-goal-card-draws-the-same-panel-its-renderer-drew.test.ts`; and which status
 * the runtime should write for a given transition, which
 * `only-an-operator-interrupt-pauses-a-goal.test.ts` owns. It proves the two fields, not the
 * ordering of the five lines around them, and it says nothing about the length of an objective,
 * which this report deliberately does not bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GOAL_STATUSES, type GoalModeState, type GoalStatus } from "@veyyon/coding-agent/goals/state";
import {
	GoalModeController,
	type GoalModeControllerContext,
	type GoalModeHost,
} from "@veyyon/coding-agent/modes/terminal/controllers/goal-mode-controller";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";

/**
 * Whether goal mode being off is news for a goal in this status: it is exactly when the mode could
 * still be driving the goal, and it is not when the status is the record of the mode having
 * stopped. Keyed by the union, so a new status is a type error in this file first.
 */
const MODE_IS_NEWS: Record<GoalStatus, boolean> = {
	active: true,
	"budget-limited": true,
	paused: false,
	complete: false,
	dropped: false,
};

function goalWith(status: GoalStatus): GoalModeState {
	return {
		enabled: status === "active" || status === "budget-limited",
		mode: "active",
		goal: {
			id: "goal-1",
			objective: "Ship the release with signed artifacts",
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			turnsCompleted: 0,
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

/** A context member this path must never reach. Reaching one is a wiring change, not a pass. */
function unreached(member: string): () => never {
	return () => {
		throw new Error(`/goal show reached ${member}`);
	};
}

const IDLE_HOST: GoalModeHost = {
	isAutoSubmitBlocked: () => false,
	hasPendingSubmission: () => false,
	hasPendingVisibleUserSubmission: () => false,
	isPlanModeActive: () => false,
	withProgress: async (_label, work) => await work(),
};

/**
 * The report `/goal show` prints, driven through the real controller. Only the session is stood in
 * for: the goal record is the report's input, and the states below are the ones the runtime writes.
 */
async function reportFor(state: GoalModeState | undefined): Promise<string> {
	const statuses: string[] = [];
	const session = {
		settings: Settings.isolated({ "goal.enabled": true, "goal.modelBudgetsEnabled": false }),
		getGoalModeState: () => state,
	} as unknown as GoalModeControllerContext["session"];
	const context = {
		editor: undefined,
		loopModeEnabled: false,
		onInputCallback: undefined,
		session,
		sessionManager: undefined,
		showError: unreached("showError"),
		showHookConfirm: unreached("showHookConfirm"),
		showHookEditor: unreached("showHookEditor"),
		showHookSelector: unreached("showHookSelector"),
		showStatus: (message: string) => {
			statuses.push(message);
		},
		showWarning: unreached("showWarning"),
		startPendingSubmission: unreached("startPendingSubmission"),
		statusLine: undefined,
		ui: undefined,
		vibeModeEnabled: false,
	} as unknown as GoalModeControllerContext;

	await new GoalModeController(context, IDLE_HOST).handleCommand("show");
	expect(statuses).toHaveLength(1);
	return statuses[0];
}

function statusFieldOf(report: string): string {
	const line = report.split("\n").find(candidate => candidate.startsWith("Status: "));
	if (line === undefined) throw new Error(`report has no status line:\n${report}`);
	return line;
}

function objectiveFieldOf(report: string): string {
	const line = report.split("\n").find(candidate => candidate.startsWith("Objective: "));
	if (line === undefined) throw new Error(`report has no objective line:\n${report}`);
	return line;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("a goal report states the goal's status once", () => {
	// The sweep is only as complete as this set, and this set is the type. Exact equality rather
	// than a count, so a new status names itself in the failure.
	it("sweeps every status the union declares", () => {
		expect([...GOAL_STATUSES]).toEqual(["active", "paused", "budget-limited", "complete", "dropped"]);
		expect(Object.keys(MODE_IS_NEWS).sort()).toEqual([...GOAL_STATUSES].sort());
	});

	for (const status of GOAL_STATUSES) {
		for (const modeEnabled of [true, false]) {
			const suffix = !modeEnabled && MODE_IS_NEWS[status] ? " (mode off)" : "";
			it(`reads "Status: ${status}${suffix}" for a ${status} goal with the mode ${modeEnabled ? "on" : "off"}`, async () => {
				const state = { ...goalWith(status), enabled: modeEnabled };
				expect(statusFieldOf(await reportFor(state))).toBe(`Status: ${status}${suffix}`);
			});

			it(`never repeats the word ${status} in the field with the mode ${modeEnabled ? "on" : "off"}`, async () => {
				const state = { ...goalWith(status), enabled: modeEnabled };
				const field = statusFieldOf(await reportFor(state));
				expect(field.split(status).length - 1).toBe(1);
				// The general shape of the defect, whatever word it lands on: `x (x)`.
				expect(field).not.toMatch(/([\w-]+)\b[^()]*\(\1\)/);
			});
		}
	}

	// A settled goal is never described as paused, whichever settled status it holds. The suffix
	// called a completed goal paused, which is the half of the defect that was not a duplicate.
	for (const status of GOAL_STATUSES.filter(candidate => !MODE_IS_NEWS[candidate] && candidate !== "paused")) {
		it(`never calls a ${status} goal paused`, async () => {
			expect(statusFieldOf(await reportFor({ ...goalWith(status), enabled: false }))).not.toContain("paused");
		});
	}

	it("says no goal is set when the session has none", async () => {
		expect(await reportFor(undefined)).toBe("No goal set.");
	});

	/**
	 * Every class of byte an objective can carry that a terminal reads as an instruction rather
	 * than as text, and what the report must do with it. A field of the report is one line, so a
	 * newline is in this table too: it would put half an objective where a field name belongs.
	 */
	const HOSTILE = [
		{ what: "an SGR escape sequence", raw: "Ship \u001b[31mthe release\u001b[0m" },
		{ what: "a cursor-move escape", raw: "Ship \u001b[2Athe release" },
		{ what: "an 8-bit CSI sequence", raw: "Ship \u009b2Athe release" },
		{ what: "a tab", raw: "Ship\tthe release" },
		{ what: "a newline", raw: "Ship\nthe release" },
		{ what: "a carriage return", raw: "Ship\rthe release" },
		{ what: "a bare C0 control", raw: "Ship \u0001the release" },
		{ what: "a bare C1 control", raw: "Ship \u0085the release" },
	] as const;

	for (const { what, raw } of HOSTILE) {
		it(`renders an objective carrying ${what} as its words alone`, async () => {
			const state = goalWith("active");
			state.goal.objective = raw;
			const report = await reportFor(state);
			// Exact: the words survive in order, and nothing a terminal acts on is left between
			// them. This is sanitization, not redaction -- the reader still reads the objective.
			expect(objectiveFieldOf(report)).toBe("Objective: Ship the release");
			// A field is one line, and the report is its five fields. An unsanitized newline
			// makes six, which is the case no per-field assertion can see.
			expect(report.split("\n")).toHaveLength(5);
		});
	}
});

describe("the report the runtime's own pause produces", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-goal-report-");
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
			settings: Settings.isolated({
				"compaction.enabled": false,
				"goal.enabled": true,
				"goal.modelBudgetsEnabled": false,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	// The capture that started this: a goal set, the turn interrupted, `/goal show`. The state is
	// the runtime's own, so this fails if a pause stops writing `paused` as much as if the field
	// starts restating it.
	it("reads Status: paused after an operator interrupt, once", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release with signed artifacts" });
		await session.goalRuntime.pauseGoal();
		const state = session.getGoalModeState();
		expect(state?.goal.status).toBe("paused");
		expect(state?.enabled).toBe(false);

		expect(statusFieldOf(await reportFor(state))).toBe("Status: paused");
	});

	it("reads Status: active with the mode driving", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release with signed artifacts" });
		const state = session.getGoalModeState();
		expect(state?.enabled).toBe(true);

		expect(statusFieldOf(await reportFor(state))).toBe("Status: active");
	});
});
