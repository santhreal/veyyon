/**
 * A spawn carries the parent's approval rung, including the `/yolo` full bypass.
 *
 * The bypass is the one part of the rung that does NOT live in settings.
 * `AgentSession.setApprovalBypass` is documented as session scoped and never
 * written to settings, so the settings fork in `createSubagentSettings` that
 * carries every other inherited rung cannot see it. Before this guard,
 * `buildSubagentSessionOptions` simply omitted `bypassAllApprovals`, so a child
 * resolved `tools.approvalMode` from settings alone, got the `auto` default, and
 * stopped to ask on cwd-boundary, secret-use, and per-tool prompt calls while the
 * operator's parent session was running everything unasked. The operator saw a
 * permission prompt from a subagent spawned by a session they had put in yolo.
 *
 * The rung must travel in BOTH directions. A parent that is not bypassed must
 * never hand a child a bypass it did not have, which is why the false and
 * omitted cases are asserted here too rather than left implied by the true case.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";

// Spawning a task writes a session under the ACTIVE PROFILE's agent dir, so
// without this the suite creates them inside the developer's real
// `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

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
	id: "subagent-approval-bypass",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit(yieldSuccessEvent({ ok: true }, "approval-bypass"));
	});
}

/** Run one spawn and return the options the executor handed `createAgentSession`. */
async function spawnAndCaptureSessionOptions(bypassAllApprovals?: boolean) {
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
	const result = await runSubprocess({ ...baseOptions, bypassAllApprovals });
	expect(result.exitCode).toBe(0);
	expect(spy).toHaveBeenCalledTimes(1);
	return spy.mock.calls[0]?.[0];
}

describe("a subagent inherits the parent's /yolo approval bypass", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The regression itself. A parent running the bypass spawns a child that also
	 * runs it, so delegating work is not a way to be interrupted by a prompt the
	 * operator already answered for the whole session.
	 */
	it("hands an active bypass to the child session", async () => {
		expect((await spawnAndCaptureSessionOptions(true))?.bypassAllApprovals).toBe(true);
	});

	/**
	 * The inverse, which matters more than it looks. Delegation must never WIDEN
	 * a rung: a parent that prompts spawns a child that prompts. A fix that
	 * hardcoded `true` here would pass the test above and silently ungate every
	 * subagent on a default install, which is the exact defect the executor
	 * removed when it stopped hardcoding `"yolo"` in `createSubagentSettings`.
	 */
	it("does not invent a bypass the parent did not have", async () => {
		expect((await spawnAndCaptureSessionOptions(false))?.bypassAllApprovals).toBe(false);
	});

	/**
	 * A caller that never sets the flag, such as a revived or programmatic spawn,
	 * must be treated as not bypassed rather than inheriting a stale `true`.
	 */
	it("treats an omitted bypass as not bypassed", async () => {
		expect((await spawnAndCaptureSessionOptions(undefined))?.bypassAllApprovals).toBeUndefined();
	});
});
