import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

function childResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Keep the parent effort.",
		assignment: "Keep the parent effort.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("SDK subagent effort inheritance", () => {
	let sharedDir: string;
	let cwd: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-sdk-effort-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	beforeEach(() => {
		cwd = path.join(sharedDir, `project-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: loadBundledAgents(),
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		removeSyncWithRetries(cwd);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	async function createParent(thinkingLevel: ConfiguredThinkingLevel = ThinkingLevel.High): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const { session } = await createAgentSession({
			cwd,
			agentDir: sharedDir,
			model,
			modelRegistry,
			thinkingLevel,
			settings: Settings.isolated({ "async.enabled": false, "subagent.batch": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["task"],
		});
		sessions.push(session);
		return session;
	}

	async function dispatch(session: AgentSession, id: string): Promise<void> {
		const tool = session.getToolByName("task");
		if (!tool) throw new Error("Expected task tool to be active");
		await tool.execute(id, {
			agent: "task",
			name: id,
			task: "Keep the parent effort.",
		} as TaskParams);
	}

	/**
	 * The real SDK ToolSession must expose the live concrete parent effort to the
	 * task tool. A unit-only ToolSession stub would not catch this missing getter.
	 */
	it("forwards the live parent effort through the SDK tool session", async () => {
		const session = await createParent();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult("SdkHigh"));

		await dispatch(session, "SdkHigh");

		expect(spy.mock.calls[0]?.[0]?.parentThinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * A live transition to inherit leaves the session on its concrete startup
	 * effort, which is what the SDK forwards to an inherited child.
	 */
	it("forwards the concrete parent effort after a live inherit transition", async () => {
		const session = await createParent();
		session.setThinkingLevel(ThinkingLevel.Inherit);
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult("SdkInherited"));

		await dispatch(session, "SdkInherited");

		expect(spy.mock.calls[0]?.[0]?.parentThinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * Off is an effective parent state, not absence. The SDK bridge must forward
	 * it exactly so a child cannot re-enable provider reasoning.
	 */
	it("forwards an explicit parent off effort exactly", async () => {
		const session = await createParent(ThinkingLevel.Off);
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult("SdkOff"));

		await dispatch(session, "SdkOff");

		expect(spy.mock.calls[0]?.[0]?.parentThinkingLevel).toBe(ThinkingLevel.Off);
		expect(spy.mock.calls[0]?.[0]?.parentThinkingLevel).not.toBe(AUTO_THINKING);
	});

	/**
	 * Auto remains the configured selector exposed by the SDK. Child execution
	 * receives that selector rather than reading the agent's provisional level.
	 */
	it("forwards auto when the parent is configured as auto", async () => {
		const session = await createParent(AUTO_THINKING);
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult("SdkAuto"));

		await dispatch(session, "SdkAuto");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(spy.mock.calls[0]?.[0]?.parentThinkingLevel).toBe(AUTO_THINKING);
	});
});
