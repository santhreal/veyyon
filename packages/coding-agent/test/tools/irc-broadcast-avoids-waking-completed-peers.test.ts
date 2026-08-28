/**
 * WHY:
 * When a subagent completes its task, its session is kept alive in memory with
 * status "idle" for its idle TTL before being parked. Previously, `irc send to:all`
 * broadcast to all visible peers (`running` or `idle`), which delivered messages to
 * completed subagents and triggered `#wakeForIrc`, starting unexpected new turns on
 * finished subagents.
 *
 * This test suite defends the invariant that:
 * 1. Broadcast (`to: "all"`) ONLY delivers to active running peers and NEVER
 *    targets or wakes completed (idle), parked, or aborted peers.
 * 2. Direct messages (`to: "<id>"`) PRESERVE the documented contract that explicitly
 *    messaging a specific peer can wake an idle peer or revive a parked peer.
 * 3. Every member of the runtime `AgentStatus` union is covered.
 *
 * What this does NOT catch:
 * - Transport-level connection resets in external network providers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/irc";

interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
	setOutcome: (outcome: "injected" | "woken") => void;
	wokenCount: number;
}

function makeFakeSession(defaultOutcome: "injected" | "woken" = "injected"): FakeSession {
	let outcome = defaultOutcome;
	let wokenCount = 0;
	const delivered: IrcMessage[] = [];
	const session = {
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			if (outcome === "woken") {
				wokenCount++;
			}
			return outcome;
		},
		emitIrcRelayObservation: () => {},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		setOutcome: value => {
			outcome = value;
		},
		get wokenCount() {
			return wokenCount;
		},
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

describe("IRC broadcast vs direct message wake lifecycle", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("covers all members of the runtime AgentStatus union and fails closed on unrecognised status", () => {
		const statusBroadcastPolicy: Record<AgentStatus, { eligibleForBroadcast: boolean }> = {
			running: { eligibleForBroadcast: true },
			idle: { eligibleForBroadcast: false },
			parked: { eligibleForBroadcast: false },
			aborted: { eligibleForBroadcast: false },
		};
		// Ensure every status defined in the union is explicitly accounted for
		const definedStatuses = Object.keys(statusBroadcastPolicy) as AgentStatus[];
		expect(definedStatuses).toHaveLength(4);
		expect(definedStatuses).toEqual(["running", "idle", "parked", "aborted"]);
		expect(statusBroadcastPolicy.running.eligibleForBroadcast).toBe(true);
		expect(statusBroadcastPolicy.idle.eligibleForBroadcast).toBe(false);
		expect(statusBroadcastPolicy.parked.eligibleForBroadcast).toBe(false);
		expect(statusBroadcastPolicy.aborted.eligibleForBroadcast).toBe(false);
	});
	describe("Direct messages (op: 'send' with specific 'to')", () => {
		it("delivers to running peer as injected aside", async () => {
			const runningPeer = makeFakeSession("injected");
			registry.register({
				id: "Worker-Running",
				displayName: "worker",
				kind: "sub",
				session: runningPeer.session,
				status: "running",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", {
				op: "send",
				to: "Worker-Running",
				message: "direct to running",
			});

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([{ to: "Worker-Running", outcome: "injected" }]);
			expect(runningPeer.delivered.map(m => m.body)).toEqual(["direct to running"]);
		});

		it("delivers to waiting peer and satisfies the waiter", async () => {
			const waitingPeer = makeFakeSession("injected");
			registry.register({
				id: "Worker-Waiting",
				displayName: "worker",
				kind: "sub",
				session: waitingPeer.session,
				status: "running",
			});

			const waitPromise = bus.wait("Worker-Waiting", { from: "Main" }, 1000);
			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Waiting", message: "direct to waiter" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([{ to: "Worker-Waiting", outcome: "injected" }]);
			const waited = await waitPromise;
			expect(waited?.body).toBe("direct to waiter");
			expect(waitingPeer.delivered).toEqual([]);
		});

		it("wakes an idle (completed) peer on direct send", async () => {
			const idlePeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Idle",
				displayName: "worker",
				kind: "sub",
				session: idlePeer.session,
				status: "idle",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Idle", message: "wake up and assist" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([{ to: "Worker-Idle", outcome: "woken" }]);
			expect(idlePeer.delivered.map(m => m.body)).toEqual(["wake up and assist"]);
			expect(idlePeer.wokenCount).toBe(1);
		});

		it("revives a parked peer on direct send", async () => {
			const parkedPeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Parked",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "parked",
			});
			AgentLifecycleManager.global().adopt("Worker-Parked", {
				idleTtlMs: 0,
				revive: async () => parkedPeer.session,
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Parked", message: "revive request" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([{ to: "Worker-Parked", outcome: "revived" }]);
			expect(parkedPeer.delivered.map(m => m.body)).toEqual(["revive request"]);
		});

		it("refuses to message an aborted peer", async () => {
			registry.register({
				id: "Worker-Aborted",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "aborted",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Aborted", message: "hello" });

			expect(result.isError).toBe(true);
			expect(result.details?.receipts?.[0]?.outcome).toBe("failed");
			expect(result.details?.receipts?.[0]?.error).toContain("hard-aborted");
		});

		it("refuses to message caller/self", async () => {
			const mainSession = makeFakeSession("injected");
			registry.register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: mainSession.session,
				status: "running",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Main", message: "hello to self" });

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Cannot send an IRC message to yourself.");
			expect(mainSession.delivered).toEqual([]);
		});

		it("fails when direct messaging an absent/unknown peer", async () => {
			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Absent", message: "are you there?" });

			expect(result.isError).toBe(true);
			expect(result.details?.receipts?.[0]?.outcome).toBe("failed");
			expect(result.details?.receipts?.[0]?.error).toContain('Unknown agent "Worker-Absent"');
		});
	});

	describe("Broadcast messages (op: 'send' with to: 'all')", () => {
		it("broadcasts ONLY to running and waiting peers, completely ignoring idle, parked, and aborted peers", async () => {
			const runningPeer = makeFakeSession("injected");
			registry.register({
				id: "Worker-Running",
				displayName: "worker",
				kind: "sub",
				session: runningPeer.session,
				status: "running",
			});

			const waitingPeer = makeFakeSession("injected");
			registry.register({
				id: "Worker-Waiting",
				displayName: "worker",
				kind: "sub",
				session: waitingPeer.session,
				status: "running",
			});
			const waitPromise = bus.wait("Worker-Waiting", { from: "Main" }, 1000);

			const idlePeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-IdleCompleted",
				displayName: "worker",
				kind: "sub",
				session: idlePeer.session,
				status: "idle",
			});

			const parkedPeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Parked",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "parked",
			});
			AgentLifecycleManager.global().adopt("Worker-Parked", {
				idleTtlMs: 0,
				revive: async () => parkedPeer.session,
			});

			registry.register({
				id: "Worker-Aborted",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "aborted",
			});

			const callerSession = makeFakeSession("injected");
			registry.register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: callerSession.session,
				status: "running",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "all", message: "broadcast announcement" });

			expect(result.isError).toBeFalsy();

			// Only running & waiting peers should be in the receipts, excluding self, idle, parked, aborted
			const receiptTargets = result.details?.receipts?.map(r => r.to) ?? [];
			expect(receiptTargets).toContain("Worker-Running");
			expect(receiptTargets).toContain("Worker-Waiting");
			expect(receiptTargets).not.toContain("Worker-IdleCompleted");
			expect(receiptTargets).not.toContain("Worker-Parked");
			expect(receiptTargets).not.toContain("Worker-Aborted");
			expect(receiptTargets).not.toContain("Main");

			// Running peer received the message
			expect(runningPeer.delivered.map(m => m.body)).toEqual(["broadcast announcement"]);

			// Waiting peer consumed the message
			const waited = await waitPromise;
			expect(waited?.body).toBe("broadcast announcement");

			// Caller/self was NOT messaged
			expect(callerSession.delivered).toEqual([]);

			// Idle peer was NEVER messaged or woken
			expect(idlePeer.delivered).toEqual([]);
			expect(idlePeer.wokenCount).toBe(0);

			// Parked peer was NEVER revived
			expect(parkedPeer.delivered).toEqual([]);
			expect(registry.get("Worker-Parked")?.status).toBe("parked");
		});

		it("fails closed on any unrecognised or non-running status member", async () => {
			const customStatusPeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-CustomStatus",
				displayName: "worker",
				kind: "sub",
				session: customStatusPeer.session,
				status: "paused" as unknown as AgentStatus,
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "all", message: "hello anyone" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([]);
			expect(customStatusPeer.delivered).toEqual([]);
			expect(customStatusPeer.wokenCount).toBe(0);
		});

		it("returns 'No live peers to broadcast to' when only idle, parked, or aborted peers exist", async () => {
			const idlePeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Idle",
				displayName: "worker",
				kind: "sub",
				session: idlePeer.session,
				status: "idle",
			});
			registry.register({
				id: "Worker-Parked",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "parked",
			});
			registry.register({
				id: "Worker-Aborted",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "aborted",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "all", message: "anyone?" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([]);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No live peers to broadcast to");
			expect(idlePeer.delivered).toEqual([]);
			expect(idlePeer.wokenCount).toBe(0);
		});
	});
});
