import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import {
	createAssistantStopMessage,
	createAssistantToolCallMessage,
	createMockSession,
	createMockSessionHandle,
	createSessionResult,
	yieldRejectedEvent,
	yieldSuccessEvent,
} from "../helpers/subagent-session";

// Spawning a task writes a session (and, for worktree runs, a checkout) under the
// ACTIVE PROFILE's agent dir, so without this the suite creates them inside the
// developer's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

/**
 * Contract: when `task.maxRuntimeMs` is set, a subagent whose inference call
 * never resolves (provider stream hang the watchdog couldn't catch) MUST be
 * aborted within ~maxRuntimeMs and surface a clear "runtime limit exceeded"
 * reason — not a generic "Cancelled by caller" — so on-call engineers don't
 * mistake it for a user cancellation.
 *
 * Without this defense, the executor's `await session.waitForIdle()` waits
 * indefinitely (see session 019e2b4d-fa25-7000-a725-955278e9b293, subagent 7,
 * which stayed silent for ~2 hours).
 *
 * A stalled child is `hangUntilAbort` on the shared fake in
 * `test/helpers/subagent-session.ts`: `prompt` and `waitForIdle` wait for something to abort the
 * session, so only the executor's own guards can end these runs. The soft-budget cases below drive
 * their events from `waitForIdle` rather than from `prompt`, because they assert how many aborts had
 * happened by the time a yield's `tool_execution_end` landed, and that ordering lives in that window.
 */
function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

describe("runSubprocess wall clock (task.maxRuntimeMs)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-walltime",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};

	it("aborts a stalled subagent and surfaces a runtime-limit reason", async () => {
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 50 });
		const handle = createMockSessionHandle(() => {}, { hangUntilAbort: true });
		mockCreateAgentSession(handle.session);

		const startedAt = Date.now();
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-timeout",
			settings,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=50");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		// Sanity: must finish in roughly the configured window (allow generous slack
		// for CI; the contract is "doesn't hang for hours", not "exactly 50 ms").
		expect(elapsedMs).toBeLessThan(10_000);
	});

	it("does not abort early when the runtime budget is unlimited", async () => {
		// The child answers immediately with a yield, so nothing hangs; the point is
		// only that NO timeout fires when maxRuntimeMs=0.
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 0 });
		const session = createMockSession(({ emit }) => {
			emit(yieldSuccessEvent({ ok: true }, "tool-fast"));
		});
		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-no-limit",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
	});

	it("aborts before prompting when the timer fires during session setup", async () => {
		// Delay createAgentSession longer than maxRuntimeMs so the wall-clock
		// timer fires while the executor is still doing async setup, well before
		// it ever calls session.prompt(). The fix must observe abortSignal
		// immediately before prompting and return the runtime-limit result.
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 30 });
		const handle = createMockSessionHandle(() => {}, { hangUntilAbort: true });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
			return createSessionResult(handle.session);
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-setup-timeout",
			settings,
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=30");
		// The whole point: we never reached session.prompt(), because the abort
		// was observed before issuing the model call.
		expect(handle.prompts).toHaveLength(0);
	});

	it("a late successful yield does not flip a timed-out run to success", async () => {
		// A hung subagent emits a successful `yield` event during teardown (after
		// the timer has already aborted). Without the fix, `hasYield=true` would
		// make finalizeSubprocessOutput zero the exit code and `wasAborted`
		// would resolve to false — silently masking the runtime-limit breach.
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 30 });
		const handle = createMockSessionHandle(() => {}, {
			hangUntilAbort: true,
			// Emitted from inside `abort`, which is the only way to land in the teardown window.
			onAbort: ({ emit }) => emit(yieldSuccessEvent({ lateButLanded: true }, "tool-late-yield")),
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-late-yield",
			settings,
		});

		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		// Yield data is preserved for inspection — the regression was only in
		// the exit status / abort flag, not in the captured payload.
		expect(result.extractedToolData?.yield).toBeDefined();
	});

	it("commits a yield tool call before the soft request budget aborts the turn", async () => {
		const settings = Settings.isolated({ "subagent.softRequestBudget": 1 });
		let abortCountBeforeYieldExecutionEnd: number | undefined;
		const handle = createMockSessionHandle(() => {}, {
			onWaitForIdle: ({ idleIndex, emit, pushTurn }) => {
				if (idleIndex !== 1) return;
				pushTurn(createAssistantStopMessage("finishing the task"));
				pushTurn(
					createAssistantToolCallMessage("yield", "tool-yield-budget", {
						result: { data: { finished: "unvalidated" } },
					}),
				);
				abortCountBeforeYieldExecutionEnd = handle.abortCalls();
				emit(yieldSuccessEvent({ finished: "validated" }, "tool-yield-budget"));
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-yield",
			settings,
		});

		expect(abortCountBeforeYieldExecutionEnd).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.requests).toBe(2);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ finished: "validated" });
	});

	it("does not finalize rejected yield arguments after crossing the soft request budget", async () => {
		const settings = Settings.isolated({ "subagent.softRequestBudget": 1 });
		let abortCountBeforeRejectedYieldExecutionEnd: number | undefined;
		let abortCountBeforeValidYieldExecutionEnd: number | undefined;
		const handle = createMockSessionHandle(() => {}, {
			onWaitForIdle: ({ idleIndex, emit, pushTurn }) => {
				if (idleIndex === 1) {
					pushTurn(createAssistantStopMessage("finishing the task"));
					pushTurn(
						createAssistantToolCallMessage("yield", "tool-yield-rejected", {
							result: { data: { finished: "rejected-before-validation" } },
						}),
					);
					abortCountBeforeRejectedYieldExecutionEnd = handle.abortCalls();
					emit(yieldRejectedEvent({ finished: "rejected-before-validation" }, "tool-yield-rejected"));
					return;
				}
				if (idleIndex === 2) {
					pushTurn(
						createAssistantToolCallMessage("yield", "tool-yield-valid", {
							result: { data: { finished: "unvalidated-later" } },
						}),
					);
					abortCountBeforeValidYieldExecutionEnd = handle.abortCalls();
					emit(yieldSuccessEvent({ finished: "validated-later" }, "tool-yield-valid"));
				}
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-rejected-yield",
			settings,
		});

		expect(abortCountBeforeRejectedYieldExecutionEnd).toBe(0);
		expect(abortCountBeforeValidYieldExecutionEnd).toBe(0);
		expect(handle.prompts.length).toBeGreaterThanOrEqual(2);
		expect(handle.prompts[1]?.options?.synthetic).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.requests).toBe(3);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ finished: "validated-later" });
		expect(result.extractedToolData?.yield).toEqual([
			{
				data: { finished: "validated-later" },
				status: "success",
				error: undefined,
				type: undefined,
				useLastTurn: undefined,
				schemaOverridden: undefined,
			},
		]);
	});

	it("resumes the hard budget guard after an incremental yield commits", async () => {
		const settings = Settings.isolated({ "subagent.softRequestBudget": 1 });
		let abortCountBeforeYieldExecutionEnd: number | undefined;
		let abortCountAfterFollowingTurn: number | undefined;
		const handle = createMockSessionHandle(() => {}, {
			onWaitForIdle: ({ idleIndex, emit, pushTurn }) => {
				if (idleIndex !== 1) return;
				pushTurn(createAssistantStopMessage("still working"));
				pushTurn(
					createAssistantToolCallMessage("yield", "tool-yield-incremental", {
						type: ["findings"],
						result: { data: { id: "saved" } },
					}),
				);
				abortCountBeforeYieldExecutionEnd = handle.abortCalls();
				// An INCREMENTAL yield: it saves a section and the run continues, so the hard budget
				// guard has to come back on for the turns that follow.
				emit(yieldSuccessEvent({ id: "saved" }, "tool-yield-incremental", { type: ["findings"] }));
				pushTurn(createAssistantStopMessage("continuing after the saved section"));
				abortCountAfterFollowingTurn = handle.abortCalls();
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-incremental-yield",
			settings,
		});

		expect(abortCountBeforeYieldExecutionEnd).toBe(0);
		expect(abortCountAfterFollowingTurn).toBe(1);
		expect(result.requests).toBe(3);
		expect(result.extractedToolData?.yield).toEqual([
			{
				data: { id: "saved" },
				status: "success",
				error: undefined,
				type: ["findings"],
				useLastTurn: undefined,
				schemaOverridden: undefined,
			},
		]);
	});

	it("propagates per-turn context tokens onto the SingleResult", async () => {
		// Async task consumers (index.ts) copy `singleResult.contextTokens` and
		// `singleResult.contextWindow` onto AgentProgress. This test pins the
		// upstream contract: when an assistant message_end carries totalTokens,
		// executor must surface it on SingleResult.contextTokens.
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 0 });
		const session = createMockSession(({ emit, pushTurn }) => {
			pushTurn(createAssistantStopMessage("ok", "stop", { input: 100, output: 50, totalTokens: 12345 }));
			emit(yieldSuccessEvent({ ok: true }, "tool-ok"));
		});
		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-context-tokens",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.contextTokens).toBe(12345);
		// contextWindow is only populated when the model registry resolves one;
		// here we mock createAgentSession so it stays undefined. The async-task
		// consumer's assignment is a straight copy, so undefined is acceptable.
		expect(result.contextWindow).toBeUndefined();
	});
});
