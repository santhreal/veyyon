/**
 * WHY:
 * Inter-agent IRC coordination has subtle edge cases across dynamic lifecycle
 * boundaries that existing single-conversation and static tests do not exercise:
 *
 * 1. Cross-scope IrcTool direct message refusal (multi-conversation separation).
 * 2. Concurrent unregistration of a target during broadcast fan-out.
 * 3. Parked agent revival failures (reviver throwing, delivery failing post-revival).
 * 4. Waiter liveness abort races (immediate abort on non-running targets, and
 *    mid-wait aborts when the target or all running peers exit or transition to idle).
 *
 * This test suite defends these specific contracts without duplicating coverage
 * already verified in `irc.test.ts`, `irc-broadcast-avoids-waking-completed-peers.test.ts`,
 * or `irc-conversation-boundary.test.ts`.
 *
 * What this does NOT catch:
 * - Distributed transport failures across multi-process cluster nodes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/irc";
import { makeToolSession } from "../helpers/tool-session";

interface MockSessionState {
	session: AgentSession;
	delivered: IrcMessage[];
	setError: (error: Error | null) => void;
}

function createMockSession(outcome: "injected" | "woken" = "injected"): MockSessionState {
	let nextError: Error | null = null;
	const delivered: IrcMessage[] = [];

	const fake = {
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			delivered.push(msg);
			return outcome;
		},
		emitIrcRelayObservation: () => {},
	};

	return {
		session: fake as unknown as AgentSession,
		delivered,
		setError: err => {
			nextError = err;
		},
	};
}

function createTool(registry: AgentRegistry, agentId: string): IrcTool {
	const session: ToolSession = makeToolSession({
		cwd: "/workspace",
		settings: Settings.isolated({ "irc.timeoutMs": 1000 }),
		agentRegistry: registry,
		getAgentId: () => agentId,
	});
	return new IrcTool(session);
}

describe("IRC Lifecycle and Concurrency Boundaries", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	describe("Cross-scope IrcTool direct message refusal", () => {
		it("refuses direct send to an agent in a different conversation scope", async () => {
			const mockA = createMockSession("injected");
			const mockB = createMockSession("injected");

			registry.register({
				id: "MainA",
				displayName: "main-a",
				kind: "main",
				session: mockA.session,
				scope: "conv-A",
				status: "running",
			});
			registry.register({
				id: "WorkerA",
				displayName: "worker-a",
				kind: "sub",
				parentId: "MainA",
				session: mockA.session,
				status: "running",
			});

			registry.register({
				id: "MainB",
				displayName: "main-b",
				kind: "main",
				session: mockB.session,
				scope: "conv-B",
				status: "running",
			});
			registry.register({
				id: "WorkerB",
				displayName: "worker-b",
				kind: "sub",
				parentId: "MainB",
				session: mockB.session,
				status: "running",
			});

			const toolA = createTool(registry, "WorkerA");
			const result = await toolA.execute("c-cross", {
				op: "send",
				to: "WorkerB",
				message: "cross conversation probe",
			});

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(
				'Agent "WorkerB" cannot be messaged from this conversation. Run `irc list` for the peers of this session.',
			);
			expect(mockB.delivered).toEqual([]);
			expect(bus.log()).toEqual([]);
		});
	});

	describe("Concurrent unregistration during broadcast fan-out", () => {
		it("returns failed receipt for target unregistering mid-broadcast while delivering to remaining peers", async () => {
			const p1 = createMockSession("injected");
			const p2 = createMockSession("injected");
			registry.register({ id: "Worker-1", displayName: "w1", kind: "sub", session: p1.session, status: "running" });
			registry.register({ id: "Worker-2", displayName: "w2", kind: "sub", session: p2.session, status: "running" });

			// Unregister Worker-2 while delivering Worker-1
			p1.session.deliverIrcMessage = async (msg: IrcMessage) => {
				p1.delivered.push(msg);
				registry.unregister("Worker-2");
				return "injected";
			};

			const tool = createTool(registry, "Main");
			const result = await tool.execute("call-broadcast", {
				op: "send",
				to: "all",
				message: "broadcast announcement",
			});

			expect(result.isError).toBeFalsy();
			const receipts = result.details?.receipts ?? [];
			expect(receipts).toHaveLength(2);
			const r1 = receipts.find(r => r.to === "Worker-1");
			const r2 = receipts.find(r => r.to === "Worker-2");
			expect(r1?.outcome).toBe("injected");
			expect(r2?.outcome).toBe("failed");
			expect(r2?.error).toContain('Unknown agent "Worker-2"');
			expect(p1.delivered.map(m => m.body)).toEqual(["broadcast announcement"]);
		});
	});

	describe("Parked revival failure modes", () => {
		it("reports failed receipt when reviver throws an exception and leaves target parked", async () => {
			registry.register({
				id: "Parked-Faulty",
				displayName: "faulty",
				kind: "sub",
				session: null,
				status: "parked",
			});
			lifecycle.adopt("Parked-Faulty", {
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("Corrupt session transcript file");
				},
			});

			const tool = createTool(registry, "Main");
			const result = await tool.execute("call-revive", { op: "send", to: "Parked-Faulty", message: "wake" });

			expect(result.isError).toBe(true);
			expect(result.details?.receipts?.[0]?.outcome).toBe("failed");
			expect(result.details?.receipts?.[0]?.error).toContain("Corrupt session transcript file");
			expect(registry.get("Parked-Faulty")?.status).toBe("parked");
		});

		it("reports failed receipt and buffers mailbox mail when post-revival delivery throws", async () => {
			const mock = createMockSession("woken");
			mock.setError(new Error("Socket closed immediately after revival"));

			registry.register({ id: "Parked-Drop", displayName: "drop", kind: "sub", session: null, status: "parked" });
			lifecycle.adopt("Parked-Drop", {
				idleTtlMs: 0,
				revive: async () => mock.session,
			});

			const tool = createTool(registry, "Main");
			const result = await tool.execute("call-revive", {
				op: "send",
				to: "Parked-Drop",
				message: "wake and execute",
			});

			expect(result.isError).toBe(true);
			expect(result.details?.receipts?.[0]?.outcome).toBe("failed");
			expect(result.details?.receipts?.[0]?.error).toContain("Socket closed immediately after revival");
			expect(bus.unreadCount("Parked-Drop")).toBe(1);
			expect(bus.inbox("Parked-Drop").map(m => m.body)).toEqual(["wake and execute"]);
		});
	});

	describe("Waiter liveness races", () => {
		it("aborts immediately when wait target is already not running", async () => {
			const mock = createMockSession("injected");
			registry.register({ id: "Main", displayName: "main", kind: "main", session: mock.session, status: "running" });
			registry.register({
				id: "Worker-Idle",
				displayName: "worker",
				kind: "sub",
				session: mock.session,
				status: "idle",
			});

			const tool = createTool(registry, "Main");
			const result = await tool.execute("call-wait", { op: "wait", from: "Worker-Idle" });

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('IRC wait aborted: agent "Worker-Idle" is not running');
		});

		it("aborts active wait when specific target transitions from running to idle during the wait", async () => {
			const mock = createMockSession("injected");
			registry.register({ id: "Main", displayName: "main", kind: "main", session: mock.session, status: "running" });
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: mock.session,
				status: "running",
			});

			const tool = createTool(registry, "Main");
			const waitPromise = tool.execute("call-wait", { op: "wait", from: "Worker" });

			// Target completes turn and transitions to idle
			registry.setStatus("Worker", "idle");

			const result = await waitPromise;
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('IRC wait aborted: agent "Worker" is not running');
		});

		it("aborts wildcard wait when all visible peers transition out of running", async () => {
			const mock = createMockSession("injected");
			registry.register({ id: "Main", displayName: "main", kind: "main", session: mock.session, status: "running" });
			registry.register({
				id: "Worker-1",
				displayName: "w1",
				kind: "sub",
				session: mock.session,
				status: "running",
			});
			registry.register({
				id: "Worker-2",
				displayName: "w2",
				kind: "sub",
				session: mock.session,
				status: "running",
			});

			const tool = createTool(registry, "Main");
			const waitPromise = tool.execute("call-wait", { op: "wait" });

			// Transition both running workers away
			registry.setStatus("Worker-1", "idle");
			registry.setStatus("Worker-2", "parked");

			const result = await waitPromise;
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("IRC wait aborted: no running peers remain");
		});
	});
});
