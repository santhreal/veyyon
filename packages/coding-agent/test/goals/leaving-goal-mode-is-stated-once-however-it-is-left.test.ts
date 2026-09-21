/**
 * WHY: lifting goal mode into the shared driver dropped the line the terminal printed when a goal
 * finished. The goal ended, the status line cleared, and nothing said so; the capture scene that
 * waits for "Goal mode completed." was the only thing that noticed.
 *
 * THE CLASS: a way out of goal mode that states nothing, or states itself twice. Every exit runs
 * through `GoalDriver.exit`, so the notice is asserted there, once per reason, swept from
 * `GOAL_EXIT_REASONS` rather than from a list written here: a fourth way out turns this red until
 * it is given a line of its own. The double-statement half is the drop path, which exits from the
 * command and again from the `goal_updated` event that command raises.
 *
 * WHAT IT DOES NOT CATCH: how a host draws the line it is handed — the terminal's status register
 * and the window's goal card — and whether a goal that ends on its own reaches `exit` at all,
 * which the driver's session-event suite owns.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	GOAL_EXIT_REASONS,
	GoalDriver,
	type GoalDriverPort,
	type GoalExitReason,
	goalExitNotice,
} from "@veyyon/coding-agent/goals/driver";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** The host register, reduced to what it is handed. */
class RecordingPort implements GoalDriverPort {
	session: AgentSession;
	warnings: string[] = [];
	notices: string[] = [];

	constructor(session: AgentSession) {
		this.session = session;
	}

	blockingMode(): "plan" | "vibe" | "loop" | undefined {
		return undefined;
	}

	hasUnsentInput(): boolean {
		return false;
	}

	isAutoSubmitBlocked(): boolean {
		return false;
	}

	hasPendingSubmission(): boolean {
		return false;
	}

	hasPendingVisibleUserSubmission(): boolean {
		return false;
	}

	canSubmit(): boolean {
		return true;
	}

	submitContinuation(): void {}

	warn(message: string): void {
		this.warnings.push(message);
	}

	status(message: string): void {
		this.notices.push(message);
	}

	changed(): void {}
}

describe("leaving goal mode is stated once, however it is left", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let port: RecordingPort;
	let driver: GoalDriver;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-exit-notice-test-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true }),
			modelRegistry,
		});

		port = new RecordingPort(session);
		driver = new GoalDriver(port);
	});

	afterEach(async () => {
		driver.cancelContinuation();
		await session.dispose();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	/** A goal the driver is driving, as the session records it. */
	function drivingGoal(): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-under-test",
				objective: "Finish the work",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				turnsCompleted: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		driver.enabled = true;
		driver.paused = false;
	}

	test("every way out states its own line, and no two ways share one", async () => {
		const stated = new Map<GoalExitReason, string>();
		for (const reason of GOAL_EXIT_REASONS) {
			port.notices = [];
			drivingGoal();
			await driver.exit({ reason, paused: reason === "paused" });
			expect(port.notices).toEqual([goalExitNotice({ reason, paused: reason === "paused" })]);
			stated.set(reason, port.notices[0] ?? "");
		}
		expect(stated.get("completed")).toBe("Goal mode completed.");
		expect(new Set(stated.values()).size).toBe(GOAL_EXIT_REASONS.length);
		for (const line of stated.values()) expect(line.length).toBeGreaterThan(0);
	});

	test("an exit with no reason states that the mode is off", async () => {
		drivingGoal();
		await driver.exit();
		expect(port.notices).toEqual(["Goal mode disabled."]);
	});

	test("a pause states the paused line whether or not the reason names it", async () => {
		drivingGoal();
		await driver.exit({ paused: true });
		expect(port.notices).toEqual(["Goal mode paused."]);
	});

	test("the second exit of one goal states nothing", async () => {
		drivingGoal();
		await driver.exit({ reason: "dropped" });
		await driver.exit({ reason: "dropped" });
		expect(port.notices).toEqual(["Goal dropped."]);
	});

	test("a paused goal that is then dropped states both, in that order", async () => {
		drivingGoal();
		await driver.exit({ paused: true, reason: "paused" });
		await driver.exit({ reason: "dropped" });
		expect(port.notices).toEqual(["Goal mode paused.", "Goal dropped."]);
	});

	test("an exit with nothing driving states nothing", async () => {
		await driver.exit({ reason: "completed" });
		expect(port.notices).toEqual([]);
	});
});
