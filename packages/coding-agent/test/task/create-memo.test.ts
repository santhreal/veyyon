import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { makeToolSession } from "../helpers/tool-session";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	});
}

describe("TaskTool.create discovery memo", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one discovery scan across repeated creations with the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp"));
		const second = await TaskTool.create(createSession("/tmp"));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.description).toBe(second.description);
	});

	it("rescans for a different cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		await TaskTool.create(createSession("/tmp/veyyon-memo-other"));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("does not cache a rejected discovery", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await expect(TaskTool.create(createSession("/tmp"))).rejects.toThrow("boom");
		const tool = await TaskTool.create(createSession("/tmp"));

		expect(tool.description).toContain("task");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
