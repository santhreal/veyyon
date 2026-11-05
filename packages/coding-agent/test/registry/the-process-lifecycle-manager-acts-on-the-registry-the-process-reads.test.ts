/**
 * WHY: `AgentLifecycleManager.global()` captured `AgentRegistry.global()` once, when first called. A
 * test that replaced the process registry left the process lifecycle manager terminating, putting
 * agents to sleep and releasing them through the registry it captured, which nothing read any more: `/new` handing a
 * conversation off ended none of the agents it spawned, because the walk for its children ran over
 * an empty registry. The failure showed only when an earlier file in the same process had replaced
 * the registry, so it passed alone and failed in a combined run.
 *
 * The class closed: any process lifecycle operation reaching a registry other than the one the
 * process reads, and a retired manager still acting on the registry it was built for. Not caught:
 * a manager built directly with `new AgentLifecycleManager(registry)`, which is bound to the
 * registry it was given by design.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

function recordingSession(disposed: string[], id: string): AgentSession {
	return {
		abort: async () => {},
		sessionManager: { flush: async () => {} },
		dispose: async () => void disposed.push(id),
	} as unknown as AgentSession;
}

afterEach(() => {
	vi.useRealTimers();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("the process lifecycle manager after the process registry is replaced", () => {
	it("terminates an agent registered in the registry the process now reads", async () => {
		AgentLifecycleManager.global();
		AgentRegistry.resetGlobalForTests();
		const disposed: string[] = [];
		AgentRegistry.global().register({
			id: "0-Worker",
			displayName: "worker",
			kind: "sub",
			status: "idle",
			session: recordingSession(disposed, "0-Worker"),
		});

		await AgentLifecycleManager.global().terminate("0-Worker", "conversation ended");

		expect(disposed).toEqual(["0-Worker"]);
		expect(AgentRegistry.global().get("0-Worker")).toBeUndefined();
	});

	it("no longer puts an agent of the registry it was built for to sleep", async () => {
		vi.useFakeTimers();
		const disposed: string[] = [];
		AgentRegistry.global().register({
			id: "1-Old",
			displayName: "old",
			kind: "sub",
			status: "idle",
			sessionFile: "1-Old.jsonl",
			session: recordingSession(disposed, "1-Old"),
		});
		AgentLifecycleManager.global().adopt("1-Old", { idleTtlMs: 20 });

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.global();
		vi.advanceTimersByTime(40);
		await drainMicrotasks(5);

		expect(disposed).toEqual([]);
	});
});
