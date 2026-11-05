/**
 * WHY:
 * When an agent completes its task, its session is kept alive in memory with
 * status "idle" for its idle TTL before it falls asleep. Previously, `irc send to:all`
 * broadcast to all visible peers (`running` or `idle`), which delivered messages to
 * completed agents and woke them, starting unexpected new turns on
 * finished agents.
 *
 * This test suite defends the invariant that:
 * 1. Broadcast (`to: "all"`) ONLY delivers to active running peers and NEVER
 *    targets or wakes completed (idle) or asleep peers.
 * 2. Direct messages (`to: "<id>"`) PRESERVE the documented contract that explicitly
 *    messaging a specific peer wakes an idle or asleep peer.
 * 3. Every member of the runtime `AgentStatus` union is covered.
 *
 * What this does NOT catch:
 * - Transport-level connection resets in external network providers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AGENT_STATUSES, AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/agent/irc";

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

	/** Swept from the runtime union, so a new status is broadcast to only if this table says so. */
	it("broadcasts to a peer in each AgentStatus only while it is running", async () => {
		const eligible: Record<AgentStatus, boolean> = { running: true, idle: false, asleep: false };
		const peers = new Map<AgentStatus, FakeSession>();
		for (const status of AGENT_STATUSES) {
			const peer = makeFakeSession("woken");
			peers.set(status, peer);
			registry.register({
				id: `Worker-${status}`,
				displayName: "worker",
				kind: "sub",
				session: status === "asleep" ? null : peer.session,
				status,
			});
			if (status === "asleep") {
				AgentLifecycleManager.global().adopt(`Worker-${status}`, {
					idleTtlMs: 0,
					revive: async () => peer.session,
				});
			}
		}

		const tool = new IrcTool(makeToolSession(registry, "Main"));
		await tool.execute("call-1", { op: "send", to: "all", message: "sweep" });

		for (const status of AGENT_STATUSES) {
			expect({ status, delivered: peers.get(status)?.delivered.length }).toEqual({
				status,
				delivered: eligible[status] ? 1 : 0,
			});
			expect(registry.get(`Worker-${status}`)?.status).toBe(status);
		}
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

		it("wakes an asleep peer on direct send", async () => {
			const asleepPeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Asleep",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "asleep",
			});
			AgentLifecycleManager.global().adopt("Worker-Asleep", {
				idleTtlMs: 0,
				revive: async () => asleepPeer.session,
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Asleep", message: "wake request" });

			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([{ to: "Worker-Asleep", outcome: "revived" }]);
			expect(asleepPeer.delivered.map(m => m.body)).toEqual(["wake request"]);
		});

		it("names the missing transcript when an asleep peer has nothing to wake from", async () => {
			registry.register({
				id: "Worker-Gone",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "asleep",
			});

			const tool = new IrcTool(makeToolSession(registry, "Main"));
			const result = await tool.execute("call-1", { op: "send", to: "Worker-Gone", message: "hello" });

			expect(result.isError).toBe(true);
			expect(result.details?.receipts?.[0]?.outcome).toBe("failed");
			expect(result.details?.receipts?.[0]?.error).toBe(
				'Agent "Worker-Gone" is asleep and cannot be woken (its transcript or workspace is gone). Read history://Worker-Gone for what it did.',
			);
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
		it("broadcasts ONLY to running and waiting peers, completely ignoring idle and asleep peers", async () => {
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

			const asleepPeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Asleep",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "asleep",
			});
			AgentLifecycleManager.global().adopt("Worker-Asleep", {
				idleTtlMs: 0,
				revive: async () => asleepPeer.session,
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

			// Only running & waiting peers are in the receipts, excluding self, idle and asleep
			const receiptTargets = result.details?.receipts?.map(r => r.to) ?? [];
			expect(receiptTargets.sort()).toEqual(["Worker-Running", "Worker-Waiting"]);

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

			// Asleep peer was NEVER woken
			expect(asleepPeer.delivered).toEqual([]);
			expect(registry.get("Worker-Asleep")?.status).toBe("asleep");
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

		it("returns 'No live peers to broadcast to' when only idle or asleep peers exist", async () => {
			const idlePeer = makeFakeSession("woken");
			registry.register({
				id: "Worker-Idle",
				displayName: "worker",
				kind: "sub",
				session: idlePeer.session,
				status: "idle",
			});
			registry.register({
				id: "Worker-Asleep",
				displayName: "worker",
				kind: "sub",
				session: null,
				status: "asleep",
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
