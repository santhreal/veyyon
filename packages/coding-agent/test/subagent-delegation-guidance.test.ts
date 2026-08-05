import { describe, expect, it } from "bun:test";
import type { SystemPromptToolMetadata } from "@veyyon/coding-agent/system-prompt";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

const taskTools = new Map<string, SystemPromptToolMetadata>([
	[
		"task",
		{
			label: "Task",
			description: "Delegate work to enabled subagents.",
			parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } } },
		},
	],
]);

async function renderDelegationPrompt(taskAgentsAvailable: boolean): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/tmp/delegation-guidance",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["task"],
		tools: taskTools,
		workspaceTree: {
			rootPath: "/tmp/delegation-guidance",
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		nativeTools: true,
		inlineToolDescriptors: false,
		eagerTasks: true,
		subagentNames: taskAgentsAvailable ? ["task"] : [],
	});
	return systemPrompt.join("\n\n");
}

describe("effective-agent delegation guidance", () => {
	/** Prevents the base prompt from requiring a task call that every effective catalog entry rejects. */
	it("suppresses all delegation mandates when no subagent type is executable", async () => {
		const rendered = await renderDelegationPrompt(false);

		expect(rendered).not.toContain("# Delegation");
		expect(rendered).not.toContain("Enabled roles (`task`)");
		expect(rendered).not.toContain("use `task` as the general-purpose fallback");
	});

	/** Proves the same task-equipped prompt restores both explicit-parallel and general delegation policy when usable. */
	it("renders delegation mandates when at least one subagent type is executable", async () => {
		const rendered = await renderDelegationPrompt(true);

		expect(rendered).toContain("# Delegation");
		expect(rendered).toContain("Enabled roles (`task`)");
		expect(rendered).toContain("use `task` as the general-purpose fallback");
	});

	/** Keeps the cache-stable base section generic so changing the enabled agent identity cannot leak names into it. */
	it("contains no catalog-specific agent names in base delegation guidance", async () => {
		const rendered = await renderDelegationPrompt(true);
		expect(rendered).not.toContain("scout");
		expect(rendered).not.toContain("reviewer");
		expect(rendered).not.toContain("designer");
	});
});
