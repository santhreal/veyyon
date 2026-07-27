import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { TempDir } from "@veyyon/utils";
import {
	createAssistantStopMessage,
	createAssistantToolCallMessage,
	createMockSessionHandle,
	createSessionResult,
	yieldSuccessEvent,
} from "../helpers/subagent-session";

/**
 * Contracts under test — the soft request budget must degrade gracefully
 * instead of killing scouts into an unreachable state:
 *
 * 1. Crossing 1.5x the budget stops the free-running turn and drives ONE
 *    forced final `yield`, so the run finishes as a normal completion with a
 *    partial report — not as an abort with no output.
 * 2. If the agent still refuses to yield (grace exhausted → hard abort), a
 *    kept-alive agent stays adopted (`idle`), so `irc` can message/resume it.
 * 3. Caller-signal aborts remain terminal, and the irc bus names the aborted
 *    agent precisely instead of claiming it is unknown.
 *
 * The fake session comes from `test/helpers/subagent-session.ts`, which is also what every other
 * `runSubprocess` suite drives, so a member the executor starts reading is stubbed once. The only
 * thing this suite varies is the model api, because it asserts the forced reminder's tool choice and
 * `buildNamedToolChoice` shapes that per api.
 */
const ANTHROPIC_MODEL = { api: "anthropic-messages" } as const;

function createMockSession(onPrompt: Parameters<typeof createMockSessionHandle>[0]) {
	return createMockSessionHandle(onPrompt, { model: ANTHROPIC_MODEL });
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}
// Named "task": bundled scout/sonic budgets are built-in and override the
// `task.softRequestBudget` setting, which these tests pin to a tiny value.
const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess soft request budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-soft-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "subagent.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	function registerRunning(id: string, session: AgentSession) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
	}

	it("a budget stop drives one forced final yield and finishes as a normal completion", async () => {
		const id = "BudgetScout";
		let abortCallsAtReminder: number | undefined;
		const handle = createMockSession(({ promptIndex, emit, pushTurn }) => {
			if (promptIndex === 1) {
				// Free-running exploration: budget 2 → stop threshold 3.
				for (let i = 1; i <= 3; i++) {
					pushTurn(createAssistantStopMessage(`exploring ${i}`, i === 3 ? "aborted" : "stop"));
				}
				return;
			}
			// The forced wrap-up reminder: answer it with a terminal yield.
			abortCallsAtReminder = handle.abortCalls();
			pushTurn(
				createAssistantToolCallMessage("yield", "tool-forced-yield", {
					result: { data: { report: "partial findings" } },
				}),
			);
			emit(yieldSuccessEvent({ report: "partial findings" }, "tool-forced-yield"));
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		// The budget stop aborted the free-running turn exactly once before the
		// wrap-up reminder; the second abort (after the terminal yield) is the
		// normal post-yield terminate.
		expect(abortCallsAtReminder).toBe(1);
		// The wrap-up reminder is the budget-stop variant with a forced tool choice.
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.text).toMatch(/request budget/);
		expect(handle.prompts[1]?.options?.synthetic).toBe(true);
		expect(handle.prompts[1]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		// The forced yield finalizes as a normal completion, not an abort.
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "partial findings" });
		// The agent stays a live, adopted peer.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);
	});

	it("a budget hard-abort keeps the kept-alive agent adopted and messageable via irc", async () => {
		const id = "StubbornScout";
		const handle = createMockSession(({ promptIndex, pushTurn }) => {
			if (promptIndex !== 1) return;
			// Never yields: budget 2 → stop at 3, grace exhausted at 3 + 5 = 8.
			for (let i = 1; i <= 8; i++) {
				pushTurn(createAssistantStopMessage(`burning request ${i}`));
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toMatch(/Soft request budget exceeded/);
		// Resumable stop, not a terminal kill: the ref stays adopted and live.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);

		// The whole point: irc can reach the stopped agent to resume it.
		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume your inventory" });
		expect(receipt.outcome).toBe("woken");
	});

	/**
	 * THE SOFT STOP THAT NEVER ESCALATED, which is the case that has no other witness.
	 *
	 * Budget 2 stops the free-running turn at request 3 and drives ONE forced wrap-up reminder. Here
	 * the child answers that reminder with silence: no yield, and nowhere near the grace ceiling
	 * (3 + 5 = 8 requests), so nothing hard-aborts it and no signal ever fires. The run was still cut
	 * short by the budget, so it must report as a BUDGET abort naming the setting, not as a generic
	 * "exited without calling yield" failure that reads like the agent misbehaved.
	 *
	 * Its sibling above reaches the same verdict through a different door: the grace ceiling fires a
	 * real abort, so the signal alone classifies it. This one has no other door, which is what makes it
	 * the discriminating case, and the child's turns end with a NORMAL stop reason on purpose. A turn
	 * the budget cut mid-flight reports `aborted` and would be classified by that alone; here the
	 * counted turns each finished cleanly and the stop came from the COUNT, so the budget fact is the
	 * only thing that can call the run a cancellation. Written the other way (a final `aborted` turn),
	 * this test passes with the budget rule deleted, which is exactly what a mutation run showed.
	 */
	it("reports a soft budget stop with no yield as a budget abort, not a missing-yield failure", async () => {
		const id = "QuietScout";
		const handle = createMockSession(({ promptIndex, pushTurn }) => {
			if (promptIndex !== 1) return;
			// Budget 2 → stop threshold 3. Three turns that all end NORMALLY, then nothing on the
			// reminder. The normal stop reason is the discriminating part: see the doc above.
			for (let i = 1; i <= 3; i++) {
				pushTurn(createAssistantStopMessage(`exploring ${i}`));
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toMatch(/request budget/);
		expect(result.output).not.toContain("SYSTEM WARNING");
		// The wrap-up reminder was sent and answered with nothing, which is what makes this the soft
		// path rather than the grace-exhausted one.
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.text).toMatch(/request budget/);
	});

	it("a caller-signal abort stays terminal and irc names the aborted agent precisely", async () => {
		const id = "CancelledScout";
		const controller = new AbortController();
		const handle = createMockSession(({ promptIndex, pushTurn }) => {
			if (promptIndex !== 1) return;
			pushTurn(createAssistantStopMessage("working"));
			controller.abort();
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(receipt.error).toMatch(new RegExp(`history://${id}`));
	});
});
