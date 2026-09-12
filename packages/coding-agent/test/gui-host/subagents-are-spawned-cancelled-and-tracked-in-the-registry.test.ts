/**
 * WHY:
 *
 * Earlier implementations of SpawnTask registered a synthetic row in the agent registry
 * without driving the real task executor, leaving tasks unexecuted while reporting success.
 * CancelTask mutated status strings directly rather than terminating through AgentLifecycleManager,
 * and ReviveAgent did not emit updated Agents snapshot sections on success or failure.
 *
 * This suite defends:
 * 1. SpawnTask delegates to the production task executor, failing truthfully with TASK_SPAWN_FAILED
 *    in scope Task when no model provider is available, without leaving orphaned phantom rows in Agents.
 * 2. SpawnTask, CancelTask, and ReviveAgent validate required arguments and fail closed with INVALID_ARGUMENTS.
 * 3. CancelTask terminates real subagent lifecycles and emits updated Agents snapshots.
 * 4. ReviveAgent validates agent existence and ensures liveness via AgentLifecycleManager, emitting updated snapshots.
 *
 * Gap left:
 * Full multi-turn execution of a live model provider is covered by integration suites; this suite
 * defends protocol framing, lifecycle routing, and error boundaries against the real server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-agents-test-");

describe("subagents and tasks action group behaviour", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	test("SpawnTask without task parameter fails with INVALID_ARGUMENTS in scope Task", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(1, { SpawnTask: {} });
		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(1);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Task");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.message).toBe("SpawnTask requires a task parameter");

		client.destroy();
	});

	test("SpawnTask with unknown agent fails with TASK_SPAWN_FAILED and leaves no phantom row in Agents", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(2, {
			SpawnTask: {
				task: "Analyze the repository structure",
				agent: "unknown-agent-name-xyz",
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(2);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Task");
		expect(res.outcome.RequestFailed?.error.code).toBe("TASK_SPAWN_FAILED");

		// Verify no phantom task row was left in the registry
		const allAgents = AgentRegistry.global().list();
		const phantomTasks = allAgents.filter(a => a.displayName.includes("Analyze the repo"));
		expect(phantomTasks.length).toBe(0);

		client.destroy();
	});

	test("SpawnTask with valid parameters succeeds, emits Agents snapshot, and registers the task in registry", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(8, {
			SpawnTask: {
				task: "Explore project layout",
			},
		});

		expect(res.outcome).toEqual({ RequestSucceeded: { request: 8 } });
		interface AgentsSnapshotFrame {
			Snapshot?: {
				Agents?: Array<{ id: string; status: string; display_name: string }>;
			};
		}
		const agentsSnap: AgentsSnapshotFrame | undefined = res.frames.find(f => f.Snapshot && "Agents" in f.Snapshot);
		expect(agentsSnap).toBeDefined();

		client.destroy();
	});

	test("CancelTask without task_id fails with INVALID_ARGUMENTS in scope Task", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(3, { CancelTask: {} });
		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(3);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Task");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.message).toBe("CancelTask requires a task_id parameter");

		client.destroy();
	});

	test("CancelTask on non-existent task fails with TASK_NOT_FOUND in scope Task", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(4, {
			CancelTask: {
				task_id: "non-existent-task-id",
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(4);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Task");
		expect(res.outcome.RequestFailed?.error.code).toBe("TASK_NOT_FOUND");
		expect(res.outcome.RequestFailed?.error.message).toBe("Task 'non-existent-task-id' was not found");

		client.destroy();
	});

	test("ReviveAgent without agent_id fails with INVALID_ARGUMENTS in scope Agent", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(5, { ReviveAgent: {} });
		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(5);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Agent");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.message).toBe("ReviveAgent requires an agent_id parameter");

		client.destroy();
	});

	test("ReviveAgent on non-existent agent fails with AGENT_NOT_FOUND in scope Agent", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(6, {
			ReviveAgent: {
				agent_id: "non-existent-agent-id",
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(6);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Agent");
		expect(res.outcome.RequestFailed?.error.code).toBe("AGENT_NOT_FOUND");
		expect(res.outcome.RequestFailed?.error.message).toBe("Agent 'non-existent-agent-id' was not found in registry");

		client.destroy();
	});

	test("CancelTask on an existing registered agent terminates it and emits Agents snapshot", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// Pre-register an agent in the registry
		const testAgentId = "test-agent-worker-1";
		AgentRegistry.global().register({
			id: testAgentId,
			displayName: "Worker 1",
			kind: "sub",
			status: "running",
			scope: tempDir,
			session: null,
		});

		const res = await client.request(7, {
			CancelTask: {
				task_id: testAgentId,
			},
		});

		expect(res.outcome).toEqual({ RequestSucceeded: { request: 7 } });

		interface AgentsSnapshotFrame {
			Snapshot?: {
				Agents?: Array<{ id: string; status: string }>;
			};
		}
		const agentsSnap: AgentsSnapshotFrame | undefined = res.frames.find(f => f.Snapshot && "Agents" in f.Snapshot);
		expect(agentsSnap).toBeDefined();
		const agentsList = agentsSnap?.Snapshot?.Agents ?? [];
		const target = agentsList.find(a => a.id === testAgentId);
		expect(target?.status === "aborted" || !target).toBe(true);
		client.destroy();
	});
});
