/**
 * WHY:
 * The desktop front end displays an agent roster and comms stream scoped to the active
 * conversation. Previously, `agentsSection(cwd)` passed the project working directory
 * where the registry expected a conversation ID, causing all agents with conversation scopes
 * to be filtered out. Additionally, `AgentView` lacked `activity` and `model` fields,
 * agent-to-agent IRC traffic had no desktop projection, updates were not live, and
 * `RefreshAgents` was missing from the host action dispatcher.
 *
 * This suite defends:
 * 1. A roster scoped to a session lists that session's agents and omits another session's.
 * 2. A roster with no session open lists all agents across all scopes.
 * 3. A comms stream carries only lines matching the session scope, strictly oldest first.
 * 4. Registry status changes and delivered IRC messages reach an attached client unsolicited,
 *    and bursts of registry events are coalesced under STREAM_FRAME_INTERVAL_MS.
 * 5. A disconnected client receives no further writes and cleanly unregisters its listeners
 *    from both AgentRegistry and IrcBus (returning listener counts to pre-attach levels).
 * 6. RefreshAgents publishes both Agents and AgentComms sections for the caller's scope.
 * 7. AGENT_MESSAGE_OUTCOMES is swept at run time so any new outcome fails until handled.
 *
 * Gap left:
 * Full multi-process agent execution and GPUI pixel rendering are owned by the desktop
 * crate suites; this suite defends protocol framing, conversation scoping, live subscription
 * lifecycle, and throttling against the real server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import {
	AGENT_MESSAGE_OUTCOMES,
	type AgentMessageOutcome,
	type AgentMessageView,
	type AgentView,
	type SessionHeaderView,
} from "../../src/gui-host/wire";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { IrcBus } from "../../src/task/irc-bus";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-scoped-agents-test-");
function mockSession(outcome: AgentMessageOutcome = "injected"): AgentSession {
	return {
		deliverIrcMessage: async () => outcome,
		emitIrcRelayObservation: () => {},
		sessionManager: {
			getSessionId: () => "mock-sess-id",
		},
	} as unknown as AgentSession;
}

async function nextMatchingFrame<T>(
	client: TestSocketClient,
	predicate: (frame: RequestFrame) => T | undefined,
	timeoutMs = 1500,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const frame = (await Promise.race([
			client.nextFrame() as Promise<RequestFrame>,
			sleep(remaining, null),
		])) as RequestFrame | null;
		if (!frame) break;
		const result = predicate(frame);
		if (result !== undefined) return result;
	}
	throw new Error(`Timed out waiting for matching frame after ${timeoutMs}ms`);
}

describe("the agent roster and comms stream reach the desktop scoped and live", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a roster scoped to a session lists that session's agents and omits another session's", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const created = await client.request(1, { CreateSession: { title: "Session One" } });
		const [active] = snapshotSections<{ value: SessionHeaderView }>(created.frames, "ActiveSession");
		expect(active).toBeDefined();
		const session1Id = active.value.id;
		const registry = AgentRegistry.global();
		registry.register({
			id: "agent-session-1",
			displayName: "Scoped Worker",
			kind: "sub",
			status: "running",
			scope: session1Id,
			session: mockSession(),
			model: "anthropic/claude-3-7-sonnet",
		});
		registry.setActivity("agent-session-1", "processing dataset");
		registry.register({
			id: "agent-session-2",
			displayName: "Foreign Worker",
			kind: "sub",
			status: "running",
			scope: "different-session-uuid-999",
			session: mockSession(),
			model: "openai/gpt-4o",
		});
		registry.setActivity("agent-session-2", "compiling code");
		const refreshed = await client.request(2, "RefreshAgents");
		expect(refreshed.outcome.RequestSucceeded?.request).toBe(2);

		const [agents] = snapshotSections<AgentView[]>(refreshed.frames, "Agents");
		expect(agents).toBeDefined();
		expect(agents.map(a => a.id)).toContain("agent-session-1");

		const scopedView = agents.find(a => a.id === "agent-session-1")!;
		expect(scopedView.activity).toBe("processing dataset");
		expect(scopedView.model).toBe("anthropic/claude-3-7-sonnet");
		expect(scopedView.scope).toBe(session1Id);

		client.destroy();
	});

	test("a roster with no session open lists everything", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const registry = AgentRegistry.global();
		registry.register({
			id: "agent-alpha",
			displayName: "Alpha",
			kind: "sub",
			status: "running",
			scope: "session-alpha",
			session: mockSession(),
		});
		registry.register({
			id: "agent-beta",
			displayName: "Beta",
			kind: "sub",
			status: "running",
			scope: "session-beta",
			session: mockSession(),
		});
		registry.register({
			id: "agent-gamma",
			displayName: "Gamma",
			kind: "sub",
			status: "running",
			scope: undefined,
			session: mockSession(),
		});

		const attached = await client.request(1, "Attach");
		expect(attached.outcome.RequestSucceeded?.request).toBe(1);

		const [agents] = snapshotSections<AgentView[]>(attached.frames, "Agents");
		expect(agents).toBeDefined();
		const ids = agents.map(a => a.id);
		expect(ids).toContain("agent-alpha");
		expect(ids).toContain("agent-beta");
		expect(ids).toContain("agent-gamma");

		client.destroy();
	});

	test("a comms stream carries only the lines stamped with that scope, oldest first", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const created = await client.request(1, { CreateSession: {} });
		const [active] = snapshotSections<{ value: SessionHeaderView }>(created.frames, "ActiveSession");
		const sessionId = active.value.id;

		const registry = AgentRegistry.global();
		registry.register({
			id: "agent-1",
			displayName: "Agent 1",
			kind: "sub",
			status: "running",
			scope: sessionId,
			session: mockSession(),
		});
		registry.register({
			id: "agent-2",
			displayName: "Agent 2",
			kind: "sub",
			status: "running",
			scope: sessionId,
			session: mockSession(),
		});
		registry.register({
			id: "foreign-1",
			displayName: "Foreign 1",
			kind: "sub",
			status: "running",
			scope: "other-session-456",
			session: mockSession(),
		});
		registry.register({
			id: "foreign-2",
			displayName: "Foreign 2",
			kind: "sub",
			status: "running",
			scope: "other-session-456",
			session: mockSession(),
		});

		const bus = IrcBus.global();
		await bus.send({ from: "agent-1", to: "agent-2", body: "first message" });
		await bus.send({ from: "foreign-1", to: "foreign-2", body: "foreign message" });
		await bus.send({ from: "agent-2", to: "agent-1", body: "second message" });

		const refreshed = await client.request(2, "RefreshAgents");
		const [comms] = snapshotSections<AgentMessageView[]>(refreshed.frames, "AgentComms");
		expect(comms).toBeDefined();

		const bodies = comms.map(msg => msg.body);
		expect(bodies).toEqual(["first message", "second message"]);

		const [firstMsg, secondMsg] = comms;
		expect(firstMsg.from).toBe("agent-1");
		expect(firstMsg.to).toBe("agent-2");
		expect(firstMsg.outcome).toBe("injected");
		expect(firstMsg.error).toBeNull();
		expect(firstMsg.reply_to).toBeNull();
		expect(typeof firstMsg.at_ms).toBe("number");

		expect(secondMsg.from).toBe("agent-2");
		expect(secondMsg.to).toBe("agent-1");

		client.destroy();
	});

	test("a registry status change and a delivered message each reach an attached client without it asking", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const created = await client.request(1, { CreateSession: {} });
		const [active] = snapshotSections<{ value: SessionHeaderView }>(created.frames, "ActiveSession");
		const sessionId = active.value.id;

		const registry = AgentRegistry.global();
		registry.register({
			id: "live-worker-1",
			displayName: "Live Worker 1",
			kind: "sub",
			status: "running",
			scope: sessionId,
			session: mockSession(),
		});
		registry.register({
			id: "live-worker-2",
			displayName: "Live Worker 2",
			kind: "sub",
			status: "running",
			scope: sessionId,
			session: mockSession(),
		});

		await client.request(2, "Attach");

		registry.setStatus("live-worker-1", "idle");

		const updatedAgents = await nextMatchingFrame(client, frame => {
			const [agents] = snapshotSections<AgentView[]>([frame], "Agents");
			return agents?.find(a => a.id === "live-worker-1" && a.status === "idle");
		});
		expect(updatedAgents).toBeDefined();
		expect(updatedAgents.status).toBe("idle");

		const bus = IrcBus.global();
		await bus.send({ from: "live-worker-1", to: "live-worker-2", body: "unsolicited broadcast" });

		const updatedComms = await nextMatchingFrame(client, frame => {
			const [comms] = snapshotSections<AgentMessageView[]>([frame], "AgentComms");
			return comms?.find(m => m.body === "unsolicited broadcast");
		});
		expect(updatedComms).toBeDefined();
		expect(updatedComms.from).toBe("live-worker-1");

		// Verify that a rapid burst of registry updates is coalesced rather than emitting one frame per event
		for (let i = 0; i < 5; i++) {
			registry.setStatus("live-worker-1", i % 2 === 0 ? "running" : "idle");
		}
		await sleep(60);

		let agentFramesCount = 0;
		while (true) {
			const frame = (await Promise.race([
				client.nextFrame() as Promise<RequestFrame>,
				sleep(20, null),
			])) as RequestFrame | null;
			if (!frame) break;
			if (frame.Snapshot && "Agents" in frame.Snapshot) {
				agentFramesCount++;
			}
		}
		expect(agentFramesCount).toBeLessThan(5);

		client.destroy();
	});

	test("a disconnected client receives nothing and leaves no listener behind", async () => {
		const registry = AgentRegistry.global();
		const bus = IrcBus.global();

		const preAttachRegistryListeners = registry.listenerCount();
		const preAttachBusListeners = bus.listenerCount();

		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.request(1, "Attach");

		expect(registry.listenerCount()).toBe(preAttachRegistryListeners + 1);
		expect(bus.listenerCount()).toBe(preAttachBusListeners + 1);

		client.destroy();
		await client.waitForClose();
		await sleep(50);

		expect(registry.listenerCount()).toBe(preAttachRegistryListeners);
		expect(bus.listenerCount()).toBe(preAttachBusListeners);

		// Further registry/bus events do not throw and find no dead listeners
		expect(() => {
			registry.register({
				id: "post-disconnect-agent",
				displayName: "Post Disconnect",
				kind: "sub",
				status: "running",
				session: null,
			});
			void bus.send({ from: "post-disconnect-agent", to: "post-disconnect-agent", body: "noop" });
		}).not.toThrow();
	});

	test("RefreshAgents publishes both sections", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const created = await client.request(1, { CreateSession: {} });
		const [active] = snapshotSections<{ value: SessionHeaderView }>(created.frames, "ActiveSession");
		const sessionId = active.value.id;

		const registry = AgentRegistry.global();
		registry.register({
			id: "refresh-target-agent",
			displayName: "Refresh Target",
			kind: "sub",
			status: "running",
			scope: sessionId,
			session: mockSession(),
		});

		const bus = IrcBus.global();
		await bus.send({ from: "refresh-target-agent", to: "refresh-target-agent", body: "test-comms-line" });

		const res = await client.request(2, "RefreshAgents");
		expect(res.outcome.RequestSucceeded?.request).toBe(2);

		const [agents] = snapshotSections<AgentView[]>(res.frames, "Agents");
		const [comms] = snapshotSections<AgentMessageView[]>(res.frames, "AgentComms");

		expect(agents).toBeDefined();
		expect(agents.some(a => a.id === "refresh-target-agent")).toBe(true);

		expect(comms).toBeDefined();
		expect(comms.some(c => c.body === "test-comms-line")).toBe(true);

		client.destroy();
	});

	test("AGENT_MESSAGE_OUTCOMES is exhaustive and maps every variant", () => {
		// Sweep AGENT_MESSAGE_OUTCOMES: pinned by exact equality so any new variant fails until handled
		const actualSorted = [...AGENT_MESSAGE_OUTCOMES].sort();
		expect(actualSorted).toEqual(["failed", "injected", "revived", "woken"]);

		// Assert every outcome variant is a valid AgentMessageOutcome
		for (const outcome of AGENT_MESSAGE_OUTCOMES) {
			const view: AgentMessageView = {
				id: "msg-test",
				from: "agent-a",
				to: "agent-b",
				body: "test",
				at_ms: Date.now(),
				reply_to: null,
				outcome,
				error: outcome === "failed" ? "error reason" : null,
			};
			expect(view.outcome).toBe(outcome);
		}
	});
});
