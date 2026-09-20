/**
 * WHY THIS SUITE EXISTS. Loop mode re-submits the last prompt until the operator
 * stops it or a configured iteration or duration limit elapses. Lifting the driver
 * into a host-agnostic module must preserve that continuation cycle over a real
 * AgentSession, honour the limit bounds, and stop cleanly when instructed.
 *
 * CLASS CLOSED: a loop driver that drops prompts, loops beyond its bound, or
 * hangs waiting for cancellation.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { LoopDriver, type LoopDriverPort } from "@veyyon/coding-agent/loop/driver";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("LoopDriver driving turns and honours limits", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let tempDir: TempDir;
	let driver: LoopDriver;
	let submittedPrompts: string[];
	let warnings: string[];
	let canSubmitFlag: boolean;
	let blockingModeValue: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-driver-test-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});

		submittedPrompts = [];
		warnings = [];
		canSubmitFlag = true;
		blockingModeValue = undefined;

		const port: LoopDriverPort = {
			session,
			blockingMode: () => blockingModeValue,
			isAutoSubmitBlocked: () => session.isStreaming || session.isCompacting || session.hasPostPromptWork,
			canSubmit: () => canSubmitFlag,
			submitPrompt: (prompt: string) => {
				submittedPrompts.push(prompt);
				// Simulate prompt execution by triggering agent_end after prompt processing
				void driver.handleSessionEvent({ type: "agent_end" });
			},
			warn: (message: string) => {
				warnings.push(message);
			},
			changed: () => {},
		};

		driver = new LoopDriver(port);
		driver.subscribeToSession();
	});

	afterEach(async () => {
		driver.stop();
		driver.unsubscribeFromSession();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("re-submits the prompt after each turn ends", async () => {
		vi.useFakeTimers();

		driver.start({ prompt: "run check" });
		expect(driver.enabled).toBe(true);
		expect(driver.prompt).toBe("run check");

		// Initial start schedules the first iteration
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(submittedPrompts).toEqual(["run check"]);

		// End of agent turn triggers the next auto-submit
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(submittedPrompts).toEqual(["run check", "run check"]);
	});

	it("stops on the iteration limit bound and records termination", async () => {
		vi.useFakeTimers();

		driver.start({
			prompt: "bounded task",
			limit: { kind: "iterations", iterations: 2 },
		});

		// First iteration
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(submittedPrompts).toHaveLength(1);

		// Second iteration
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(submittedPrompts).toHaveLength(2);

		// Bound reached: driver must stand down on next iteration
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(submittedPrompts).toHaveLength(2);
		expect(driver.enabled).toBe(false);
		expect(warnings).toContain("Loop limit reached. Loop mode disabled.");
		// Asserts termination: no further timers armed
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops on the duration limit bound and records termination", async () => {
		vi.useFakeTimers();

		driver.start({
			prompt: "timed task",
			limit: { kind: "duration", durationMs: 1500 },
		});

		// First iteration at 800ms (within 1500ms deadline)
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(submittedPrompts).toHaveLength(1);

		// Advance time past the 1500ms deadline (800ms + 800ms = 1600ms >= 1500ms)
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(submittedPrompts).toHaveLength(1);
		expect(driver.enabled).toBe(false);
		expect(warnings).toContain("Loop time limit reached. Loop mode disabled.");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops immediately when operator turns it off and cancels pending submission", async () => {
		vi.useFakeTimers();

		driver.start({ prompt: "manual stop task" });

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(submittedPrompts).toHaveLength(1);

		// Second iteration is armed
		expect(vi.getTimerCount()).toBe(1);

		// Operator turns off loop mode
		driver.stop("Operator stopped loop.");
		expect(driver.enabled).toBe(false);
		expect(driver.prompt).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);

		// Advancing time yields no new submission
		vi.advanceTimersByTime(1600);
		await flushMicrotasks();
		expect(submittedPrompts).toHaveLength(1);
		expect(warnings).toContain("Operator stopped loop.");
	});

	it("refuses to start when another mode is blocking", () => {
		blockingModeValue = "plan";
		driver.start({ prompt: "blocked task" });

		expect(driver.enabled).toBe(false);
		expect(warnings).toContain("Exit plan mode first.");
	});
});
