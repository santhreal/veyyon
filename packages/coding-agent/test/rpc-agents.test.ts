import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcAgentRegistry, readRpcAgentTranscript } from "@veyyon/coding-agent/modes/rpc/rpc-agents";
import { RpcClient } from "@veyyon/coding-agent/modes/rpc/rpc-client";
import {
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import type { RpcAgentFrame } from "@veyyon/coding-agent/modes/rpc/rpc-types";
import {
	type AgentEventPayload,
	type AgentLifecyclePayload,
	type AgentProgress,
	type AgentProgressPayload,
	TASK_AGENT_EVENT_CHANNEL,
	TASK_AGENT_LIFECYCLE_CHANNEL,
	TASK_AGENT_PROGRESS_CHANNEL,
} from "@veyyon/coding-agent/task";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@veyyon/utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SpawnA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcAgentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcAgentRegistry(eventBus, () => {});
	eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, {
		id: "SpawnA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/agent.jsonl",
	} satisfies AgentLifecyclePayload);
	expect(registry.getAgents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) => options.branch ?? { selectedText: "branched text", cancelled: false },
	};
}

describe("RPC agent registry", () => {
	test("defaults agent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcAgentFrame[] = [];
		const registry = new RpcAgentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: AgentLifecyclePayload = {
			id: "SpawnA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/agent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: AgentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/agent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: AgentEventPayload = {
			id: "SpawnA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_AGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_AGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getAgents()).toMatchObject([
			{
				id: "SpawnA",
				status: "running",
				sessionFile: "/tmp/agent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked agents", () => {
		const eventBus = new EventBus();
		const frames: RpcAgentFrame[] = [];
		const registry = new RpcAgentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: AgentLifecyclePayload = {
			id: "SpawnA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/agent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: AgentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/agent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_AGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getAgents()).toMatchObject([
			{
				id: "SpawnA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/agent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcAgentRegistry(eventBus, () => {});
		eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, {
			id: "SpawnA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/agent.jsonl",
		} satisfies AgentLifecyclePayload);

		expect(registry.getAgents()).toHaveLength(1);
		registry.clear();

		expect(registry.getAgents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "Branch text", cancelled: false } }),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getAgents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ agentId: "SpawnA" })).toThrow(
					/Unknown agent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getAgents()).toMatchObject([{ id: "SpawnA" }]);
				expect(registry.resolveSessionFile({ agentId: "SpawnA" })).toBe("/tmp/agent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcAgentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/agent.jsonl";
		eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, {
			id: "SpawnA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies AgentLifecyclePayload);

		expect(registry.getAgents()).toHaveLength(1);
		eventBus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, {
			id: "SpawnA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies AgentLifecyclePayload);

		expect(registry.getAgents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ agentId: "SpawnA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw agent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcAgentFrame[] = [];
		const registry = new RpcAgentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: AgentEventPayload = {
			id: "SpawnA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_AGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_AGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcAgentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-rpc-agent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcAgentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-rpc-agent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcAgentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient agent frames", () => {
	test("dispatches agent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `veyyon-rpc-agent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SpawnA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { agents: [{ id: "SpawnA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/agent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "agent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SpawnA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/agent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/agent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SpawnA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onAgentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onAgentProgress(payload => progressTasks.push(payload.task));
		client.onAgentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setAgentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger agent frames");
		expect(await client.getAgents()).toHaveLength(1);
		expect(await client.getAgentMessages({ sessionFile: "/tmp/agent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/agent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SpawnA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});
});
