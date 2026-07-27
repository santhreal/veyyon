import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { formatResultOutputFallback } from "@veyyon/coding-agent/task";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import {
	createAssistantStopMessage,
	createMockSessionHandle,
	createSessionResult,
	type MockSessionHandle,
	yieldSuccessEvent,
} from "../helpers/subagent-session";

// Spawning a task writes a session (and, for worktree runs, a checkout) under the
// ACTIVE PROFILE's agent dir, so without this the suite creates them inside the
// developer's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

/**
 * Contract: runaway-subagent guards.
 *
 * 1. The executor counts assistant requests (message_end events) and surfaces
 *    the count on `SingleResult.requests`.
 * 2. Crossing the soft request budget injects exactly ONE steering notice
 *    (on by default) into the child session asking it to wrap up; crossing
 *    1.5x the budget force-stops the free-running turn and drives a forced
 *    final yield. A child that still yields nothing is reported as a budget
 *    abort with the precise reason.
 * 3. A cancelled/aborted child that produced no completed output salvages its
 *    last assistant text into a `[cancelled after N req, …]` summary instead
 *    of the parent seeing "(no output)" and redoing the work.
 */

interface FakeSessionConfig {
	/** Events delivered to the executor's subscriber during the child's turn. */
	events?: AgentSessionEvent[];
	/** When true, prompt/waitForIdle hang until a guard aborts the session. */
	hang?: boolean;
	/**
	 * The message `getLastAssistantMessage` answers with, which is the salvage source.
	 *
	 * Deliberately separate from {@link FakeSessionConfig.events}: the `message_end` events below are
	 * raw events that the executor counts, and the salvage read is a different question (what the
	 * child last said), so a suite sets the two independently.
	 */
	lastAssistantMessage?: AssistantMessage;
}

/**
 * One counted assistant turn.
 *
 * The default usage is nonzero because the executor reports a run's tokens and the salvage summary
 * quotes them; a turn with no usage would make "N tok" unverifiable.
 */
function assistantMessageEnd(text: string, usage?: Partial<AssistantMessage["usage"]>): AgentSessionEvent {
	return {
		type: "message_end",
		message: createAssistantStopMessage(text, "stop", usage ?? { input: 10, output: 5, totalTokens: 15 }),
	} as unknown as AgentSessionEvent;
}

function yieldToolEnd(): AgentSessionEvent {
	return yieldSuccessEvent({ ok: true });
}

/**
 * The shared fake, configured for this suite's shape.
 *
 * The session itself comes from `test/helpers/subagent-session.ts`; only the "replay a fixed event
 * list" arrangement is local, because these tests describe a child by the turns it burns rather than
 * by reacting to what the executor asked it.
 */
function createFakeSession(config: FakeSessionConfig = {}): MockSessionHandle {
	return createMockSessionHandle(
		({ emit, state }) => {
			if (config.lastAssistantMessage) state.messages.push(config.lastAssistantMessage);
			for (const event of config.events ?? []) emit(event);
		},
		{ hangUntilAbort: config.hang },
	);
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

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
	id: "subagent-guards",
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("runSubprocess request guards", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts assistant requests into SingleResult.requests", async () => {
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 0 });
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("step one"),
				assistantMessageEnd("step two"),
				assistantMessageEnd("step three"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-requests", settings });

		expect(result.aborted).toBe(false);
		expect(result.requests).toBe(3);
		// Well under any budget: no steer injected.
		expect(handle.steerCalls.length).toBe(0);
	});

	it("injects exactly one steering notice when the soft budget is crossed", async () => {
		// Budget 4: steer fires at request 4 and must not repeat at request 5
		// (still below the 1.5x hard stop of 6).
		const settings = Settings.isolated({
			"subagent.maxRuntimeMs": 0,
			"subagent.softRequestBudget": 4,
			"subagent.softRequestBudgetNotice": true,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer", settings });

		expect(result.requests).toBe(5);
		expect(result.aborted).toBe(false);
		expect(handle.steerCalls.length).toBe(1);
		expect(handle.steerCalls[0].content).toContain("[budget notice]");
		expect(handle.steerCalls[0].content).toContain("4 requests");
		expect(handle.steerCalls[0].options?.deliverAs).toBe("steer");
	});

	it("injects the steering notice by default when the soft request budget is crossed", async () => {
		// Budget 4 is crossed at request 4; the notice defaults ON, so exactly
		// one steer lands without task.softRequestBudgetNotice being set.
		const settings = Settings.isolated({
			"subagent.maxRuntimeMs": 0,
			"subagent.softRequestBudget": 4,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer-default", settings });

		expect(result.requests).toBe(5);
		expect(result.aborted).toBe(false);
		expect(handle.steerCalls.length).toBe(1);
		expect(handle.steerCalls[0].content).toContain("[budget notice]");
	});

	it("still force-stops at 1.5x the soft budget when budget notices are disabled", async () => {
		// Budget 2: notice would normally fire at 2, but the force-stop at 3 must
		// remain active even with the notice disabled.
		const settings = Settings.isolated({
			"subagent.maxRuntimeMs": 0,
			"subagent.softRequestBudget": 2,
			"subagent.softRequestBudgetNotice": false,
		});
		const handle = createFakeSession({
			hang: true,
			events: [
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-hard-stop-notice-disabled", settings });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("request budget exceeded");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		expect(handle.steerCalls).toEqual([]);
	});

	it("aborts the run gracefully at 1.5x the soft budget with notices enabled", async () => {
		// Budget 2: with notices enabled, steer at 2 and hard stop at 3. The
		// session hangs so only the budget abort can release it.
		const settings = Settings.isolated({
			"subagent.maxRuntimeMs": 0,
			"subagent.softRequestBudget": 2,
			"subagent.softRequestBudgetNotice": true,
		});
		const handle = createFakeSession({
			hang: true,
			events: [
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-hard-stop", settings });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("request budget exceeded");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		expect(handle.steerCalls.length).toBe(1);
	});

	it("salvages the last assistant text for an aborted child with no completed output", async () => {
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 50 });
		const handle = createFakeSession({
			hang: true,
			events: [
				// One completed assistant turn with usage but no text content:
				// counts a request and tokens without producing output chunks.
				assistantMessageEnd("", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }),
			],
			lastAssistantMessage: createAssistantStopMessage("Reading   the\n\tconfig loader before patching", "aborted"),
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage", settings });

		expect(result.aborted).toBe(true);
		expect(result.requests).toBe(1);
		expect(result.output).toContain("cancelled after 1 req");
		expect(result.output).toContain("150 tok");
		expect(result.output).toContain("last activity:");
		// Whitespace is flattened so the snippet stays a single line.
		expect(result.output).toContain("Reading the config loader before patching");
		expect(result.output).not.toContain("\n");
	});

	it("clips oversized salvage snippets", async () => {
		const settings = Settings.isolated({ "subagent.maxRuntimeMs": 50 });
		const longText = `start-marker ${"x".repeat(700)}`;
		const handle = createFakeSession({
			hang: true,
			lastAssistantMessage: createAssistantStopMessage(longText, "aborted"),
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage-clip", settings });

		expect(result.aborted).toBe(true);
		expect(result.output).toContain("start-marker");
		expect(result.output).toContain("…");
		expect(result.output).not.toContain(longText);
		expect(result.output.length).toBeLessThan(700);
	});

	it("formats the (no output) fallback with the request count", () => {
		expect(formatResultOutputFallback({ output: "", stderr: "", requests: 7 })).toBe("(no output) after 7 req");
		expect(formatResultOutputFallback({ output: "  ", stderr: "", requests: 0 })).toBe("(no output)");
		expect(formatResultOutputFallback({ output: "real output", stderr: "", requests: 7 })).toBe("real output");
		expect(formatResultOutputFallback({ output: "", stderr: "boom", requests: 7 })).toBe("boom");
	});
});
