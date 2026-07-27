/**
 * Contracts: a subagent's delivered result survives the caller's abort.
 *
 * THE RULE. Once a subagent has called `yield`, its work is done and its output belongs to the
 * caller. An abort arriving around that point (the user pressed ^C, the parent turn ended, a batch
 * sibling failed) must NOT turn the finished run into a failure: the exit code stays 0, the run is
 * not reported as aborted, and the yielded data still comes back. An abort with NO yield is the
 * opposite: nothing was delivered, so the run fails and says why. A wall-clock timeout overrides
 * both, because a run that blew its runtime is not one whose result you want to trust.
 *
 * WHERE THE RULE LIVES. `resolveRunVerdict` owns it, called once from `finalizeRunResult` with the
 * turn's facts and what the finalizer extracted from the child's yields. The rules themselves are
 * unit-tested in `run-verdict.test.ts`; this file drives them through the REAL `runSubprocess`, which
 * is the half a unit test cannot prove: that the executor reports the facts the verdict needs.
 *
 * It used to be decided in three places from five sites, one of them written inverted, with the last
 * one to run silently overriding the others. Breaking the upstream `yieldCalled` flag so it could
 * never be true changed nothing observable, which is how that stayed invisible. So these tests assert
 * the OBSERVABLE result of `runSubprocess` rather than any internal flag, which is also why they kept
 * passing across the collapse.
 *
 * WHY THE SUITE EXISTS AT ALL. Nothing combined a delivered yield with a caller abort, in either
 * direction, so the question "I cancelled, does my subagent's finished work survive" was unverified.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import {
	createAssistantStopMessage,
	createMockSession,
	createSessionResult,
	yieldSuccessEvent,
} from "../helpers/subagent-session";

// Spawning writes a session under the ACTIVE PROFILE's agent dir, so without this the suite creates
// sessions inside the developer's real `~/.veyyon/profiles/<profile>/agent/sessions`.
useIsolatedAgentDir();

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: taskAgent,
	task: "do work",
	index: 0,
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("a caller abort after the subagent has yielded", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * ORDER MATTERS, and getting it wrong makes this suite prove nothing.
	 *
	 * The abort fires FIRST, while the turn is still running, and the yield lands after it. Aborting
	 * after the yield is a no-op: a delivered yield resolves the run there and then, and the executor's
	 * caller-signal listener is guarded by `if (!resolved)`, so a later abort never reaches
	 * `requestAbort`. Written that way, every assertion below passes on a build where the abort
	 * branches are broken, which is exactly what happened the first time this was written.
	 *
	 * Abort-then-yield is also the real race: the user cancels, and the subagent's final `yield` is
	 * already in flight. Its work exists, so it must not be thrown away.
	 */
	async function runYieldingThenAborting(id: string, yieldedData: unknown) {
		const controller = new AbortController();
		const session = createMockSession(({ emit, state }) => {
			controller.abort();
			emit(yieldSuccessEvent(yieldedData));
			state.messages.push(createAssistantStopMessage("work done"));
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		return runSubprocess({ ...baseOptions, id, signal: controller.signal });
	}

	it("keeps the run successful", async () => {
		const result = await runYieldingThenAborting("yield-then-abort", { done: true });

		expect(result.exitCode).toBe(0);
	});

	it("does not report the finished run as aborted", async () => {
		const result = await runYieldingThenAborting("yield-then-abort-flag", { done: true });

		expect(result.aborted).toBeFalsy();
		expect(result.abortReason).toBeUndefined();
	});

	/**
	 * The point of keeping the run successful: the caller still gets the work. An exit code of 0 with
	 * an empty output would satisfy the two tests above and lose exactly what they exist to protect.
	 */
	it("still returns the data the subagent yielded", async () => {
		const result = await runYieldingThenAborting("yield-then-abort-output", { finding: "left-pad is fine" });

		expect(result.output).toContain("left-pad is fine");
		expect(result.output).not.toContain("SYSTEM WARNING");
	});
});

describe("a caller abort before the subagent has yielded", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The mirror case, and the reason the flag cannot simply be assumed true. Nothing was delivered, so
	 * the run must fail rather than report success with no result. Without this twin, a mutation that
	 * hardcoded "yielded" would pass the block above.
	 */
	it("fails the run and reports it as aborted", async () => {
		const controller = new AbortController();
		const session = createMockSession(({ state }) => {
			state.messages.push(createAssistantStopMessage("thinking out loud", "aborted"));
			controller.abort();
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "abort-without-yield",
			signal: controller.signal,
		});

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
	});

	/**
	 * THE CASE THAT MAKES THE CUT-SHORT DEMOTION LOAD-BEARING, and the one that was missing.
	 *
	 * `finalizeSubprocessOutput` only fails a yield-less run that produced NO output at all: with some
	 * streamed text it leaves the exit code alone. So a run aborted mid-turn after streaming something
	 * fails because `resolveRunVerdict` refuses to pass a cut-short turn that delivered nothing, not
	 * because the payload logic noticed.
	 *
	 * That matters beyond coverage. The obvious simplification is to let the payload logic own the
	 * outcome alone; done literally, that flips this case from failure to SUCCESS, reporting a cancelled
	 * subagent's partial chatter as a delivered result. This test is what makes that attempt fail
	 * instead of ship, and a mutation run confirms it: dropping that one line fails eight tests.
	 */
	it("fails an aborted run that streamed text but never yielded", async () => {
		const controller = new AbortController();
		const session = createMockSession(({ state }) => {
			state.messages.push(createAssistantStopMessage("I started reading the file and then", "aborted"));
			controller.abort();
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "abort-with-partial-output",
			signal: controller.signal,
		});

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		// The partial work is still surfaced, so the parent does not redo what the child finished.
		expect(result.output).toContain("I started reading the file and then");
	});

	/**
	 * A run cancelled before it started never builds a session at all, and its stderr says so. This is
	 * the early-return guard at the top of `runSubprocess`, kept next to its siblings because all
	 * three answer the same operator question about what a cancellation did to the work.
	 */
	it("refuses before spawning when the signal is already aborted", async () => {
		const createSpy = vi.spyOn(sdkModule, "createAgentSession");
		const controller = new AbortController();
		controller.abort();

		const result = await runSubprocess({
			...baseOptions,
			id: "abort-before-start",
			signal: controller.signal,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Cancelled before start");
		expect(result.output).toBe("");
		expect(createSpy).not.toHaveBeenCalled();
	});
});
