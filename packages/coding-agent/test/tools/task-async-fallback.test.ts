import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};
const blockingAgent: AgentDefinition = {
	...taskAgent,
	name: "blocking",
	blocking: true,
};

function createSession(
	options: { settings?: Partial<Record<string, unknown>>; manager?: AsyncJobManager; spawns?: string } = {},
): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
	});
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}
function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

useIsolatedAgentDir();

describe("task execution mode and authorization failures", () => {
	const managers: AsyncJobManager[] = [];
	const originalBlockedAgent = Bun.env.VEYYON_BLOCKED_AGENT;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		if (originalBlockedAgent === undefined) {
			delete Bun.env.VEYYON_BLOCKED_AGENT;
		} else {
			Bun.env.VEYYON_BLOCKED_AGENT = originalBlockedAgent;
		}
	});

	/**
	 * Prevents an enabled async request from being reported as an ordinary
	 * synchronous child result when the host forgot to wire its job manager.
	 */
	it("fails loud when async execution is enabled without an AsyncJobManager", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": true } }));

		const result = await tool.execute("tool-async-missing", {
			agent: "task",
			name: "One",
			task: "Do the thing.",
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toBe(
			"Async task execution is enabled, but no AsyncJobManager is available. Disable async execution to run synchronously, or provide an AsyncJobManager.",
		);
		expect(result.details).toEqual({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			warning: undefined,
		});
		// Discovery is deliberately re-run per `execute` rather than reused from
		// `create`, so an agent file written mid-session is visible on the next
		// call. Its call count is that implementation choice and not a contract;
		// what this test defends is that the guard fires before any spawn.
		expect(runSpy).not.toHaveBeenCalled();
	});

	/**
	 * Prevents the fail-loud async guard from breaking the explicitly selected
	 * synchronous mode, which must still execute and return the child result.
	 */
	it("keeps permitted synchronous execution when async is disabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "unknown"));
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));

		const result = await tool.execute("tool-sync", {
			agent: "task",
			name: "SyncOne",
			task: "Do the thing.",
		} as TaskParams);

		expect(result.isError).toBe(false);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results).toHaveLength(1);
		expect(result.details?.results[0]?.output).toBe("All done.");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});
	/**
	 * Prevents an agent type that explicitly requires inline execution from
	 * being rejected merely because the surrounding session enables async.
	 */
	it("keeps permitted blocking execution without an AsyncJobManager", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => ({ ...makeResult(options.id ?? "unknown"), agent: "blocking" }));
		const tool = await TaskTool.create(
			createSession({
				settings: { "async.enabled": true, "subagent.agents": { blocking: { enabled: true } } },
				spawns: "blocking",
			}),
		);

		const result = await tool.execute("tool-blocking", {
			agent: "blocking",
			name: "BlockingOne",
			task: "Do the thing.",
		} as TaskParams);

		expect(result.isError).toBe(false);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results[0]?.agent).toBe("blocking");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	/**
	 * Prevents parent allow-list denials from looking successful, including on
	 * async-capable sessions where the refusal must happen before job creation.
	 */
	it("returns an explicit error result for a parent spawn-policy refusal", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true }, spawns: "reviewer" }),
		);

		const result = await tool.execute("tool-policy-denied", {
			agent: "task",
			name: "Denied",
			task: "Do the thing.",
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toBe("Cannot spawn 'task'. Allowed: reviewer");
		expect(result.details).toEqual({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			warning: undefined,
		});
		expect(manager.getAllJobs()).toEqual([]);
	});

	/**
	 * Prevents self-recursion denials from returning success-shaped payloads or
	 * scheduling a background job before recursion prevention is evaluated.
	 */
	it("returns an explicit error result for a self-recursion refusal", async () => {
		Bun.env.VEYYON_BLOCKED_AGENT = "task";
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager, settings: { "async.enabled": true } }));

		const result = await tool.execute("tool-recursion-denied", {
			agent: "task",
			name: "Recursive",
			task: "Do the thing.",
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toBe(
			"Cannot spawn task agent from within itself (recursion prevention). Use a different agent type.",
		);
		expect(result.details).toEqual({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			warning: undefined,
		});
		expect(manager.getAllJobs()).toEqual([]);
	});
});
