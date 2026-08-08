import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const MODEL = "anthropic/claude-sonnet-4-5";
const agent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Execute the assignment.",
	source: "bundled",
};

function result(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment ?? options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("task subagent effort inheritance", () => {
	let tempDir: TempDir;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("subagent-effort-inherit-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	async function dispatch(agentSettings: Record<string, { thinkingLevel?: string }> = {}) {
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => result(options));
		const tool = await TaskTool.create(
			makeToolSession({
				cwd: tempDir.path(),
				hasUI: false,
				settings: Settings.isolated({
					"async.enabled": false,
					"subagent.agents": agentSettings,
					"subagent.batch": true,
					"subagent.isolation.mode": "none",
				}),
				getSessionFile: () => tempDir.join("parent.jsonl"),
				getSessionSpawns: () => "*",
				getActiveModelString: () => MODEL,
				getActiveThinkingLevel: () => ThinkingLevel.High,
			}),
		);
		const execution = await tool.execute("inherit-effort", {
			context: "Shared context",
			tasks: [{ name: "InheritedWorker", task: "Inspect the requested behavior." }],
		});
		const options = run.mock.calls[0]?.[0];
		if (!options) {
			throw new Error(`Expected one subagent dispatch, received ${JSON.stringify(execution.content)}`);
		}
		return options;
	}

	/** An unset effort must cross the task-tool boundary as the parent's effort, not fall into child defaults. */
	it("passes the parent session effort when the agent row and blanket effort are unset", async () => {
		const options = await dispatch();

		expect(options.modelOverride).toEqual([MODEL]);
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.parentThinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * A per-agent `thinkingLevel` row is retired: model and effort have one owner
	 * (the blanket setting plus the agent file's frontmatter), and this row is a
	 * value an operator can still see in their config that governs nothing. It must
	 * not resurface as an override here, and the parent's effort must still cross
	 * the boundary as the fallback layer.
	 */
	it("ignores a retired per-agent effort row and still inherits the parent effort", async () => {
		const options = await dispatch({ task: { thinkingLevel: AUTO_THINKING } });

		expect(options.thinkingLevel).toBeUndefined();
		expect(options.parentThinkingLevel).toBe(ThinkingLevel.High);
	});
});
