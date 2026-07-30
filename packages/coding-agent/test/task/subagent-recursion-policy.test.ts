import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import {
	resolveSessionMaxNestedSpawnDepth,
	resolveSubagentMaxNestedSpawnDepth,
} from "@veyyon/coding-agent/task/subagent-settings";
import { type AgentDefinition, canSpawnAtDepth } from "@veyyon/coding-agent/task/types";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";

useIsolatedAgentDir();

function toolSession(
	options: { settings?: Settings; taskDepth?: number; maxNestedSpawnDepth?: number } = {},
): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: options.settings ?? Settings.isolated(),
		taskDepth: options.taskDepth,
		maxNestedSpawnDepth: options.maxNestedSpawnDepth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		skipPythonPreflight: true,
	};
}

async function hasTaskTool(session: ToolSession): Promise<boolean> {
	const tools = await createTools(session, ["task"]);
	return tools.some(tool => tool.name === "task");
}

function yieldingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit(yieldSuccessEvent({ ok: true }, "recursion-policy"));
	});
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseExecutorOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "recursion-policy-child",
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("subagent nested spawn depth policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Zero counts nested subagent levels, not the root. The parent must retain the
	 * task tool while every direct child becomes a leaf by default.
	 */
	it("defaults to parent-only spawning", async () => {
		const settings = Settings.isolated();
		expect(settings.get("subagent.maxNestedSpawnDepth")).toBe(0);
		expect(canSpawnAtDepth(0, 0)).toBe(true);
		expect(canSpawnAtDepth(0, 1)).toBe(false);
		expect(await hasTaskTool(toolSession({ settings, taskDepth: 0 }))).toBe(true);
		expect(await hasTaskTool(toolSession({ settings, taskDepth: 1 }))).toBe(false);
	});

	/**
	 * The boundary is inclusive for the agent doing the spawning: cap one lets a
	 * depth-one child spawn one leaf, but never lets the depth-two child continue.
	 */
	it("honors inclusive finite boundaries and unlimited mode", async () => {
		expect(canSpawnAtDepth(1, 0)).toBe(true);
		expect(canSpawnAtDepth(1, 1)).toBe(true);
		expect(canSpawnAtDepth(1, 2)).toBe(false);
		expect(canSpawnAtDepth(-1, 10_000)).toBe(true);
		expect(await hasTaskTool(toolSession({ taskDepth: 1, maxNestedSpawnDepth: 1 }))).toBe(true);
		expect(await hasTaskTool(toolSession({ taskDepth: 2, maxNestedSpawnDepth: 1 }))).toBe(false);
	});

	/**
	 * Each agent row overrides the blanket independently. A designer override must
	 * not leak into task or an unconfigured custom agent.
	 */
	it("resolves each agent override without contaminating the blanket limit", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 0,
			"subagent.agents": {
				designer: { maxNestedSpawnDepth: 2 },
				reviewer: { maxNestedSpawnDepth: -1 },
			},
		});
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "designer")).toBe(2);
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "reviewer")).toBe(-1);
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "task")).toBe(0);
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "custom")).toBe(0);
	});

	/**
	 * Hand-edited record values bypass the generic record schema. Invalid values
	 * must fail loudly instead of silently granting unlimited recursion.
	 */
	it("rejects invalid per-agent recursion values", () => {
		const settings = Settings.isolated({
			"subagent.agents": { task: { maxNestedSpawnDepth: 1.5 } },
		});
		expect(() => resolveSubagentMaxNestedSpawnDepth(settings, "task")).toThrow(
			"subagent.agents.task.maxNestedSpawnDepth must be -1 (unlimited) or a non-negative integer",
		);
		expect(() => resolveSessionMaxNestedSpawnDepth(settings, -2)).toThrow(
			"session maxNestedSpawnDepth must be -1 (unlimited) or a non-negative integer",
		);
	});

	/**
	 * The executor must pass the selected agent's resolved cap into the child
	 * session. Reading only the blanket here would make the per-agent UI a no-op.
	 */
	it("passes the selected agent override into child session construction", async () => {
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldingSession()));
		const designer: AgentDefinition = { ...baseAgent, name: "designer" };
		const result = await runSubprocess({
			...baseExecutorOptions,
			agent: designer,
			settings: Settings.isolated({
				"subagent.maxNestedSpawnDepth": 0,
				"subagent.agents": { designer: { maxNestedSpawnDepth: 2 } },
			}),
		});
		expect(result.exitCode).toBe(0);
		const options = spy.mock.calls[0]?.[0];
		if (!options) throw new Error("Expected child session options");
		expect(options.taskDepth).toBe(1);
		expect(options.maxNestedSpawnDepth).toBe(2);
	});
});
