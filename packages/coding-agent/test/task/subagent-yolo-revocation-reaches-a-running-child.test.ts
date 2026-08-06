/**
 * `/yolo off` must reach a subagent that is ALREADY RUNNING.
 *
 * THE DEFECT. The bypass the task tool hands a child was a snapshot: it read
 * `this.session.isApprovalBypassed()` once while building executor options, the
 * executor forwarded that boolean into `createAgentSession`, and the child
 * session stored it in its own `#approvalBypassActive`. Nothing linked the two
 * afterwards. So an operator who ran `/yolo`, spawned a long subagent, then
 * thought better of it and ran `/yolo off` got a partial revocation: the parent
 * went back to prompting, and the child kept running every bash, edit and write
 * unasked until it finished. The status line only ever reflected the parent, so
 * there was nothing on screen to say the revocation had not landed.
 *
 * THE FIX AND ITS DIRECTION. The child now also carries `parentApprovalBypassed`,
 * a closure over the live parent, and `isApprovalBypassed()` consults it on every
 * check. It can only NARROW. The child's own snapshot is still the gate that runs
 * first, so a parent with a bypass can never hand one to a child that was built
 * without it — that widening direction is asserted here rather than left implied,
 * because a fix that simply returned the parent's value would pass the revocation
 * test above and silently ungate every subagent.
 *
 * HOW IT IS DRIVEN. The parent and the child are both real `AgentSession`s, and
 * the two values the child is built from come out of a real `runSubprocess` call
 * rather than being written by hand: the spy captures the exact
 * `CreateAgentSessionOptions` the executor produced, which is the same object
 * `createAgentSession` spreads into the child session's config. Only the
 * network-bound session construction inside the executor is faked.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";

// A spawn writes a session file under the active profile's agent dir; without
// this the suite writes into the developer's real `~/.veyyon`.
useIsolatedAgentDir();

const model = getBundledModel("openai", "gpt-4o-mini");
if (!model) throw new Error("expected bundled gpt-4o-mini");

const agentDefinition: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const live: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (live.length > 0) await live.pop()?.dispose();
});

/** A real session, tracked so `afterEach` disposes it. */
function realSession(config: { bypassAllApprovals?: boolean; parentApprovalBypassed?: () => boolean }): AgentSession {
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		modelRegistry: {} as ModelRegistry,
		...config,
	});
	live.push(session);
	return session;
}

/**
 * Spawn through the real executor and build the child the way `createAgentSession`
 * does, from the options the executor actually emitted.
 *
 * `ownBypass` is what `task/index.ts` reads off the parent at spawn time; passing
 * it separately is what lets the widening control hand the child a `false`
 * snapshot while the parent's probe answers `true`.
 */
async function spawnChildOf(parent: AgentSession, ownBypass = parent.isApprovalBypassed()): Promise<AgentSession> {
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
		createSessionResult(
			createMockSession(({ emit }) => {
				emit(yieldSuccessEvent({ ok: true }, "yolo-revocation"));
			}),
		),
	);
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: agentDefinition,
		task: "do work",
		index: 0,
		id: "subagent-yolo-revocation",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		// The two lines under test in `task/index.ts`: a snapshot, plus a probe
		// that reads the same parent live.
		bypassAllApprovals: ownBypass,
		parentApprovalBypassed: () => parent.isApprovalBypassed(),
	});
	expect(result.exitCode).toBe(0);
	const forwarded = spy.mock.calls[0]?.[0];
	if (!forwarded) throw new Error("the executor never called createAgentSession");
	spy.mockRestore();

	return realSession({
		bypassAllApprovals: forwarded.bypassAllApprovals,
		parentApprovalBypassed: forwarded.parentApprovalBypassed,
	});
}

describe("a parent revoking /yolo while a subagent is running", () => {
	/**
	 * The regression. One child instance, asked twice: bypassing while the parent
	 * is, and prompting again the moment the parent stops. The second assertion is
	 * the whole fix, and it is deliberately made against the SAME session object
	 * the first one passed on, because a child rebuilt between the two checks
	 * would pass on the spawn-time snapshot alone.
	 */
	it("stops the child bypassing, on the same child instance", async () => {
		const parent = realSession({ bypassAllApprovals: true });
		expect(parent.isApprovalBypassed()).toBe(true);

		const child = await spawnChildOf(parent);
		expect(child.isApprovalBypassed()).toBe(true);

		parent.setApprovalBypass(false);

		expect(parent.isApprovalBypassed()).toBe(false);
		expect(child.isApprovalBypassed()).toBe(false);
	});

	/**
	 * And it re-arms. Revocation is not a latch: an operator who turns the bypass
	 * back on while the same subagent is still running gets it back, so the child
	 * tracks the parent rather than being knocked out by the first `off`.
	 */
	it("hands the bypass back when the parent turns it on again", async () => {
		const parent = realSession({ bypassAllApprovals: true });
		const child = await spawnChildOf(parent);

		parent.setApprovalBypass(false);
		expect(child.isApprovalBypassed()).toBe(false);
		parent.setApprovalBypass(true);

		expect(child.isApprovalBypassed()).toBe(true);
	});

	/**
	 * The direction control. The probe may only narrow. A child spawned without a
	 * bypass of its own stays without one for its whole run, however loudly the
	 * parent's probe answers, so consulting the parent cannot ungate a subagent
	 * that was never meant to be ungated.
	 */
	it("never gives a bypass to a child that was spawned without one", async () => {
		const parent = realSession({ bypassAllApprovals: true });

		const child = await spawnChildOf(parent, false);

		expect(parent.isApprovalBypassed()).toBe(true);
		expect(child.isApprovalBypassed()).toBe(false);

		// Still false after the parent toggles, rather than merely un-set at build.
		parent.setApprovalBypass(false);
		parent.setApprovalBypass(true);
		expect(child.isApprovalBypassed()).toBe(false);
	});

	/**
	 * A root session has no parent to consult, and an absent probe must read as
	 * "nothing above me is narrowing this", not as "off". Getting that default
	 * backwards would turn `/yolo` into a no-op in the main session, which is the
	 * one place the operator can see it on the status line.
	 */
	it("leaves a root session's own bypass alone", async () => {
		const root = realSession({});
		expect(root.isApprovalBypassed()).toBe(false);

		root.setApprovalBypass(true);
		expect(root.isApprovalBypassed()).toBe(true);

		root.setApprovalBypass(false);
		expect(root.isApprovalBypassed()).toBe(false);
	});
});
