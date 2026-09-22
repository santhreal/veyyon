/**
 * WHY:
 * Goal mode on the terminal runs autonomous continuation turns, tracks budget
 * usage, and allows the operator to pause, resume, or drop the goal. The native
 * desktop window reaches this functionality over the JSON wire protocol using
 * SetGoal and ControlGoal actions, which `gui-host/goal-bridge.ts` drives, and
 * receives Goal snapshot section updates.
 *
 * WHAT THIS SUITE DEFENDS:
 * 1. Setting a goal via SetGoal starts driving turns and emits the Goal snapshot
 *    section carrying the objective and driving: true.
 * 2. Pausing the goal via ControlGoal stops driving and emits status: "paused", driving: false.
 * 3. Resuming the goal via ControlGoal restarts driving and emits status: "active", driving: true.
 * 4. Dropping the goal stops driving and emits goal: null to remove it from the desktop store.
 * 5. A window opening a session that already has a goal receives the Goal
 *    section in its snapshot.
 * 6. Controlling a goal on a session with no goal fails with a BackendError
 *    naming what is missing and what to do instead.
 * 7. Controlling a dropped goal fails with an error naming what to do instead.
 * 8. Running /goal commands from the window's palette (set, pause, resume, show, drop)
 *    drives the goal, and /goal show re-emits the Goal section.
 * 9. Every member of the GoalStatus union is reachable or explicitly excused by
 *    exact equality.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { goalView } from "../../src/gui-host/goal-view";
import { ALL_GOAL_STATUSES, type GoalStatus, type GoalView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

interface ActiveSessionSection {
	revision: number;
	value: { id: string; mode: string };
}

interface GoalSnapshotPayload {
	session: string;
	goal: GoalView | null;
}

describe("a goal set from the window drives turns and states itself", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-goal-test-"));
		const authStorage = await isolatedAuthStorage(tempDir);
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		// Consume greeting and initial capabilities frames
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function openSession(): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		return session;
	}

	test("setting a goal emits a Goal section carrying the objective and driving: true", async () => {
		const session = await openSession();

		const setReply = await client.request(2, {
			SetGoal: {
				session,
				objective: "Ship the desktop parity work",
				token_budget: null,
			},
		});

		expect(setReply.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const goalSnapshots = snapshotSections<GoalSnapshotPayload>(setReply.frames, "Goal");
		expect(goalSnapshots.length).toBeGreaterThan(0);
		const lastGoal = goalSnapshots.at(-1)!;
		expect(lastGoal.session).toBe(session);
		expect(lastGoal.goal).not.toBeNull();
		expect(lastGoal.goal?.objective).toBe("Ship the desktop parity work");
		expect(lastGoal.goal?.status).toBe("active");
		expect(lastGoal.goal?.driving).toBe(true);
		expect(lastGoal.goal?.stood_down).toBeNull();
	});

	test("pausing stops driving and emits the new paused status", async () => {
		const session = await openSession();

		await client.request(2, {
			SetGoal: {
				session,
				objective: "Refactor session state",
				token_budget: null,
			},
		});

		const pauseReply = await client.request(3, {
			ControlGoal: {
				session,
				op: "pause",
			},
		});

		expect(pauseReply.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const pausedSnapshots = snapshotSections<GoalSnapshotPayload>(pauseReply.frames, "Goal");
		expect(pausedSnapshots.length).toBeGreaterThan(0);
		const pausedGoal = pausedSnapshots.at(-1)!;
		expect(pausedGoal.session).toBe(session);
		expect(pausedGoal.goal?.status).toBe("paused");
		expect(pausedGoal.goal?.driving).toBe(false);

		// Resuming restarts driving
		const resumeReply = await client.request(4, {
			ControlGoal: {
				session,
				op: "resume",
			},
		});

		expect(resumeReply.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		const resumedSnapshots = snapshotSections<GoalSnapshotPayload>(resumeReply.frames, "Goal");
		expect(resumedSnapshots.length).toBeGreaterThan(0);
		const resumedGoal = resumedSnapshots.at(-1)!;
		expect(resumedGoal.session).toBe(session);
		expect(resumedGoal.goal?.status).toBe("active");
		expect(resumedGoal.goal?.driving).toBe(true);
	});

	test("dropping the goal stops driving and emits goal: null", async () => {
		const session = await openSession();

		await client.request(2, {
			SetGoal: {
				session,
				objective: "Temporary goal to drop",
				token_budget: null,
			},
		});

		const dropReply = await client.request(3, {
			ControlGoal: {
				session,
				op: "drop",
			},
		});

		expect(dropReply.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const droppedSnapshots = snapshotSections<GoalSnapshotPayload>(dropReply.frames, "Goal");
		expect(droppedSnapshots.length).toBeGreaterThan(0);
		const droppedGoal = droppedSnapshots.at(-1)!;
		expect(droppedGoal.session).toBe(session);
		expect(droppedGoal.goal).toBeNull();
	});

	test("the Goal section is present in the initial snapshot for a session that already has a goal", async () => {
		const session = await openSession();

		await client.request(2, {
			SetGoal: {
				session,
				objective: "Initial snapshot persistence goal",
				token_budget: null,
			},
		});

		// Connect a second client representing a new window attaching to the host and opening the session
		const secondClient = await TestSocketClient.connect(server!.endpoint);
		try {
			await secondClient.nextFrame(); // Greeting
			await secondClient.nextFrame(); // Capabilities
			const openReply = await secondClient.request(1, { OpenSession: { session } });
			expect(openReply.outcome).toEqual({ RequestSucceeded: { request: 1 } });

			const initialGoals = snapshotSections<GoalSnapshotPayload>(openReply.frames, "Goal");
			expect(initialGoals.length).toBeGreaterThan(0);
			const initialGoal = initialGoals.at(-1)!;
			expect(initialGoal.session).toBe(session);
			expect(initialGoal.goal?.objective).toBe("Initial snapshot persistence goal");
			expect(initialGoal.goal?.driving).toBe(true);
			expect(initialGoal.goal?.status).toBe("active");
		} finally {
			secondClient.destroy();
		}
	});

	test("controlling a goal on a session with no goal fails naming what is missing and what to do", async () => {
		const session = await openSession();

		const reply = await client.request(2, {
			ControlGoal: {
				session,
				op: "pause",
			},
		});

		expect(reply.outcome).toMatchObject({
			RequestFailed: {
				request: 2,
				error: {
					scope: "Session",
					code: "NO_GOAL",
					message: expect.stringMatching(/no goal.*set a goal/i),
					retryable: false,
				},
			},
		});
	});

	test("resuming a dropped goal fails with an error naming the gap and what to do", async () => {
		const session = await openSession();

		await client.request(2, {
			SetGoal: {
				session,
				objective: "Goal to be dropped",
				token_budget: null,
			},
		});

		await client.request(3, {
			ControlGoal: {
				session,
				op: "drop",
			},
		});

		const resumeReply = await client.request(4, {
			ControlGoal: {
				session,
				op: "resume",
			},
		});

		expect(resumeReply.outcome).toMatchObject({
			RequestFailed: {
				request: 4,
				error: {
					scope: "Session",
					code: "NO_GOAL",
					message: expect.stringMatching(/no goal.*set a goal/i),
					retryable: false,
				},
			},
		});
	});

	test("/goal commands run from the window's palette and /goal show re-emits Goal section", async () => {
		const session = await openSession();

		// /goal <objective> sets the goal
		const setCmd = await client.request(2, {
			RunCommand: {
				session,
				text: "/goal Build the desktop interface",
			},
		});
		expect(setCmd.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const setSnapshots = snapshotSections<GoalSnapshotPayload>(setCmd.frames, "Goal");
		expect(setSnapshots.at(-1)?.goal?.objective).toBe("Build the desktop interface");
		expect(setSnapshots.at(-1)?.goal?.driving).toBe(true);

		// /goal show re-emits the Goal section
		const showCmd = await client.request(3, {
			RunCommand: {
				session,
				text: "/goal show",
			},
		});
		expect(showCmd.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const showSnapshots = snapshotSections<GoalSnapshotPayload>(showCmd.frames, "Goal");
		expect(showSnapshots.length).toBeGreaterThan(0);
		expect(showSnapshots.at(-1)?.goal?.objective).toBe("Build the desktop interface");

		// /goal pause pauses the goal
		const pauseCmd = await client.request(4, {
			RunCommand: {
				session,
				text: "/goal pause",
			},
		});
		expect(pauseCmd.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		const pauseSnapshots = snapshotSections<GoalSnapshotPayload>(pauseCmd.frames, "Goal");
		expect(pauseSnapshots.at(-1)?.goal?.status).toBe("paused");
		expect(pauseSnapshots.at(-1)?.goal?.driving).toBe(false);

		// /goal resume resumes the goal
		const resumeCmd = await client.request(5, {
			RunCommand: {
				session,
				text: "/goal resume",
			},
		});
		expect(resumeCmd.outcome).toEqual({ RequestSucceeded: { request: 5 } });
		const resumeSnapshots = snapshotSections<GoalSnapshotPayload>(resumeCmd.frames, "Goal");
		expect(resumeSnapshots.at(-1)?.goal?.status).toBe("active");
		expect(resumeSnapshots.at(-1)?.goal?.driving).toBe(true);

		// /goal drop drops the goal
		const dropCmd = await client.request(6, {
			RunCommand: {
				session,
				text: "/goal drop",
			},
		});
		expect(dropCmd.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		const dropSnapshots = snapshotSections<GoalSnapshotPayload>(dropCmd.frames, "Goal");
		expect(dropSnapshots.at(-1)?.goal).toBeNull();
	});

	test("every member of the GoalStatus union is reachable or explicitly excused by exact equality", async () => {
		const reached = new Set<GoalStatus>();
		const session = await openSession();

		// 1. "active": set a goal
		const setReply = await client.request(2, {
			SetGoal: { session, objective: "Status test goal", token_budget: null },
		});
		const activeGoal = snapshotSections<GoalSnapshotPayload>(setReply.frames, "Goal").at(-1)?.goal;
		if (activeGoal) reached.add(activeGoal.status);

		// 2. "paused": pause the goal
		const pauseReply = await client.request(3, {
			ControlGoal: { session, op: "pause" },
		});
		const pausedGoal = snapshotSections<GoalSnapshotPayload>(pauseReply.frames, "Goal").at(-1)?.goal;
		if (pausedGoal) reached.add(pausedGoal.status);

		// 3. "dropped", "complete", and "budget_limited":
		// On the desktop protocol, dropping a goal clears it from session state so a goal: null
		// snapshot is emitted to remove it from the desktop store. "complete" is set autonomously
		// by the model via the complete goal tool, and "budget_limited" is set autonomously by
		// GoalRuntime accounting during a turn when token budget is exhausted.
		const EXCUSED_AUTONOMOUS_STATUSES: GoalStatus[] = ["budget_limited", "complete", "dropped"];

		// Pinned by exact equality: every member of ALL_GOAL_STATUSES is accounted for
		const accounted = [...reached, ...EXCUSED_AUTONOMOUS_STATUSES].sort();
		expect(accounted).toEqual([...ALL_GOAL_STATUSES].sort());

		// Verify goalView projects budget-limited, complete, and dropped properly
		const mockSessionBudget = {
			getGoalModeState: () => ({
				enabled: false,
				mode: "active" as const,
				goal: {
					id: "g-1",
					objective: "Budget test",
					status: "budget-limited" as const,
					tokensUsed: 150,
					tokenBudget: 100,
					timeUsedSeconds: 10,
					turnsCompleted: 1,
					createdAt: 1000,
					updatedAt: 2000,
				},
			}),
		};
		const projectedBudget = goalView(mockSessionBudget as never);
		expect(projectedBudget?.status).toBe("budget_limited");

		const mockSessionComplete = {
			getGoalModeState: () => ({
				enabled: false,
				mode: "active" as const,
				goal: {
					id: "g-2",
					objective: "Complete test",
					status: "complete" as const,
					tokensUsed: 50,
					tokenBudget: 100,
					timeUsedSeconds: 20,
					turnsCompleted: 2,
					createdAt: 1000,
					updatedAt: 3000,
				},
			}),
		};
		const projectedComplete = goalView(mockSessionComplete as never);
		expect(projectedComplete?.status).toBe("complete");

		const mockSessionDropped = {
			getGoalModeState: () => ({
				enabled: false,
				mode: "active" as const,
				goal: {
					id: "g-3",
					objective: "Dropped test",
					status: "dropped" as const,
					tokensUsed: 10,
					tokenBudget: 100,
					timeUsedSeconds: 5,
					turnsCompleted: 1,
					createdAt: 1000,
					updatedAt: 4000,
				},
			}),
		};
		const projectedDropped = goalView(mockSessionDropped as never);
		expect(projectedDropped?.status).toBe("dropped");
	});

	test("goal mode declines to drive while loop mode is active", async () => {
		const session = await openSession();

		// Enter loop mode first
		const enterLoop = await client.request(2, {
			SetSessionMode: { session, mode: "loop" },
		});
		expect(enterLoop.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		// Setting a goal while loop mode is active is refused with MODE_CONFLICT
		const setReply = (
			await client.request(3, {
				SetGoal: { session, objective: "Autonomous work", token_budget: null },
			})
		).outcome as { RequestFailed?: { error: { code: string; message: string } } };
		expect(setReply.RequestFailed?.error.code).toBe("MODE_CONFLICT");
		expect(setReply.RequestFailed?.error.message).toBe("Exit loop mode first.");

		// Leaving loop mode clears blocking
		const leaveLoop = await client.request(4, {
			SetSessionMode: { session, mode: "none" },
		});
		expect(leaveLoop.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		// Setting a goal now succeeds
		const setSuccess = await client.request(5, {
			SetGoal: { session, objective: "Autonomous work", token_budget: null },
		});
		expect(setSuccess.outcome).toEqual({ RequestSucceeded: { request: 5 } });
		const activeGoal = snapshotSections<GoalSnapshotPayload>(setSuccess.frames, "Goal").at(-1)?.goal;
		expect(activeGoal?.driving).toBe(true);

		// With active goal, entering loop mode is also refused
		const loopRefused = (
			await client.request(6, {
				SetSessionMode: { session, mode: "loop" },
			})
		).outcome as { RequestFailed?: { error: { code: string; message: string } } };
		expect(loopRefused.RequestFailed?.error.code).toBe("MODE_CONFLICT");
		expect(loopRefused.RequestFailed?.error.message).toBe("The session has an active goal; exit it before looping");
	});
});
