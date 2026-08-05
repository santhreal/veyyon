import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TaskTool, taskSchema } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { getTaskSchema } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type } from "arktype";
import { makeToolSession } from "../helpers/tool-session";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields. The batch shape (`tasks[]` +
// shared `context`) is gated by the `task.batch` setting (default on, covered
// by test/task/task-batch.test.ts), and a per-call `schema` input no longer
// exists at all; follow-ups go through `irc` messaging.

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = taskSchema({ agent: "explore", task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "explore" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("strips tasks/context/schema from the single-spawn schema", () => {
		const parsed = taskSchema({
			agent: "explore",
			task: "Map the auth module.",
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			// Unknown keys are stripped: batch/context exist only on the batch
			// schema and the per-call schema input was removed outright.
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task dynamic default schema", () => {
	/** Prevents the no-default cache entry from colliding with a real agent literally named `required`. */
	it("distinguishes an unset default from the agent name required in either cache order", () => {
		const unsetFirst = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: undefined });
		const namedSecond = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "required" });
		const namedFirst = getTaskSchema({ isolationEnabled: true, batchEnabled: false, defaultAgent: "required" });
		const unsetSecond = getTaskSchema({ isolationEnabled: true, batchEnabled: false, defaultAgent: undefined });

		expect(unsetFirst({ task: "work" }) instanceof type.errors).toBe(true);
		expect(namedSecond({ task: "work" })).toMatchObject({ agent: "required", task: "work" });
		expect(namedFirst({ task: "work" })).toMatchObject({ agent: "required", task: "work" });
		expect(unsetSecond({ task: "work" }) instanceof type.errors).toBe(true);
	});

	/** Keeps schema omission aligned with runtime discovery for valid custom names containing punctuation. */
	it("safely defaults a custom agent name outside identifier grammar", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "foo.bar/v2" });

		expect(schema({ task: "work" })).toMatchObject({ agent: "foo.bar/v2", task: "work" });
	});

	it("constrains every batch item to the enabled catalog", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: true,
			defaultAgent: "task",
			enabledAgentNames: ["task", "scout"],
		});
		const jsonSchema = schema.toJsonSchema() as {
			properties?: {
				tasks?: { items?: { properties?: { agent?: { enum?: string[] } } } };
			};
		};

		expect(jsonSchema.properties?.tasks?.items?.properties?.agent?.enum).toEqual(["scout", "task"]);
		expect(
			schema({
				context: "shared",
				tasks: [{ agent: "reviewer", task: "review" }],
			}) instanceof type.errors,
		).toBe(true);
		expect(
			schema({
				context: "shared",
				tasks: [{ agent: "scout", task: "research" }],
			}) instanceof type.errors,
		).toBe(false);
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return makeToolSession({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": false,
				"subagent.isolation.mode": "none",
				"subagent.batch": false,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		});
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("does not invent a default when discovery yields no enabled agent", async () => {
		const text = await executeText({ task: "..." });
		expect(text).toContain("No enabled default agent exists");
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "explore" });
		expect(text).toContain("Missing `task`");
	});
});

describe("task enabled-agent schema", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const agents: AgentDefinition[] = [
		{
			name: "task",
			description: "General worker",
			systemPrompt: "Work on the task.",
			source: "bundled",
		},
		{
			name: "reviewer",
			description: "Review work",
			systemPrompt: "Review the task.",
			source: "bundled",
		},
	];

	async function createTool(settings: Settings): Promise<TaskTool> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		return TaskTool.create(
			makeToolSession({
				cwd: "/tmp",
				hasUI: false,
				settings,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			}),
		);
	}

	function agentChoices(tool: TaskTool): string[] {
		const schema = tool.parameters.toJsonSchema() as {
			properties?: { agent?: { const?: string; enum?: string[] } };
		};
		const agent = schema.properties?.agent;
		return agent?.enum ?? (agent?.const === undefined ? [] : [agent.const]);
	}

	it("offers and accepts only enabled agents", async () => {
		const settings = Settings.isolated({
			"subagent.batch": false,
			"subagent.agents": { reviewer: { enabled: false } },
		});
		const tool = await createTool(settings);

		expect(tool.enabledAgentNames).toEqual(["task"]);
		expect(agentChoices(tool)).toEqual(["task"]);
		expect(tool.parameters({ agent: "task", task: "work" }) instanceof type.errors).toBe(false);
		expect(tool.parameters({ agent: "reviewer", task: "work" }) instanceof type.errors).toBe(true);
	});

	it("never automatically routes to a disabled default", async () => {
		const settings = Settings.isolated({
			"subagent.batch": false,
			"subagent.agents": {
				task: { enabled: false },
				reviewer: { enabled: true },
			},
		});
		const tool = await createTool(settings);

		expect(tool.enabledAgentNames).toEqual(["reviewer"]);
		expect(agentChoices(tool)).toEqual(["reviewer"]);
		expect(tool.parameters({ task: "work" }) instanceof type.errors).toBe(true);
		expect(tool.parameters({ agent: "reviewer", task: "work" }) instanceof type.errors).toBe(false);
	});

	it("reloads enabled choices from the live settings object", async () => {
		const settings = Settings.isolated();
		settings.set("subagent.batch", false);
		settings.set("subagent.agents", { reviewer: { enabled: false } });
		const tool = await createTool(settings);
		expect(agentChoices(tool)).toEqual(["task"]);

		settings.set("subagent.agents", {
			task: { enabled: false },
			reviewer: { enabled: true },
		});

		expect(tool.enabledAgentNames).toEqual(["reviewer"]);
		expect(agentChoices(tool)).toEqual(["reviewer"]);
		expect(tool.parameters({ agent: "task", task: "work" }) instanceof type.errors).toBe(true);
		expect(tool.parameters({ agent: "reviewer", task: "work" }) instanceof type.errors).toBe(false);
	});
});
