/**
 * WHY: goal mode must drive autonomous continuation turns only when nothing else
 * holds the session — no conflicting mode, no operator composer draft or pending
 * images, no in-flight turn or compaction, no pending submission, and an active
 * goal with a valid prompt.
 *
 * When the session is temporarily busy (e.g. compaction or post-turn maintenance),
 * the continuation timer must busy-wait by re-arming until idle, but give up
 * after GOAL_CONTINUATION_BUSY_WAIT_MS with an operator warning rather than spinning
 * indefinitely.
 *
 * When provider errors kill consecutive goal turns, the driver must tolerate
 * up to GOAL_FAILED_TURN_LIMIT - 1 faults, standing down on the limit with an
 * operator warning, while a single successful turn resets the counter.
 *
 * The class this closes: autonomous continuation leaking turns when another subsystem
 * owns the session, hanging forever in post-turn maintenance busy waits, or spinning
 * endlessly across hard provider outages.
 *
 * What it does not catch: bugs in individual tool implementations or provider-specific
 * protocol failures during prompt generation.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	GOAL_CONTINUATION_BLOCKS,
	GOAL_CONTINUATION_BUSY_WAIT_MS,
	GOAL_CONTINUATION_DELAY_MS,
	GOAL_FAILED_TURN_LIMIT,
	GoalDriver,
	type GoalDriverPort,
} from "@veyyon/coding-agent/goals/driver";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

class FakeGoalDriverPort implements GoalDriverPort {
	session: AgentSession;
	currentBlockingMode: "plan" | "vibe" | "loop" | undefined = undefined;
	unsentInput = false;
	autoSubmitBlocked = false;
	pendingSubmission = false;
	pendingVisibleUserSubmission = false;
	allowSubmit = true;
	continuations: string[] = [];
	warnings: string[] = [];
	changeCount = 0;

	constructor(session: AgentSession) {
		this.session = session;
	}

	blockingMode(): "plan" | "vibe" | "loop" | undefined {
		return this.currentBlockingMode;
	}

	hasUnsentInput(): boolean {
		return this.unsentInput;
	}

	isAutoSubmitBlocked(): boolean {
		return this.autoSubmitBlocked;
	}

	hasPendingSubmission(): boolean {
		return this.pendingSubmission;
	}

	hasPendingVisibleUserSubmission(): boolean {
		return this.pendingVisibleUserSubmission;
	}

	canSubmit(): boolean {
		return this.allowSubmit;
	}

	submitContinuation(prompt: string): void {
		this.continuations.push(prompt);
	}

	warn(message: string): void {
		this.warnings.push(message);
	}

	changed(): void {
		this.changeCount += 1;
	}

	reset(): void {
		this.currentBlockingMode = undefined;
		this.unsentInput = false;
		this.autoSubmitBlocked = false;
		this.pendingSubmission = false;
		this.pendingVisibleUserSubmission = false;
		this.allowSubmit = true;
		this.continuations = [];
		this.warnings = [];
		this.changeCount = 0;
	}
}

describe("a goal drives a turn only when nothing else holds the session", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let port: FakeGoalDriverPort;
	let driver: GoalDriver;

	beforeEach(async () => {
		vi.useFakeTimers();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-driver-test-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": true,
		});

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});

		port = new FakeGoalDriverPort(session);
		driver = new GoalDriver(port);
	});

	afterEach(async () => {
		driver.cancelContinuation();
		driver.unsubscribeFromSession();
		await session.dispose();
		tempDir.removeSync();
		resetSettingsForTest();
		vi.useRealTimers();
	});

	test("every member of GoalContinuationBlock individually stops continuation", () => {
		// Sweep the entire variant space of GoalContinuationBlock at runtime
		for (const blockReason of GOAL_CONTINUATION_BLOCKS) {
			port.reset();
			driver.enabled = true;
			driver.paused = false;
			driver.resetContinuationSuppression();
			session.settings.set("goal.continuationModes", ["interactive"]);
			session.setGoalModeState({
				enabled: true,
				mode: "active",
				goal: {
					id: "test-goal",
					objective: "Drive autonomously",
					status: "active",
					tokensUsed: 100,
					timeUsedSeconds: 10,
					turnsCompleted: 1,
					createdAt: 1000,
					updatedAt: 1000,
				},
			});
			const promptSpy = vi.spyOn(session.goalRuntime, "buildContinuationPrompt").mockReturnValue("Continue working");

			switch (blockReason) {
				case "loop-mode":
					port.currentBlockingMode = "loop";
					break;
				case "plan-mode":
					port.currentBlockingMode = "plan";
					break;
				case "vibe-mode":
					port.currentBlockingMode = "vibe";
					break;
				case "no-input-callback":
					port.allowSubmit = false;
					break;
				case "continuation-mode-off":
					session.settings.set("goal.continuationModes", [] as unknown as readonly ["interactive"]);
					break;
				case "goal-mode-off":
					driver.enabled = false;
					break;
				case "suppressed":
					driver.noteVisibleUserTurnStarted();
					break;
				case "busy":
					port.autoSubmitBlocked = true;
					break;
				case "submission-pending":
					port.pendingSubmission = true;
					break;
				case "draft-in-composer":
					port.unsentInput = true;
					break;
				case "goal-not-active":
					session.setGoalModeState({
						enabled: false,
						mode: "active",
						goal: {
							id: "test-goal",
							objective: "Drive autonomously",
							status: "paused",
							tokensUsed: 100,
							timeUsedSeconds: 10,
							turnsCompleted: 1,
							createdAt: 1000,
							updatedAt: 1000,
						},
					});
					break;
				case "no-prompt":
					promptSpy.mockReturnValue(undefined);
					break;
				default: {
					const _exhaustive: never = blockReason;
					throw new Error(`Unhandled block reason: ${_exhaustive}`);
				}
			}

			if (blockReason === "busy") {
				expect(driver.continuationBlock("fire")).toBe("busy");
			} else if (blockReason !== "no-prompt") {
				expect(driver.continuationBlock("arm")).toBe(blockReason);
			}

			driver.scheduleContinuation();
			vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS);

			expect(port.continuations).toHaveLength(0);
			promptSpy.mockRestore();
		}
	});

	test("continuation fires when nothing blocks it", () => {
		port.reset();
		driver.enabled = true;
		driver.paused = false;
		driver.resetContinuationSuppression();
		session.settings.set("goal.continuationModes", ["interactive"]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "test-goal",
				objective: "Drive autonomously",
				status: "active",
				tokensUsed: 100,
				timeUsedSeconds: 10,
				turnsCompleted: 1,
				createdAt: 1000,
				updatedAt: 1000,
			},
		});
		const promptSpy = vi.spyOn(session.goalRuntime, "buildContinuationPrompt").mockReturnValue("Continue working");

		expect(driver.continuationBlock("arm")).toBeUndefined();
		expect(driver.continuationBlock("fire")).toBeUndefined();

		driver.scheduleContinuation();
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS - 1);
		expect(port.continuations).toHaveLength(0);

		vi.advanceTimersByTime(1);
		expect(port.continuations).toEqual(["Continue working"]);

		promptSpy.mockRestore();
	});

	test("busy wait re-arms and gives up after the deadline with operator warning", () => {
		port.reset();
		driver.enabled = true;
		driver.paused = false;
		driver.resetContinuationSuppression();
		session.settings.set("goal.continuationModes", ["interactive"]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "test-goal",
				objective: "Drive autonomously",
				status: "active",
				tokensUsed: 100,
				timeUsedSeconds: 10,
				turnsCompleted: 1,
				createdAt: 1000,
				updatedAt: 1000,
			},
		});
		const promptSpy = vi.spyOn(session.goalRuntime, "buildContinuationPrompt").mockReturnValue("Continue working");

		port.autoSubmitBlocked = true;
		driver.scheduleContinuation();

		// At 800ms: fires, discovers busy, re-arms. No warnings, no submissions yet.
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS);
		expect(port.continuations).toHaveLength(0);
		expect(port.warnings).toHaveLength(0);

		// Advance 10 delay periods: still busy, still re-arming.
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS * 10);
		expect(port.continuations).toHaveLength(0);
		expect(port.warnings).toHaveLength(0);

		// Advance past GOAL_CONTINUATION_BUSY_WAIT_MS
		vi.advanceTimersByTime(GOAL_CONTINUATION_BUSY_WAIT_MS);
		expect(port.warnings).toEqual([
			"Goal mode stopped waiting for the session to go idle. Send a message to resume it.",
		]);
		expect(port.continuations).toHaveLength(0);

		// Further time yields no more attempts or duplicate warnings
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS * 5);
		expect(port.warnings).toHaveLength(1);
		expect(port.continuations).toHaveLength(0);

		promptSpy.mockRestore();
	});

	test("three consecutive provider-killed turns stand the goal down and the fourth does not fire", async () => {
		port.reset();
		driver.enabled = true;
		driver.paused = false;
		driver.resetContinuationSuppression();
		session.settings.set("goal.continuationModes", ["interactive"]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "test-goal",
				objective: "Drive autonomously",
				status: "active",
				tokensUsed: 100,
				timeUsedSeconds: 10,
				turnsCompleted: 1,
				createdAt: 1000,
				updatedAt: 1000,
			},
		});
		const promptSpy = vi.spyOn(session.goalRuntime, "buildContinuationPrompt").mockReturnValue("Continue working");

		const erroredEndEvent: Extract<AgentSessionEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Provider transport fault" }],
					stopReason: "error",
				} as AssistantMessage,
			],
		};

		// Turn 1 fails
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(1);
		expect(port.warnings).toHaveLength(0);
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS);
		expect(port.continuations).toHaveLength(1);
		port.continuations = [];

		// Turn 2 fails
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(2);
		expect(port.warnings).toHaveLength(0);
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS);
		expect(port.continuations).toHaveLength(1);
		port.continuations = [];

		// Turn 3 fails: reaches GOAL_FAILED_TURN_LIMIT
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(GOAL_FAILED_TURN_LIMIT);
		expect(port.warnings).toEqual(["Goal mode stopped driving after 3 failed turns. Send a message to resume it."]);

		// Turn 4 does not fire
		vi.advanceTimersByTime(GOAL_CONTINUATION_DELAY_MS * 2);
		expect(port.continuations).toHaveLength(0);
		expect(driver.continuationBlock("arm")).toBe("suppressed");

		promptSpy.mockRestore();
	});

	test("a recovered turn resets the failed turn count", async () => {
		port.reset();
		driver.enabled = true;
		driver.paused = false;
		driver.resetContinuationSuppression();
		session.settings.set("goal.continuationModes", ["interactive"]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "test-goal",
				objective: "Drive autonomously",
				status: "active",
				tokensUsed: 100,
				timeUsedSeconds: 10,
				turnsCompleted: 1,
				createdAt: 1000,
				updatedAt: 1000,
			},
		});
		const promptSpy = vi.spyOn(session.goalRuntime, "buildContinuationPrompt").mockReturnValue("Continue working");

		const erroredEndEvent: Extract<AgentSessionEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Provider transport fault" }],
					stopReason: "error",
				} as AssistantMessage,
			],
		};

		const successfulEndEvent: Extract<AgentSessionEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Work completed" }],
					stopReason: "stop",
				} as AssistantMessage,
			],
		};

		// Turn 1 fails
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(1);

		// Turn 2 fails
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(2);

		// Turn 3 succeeds: resets count
		await driver.handleSessionEvent(successfulEndEvent);
		expect(driver.failedTurns).toBe(0);

		// Next failures start from 1 again
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(1);
		expect(port.warnings).toHaveLength(0);

		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(2);
		expect(port.warnings).toHaveLength(0);

		// Third consecutive failure after recovery reaches limit
		await driver.handleSessionEvent(erroredEndEvent);
		expect(driver.failedTurns).toBe(GOAL_FAILED_TURN_LIMIT);
		expect(port.warnings).toEqual(["Goal mode stopped driving after 3 failed turns. Send a message to resume it."]);

		promptSpy.mockRestore();
	});
});
