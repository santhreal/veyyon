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

async function renderDelegationPrompt(subagentNames: string[]): Promise<string> {
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
		subagentNames,
	});
	return systemPrompt.join("\n\n");
}

describe("effective-agent delegation guidance", () => {
	/** Prevents the base prompt from requiring a task call that every effective catalog entry rejects. */
	it("suppresses all delegation mandates when no subagent type is executable", async () => {
		const rendered = await renderDelegationPrompt([]);

		expect(rendered).not.toContain("# Delegation");
		expect(rendered).not.toContain("Enabled agent types: `task`");
	});

	/** Proves the same task-equipped prompt restores both explicit-parallel and general delegation policy when usable. */
	it("renders delegation mandates when at least one subagent type is executable", async () => {
		const rendered = await renderDelegationPrompt(["task"]);

		expect(rendered).toContain("# Delegation");
		expect(rendered).toContain("Enabled agent types: `task`");
	});

	/** Keeps the cache-stable base section generic so changing the enabled agent identity cannot leak names into it. */
	it("contains no catalog-specific agent names in base delegation guidance", async () => {
		const rendered = await renderDelegationPrompt(["task"]);
		expect(rendered).not.toContain("scout");
		expect(rendered).not.toContain("reviewer");
		expect(rendered).not.toContain("designer");
	});

	/**
	 * Locks out the inverted routing rule: the prompt used to send unmatched work UP to `task`
	 * whenever no other type matched, so disabling a cheap narrow type did not remove its work,
	 * it silently promoted that work to the widest and most expensive agent. Unmatched work now
	 * stays inline, and a roster without `task` must never name `task` as somewhere to send it.
	 *
	 * The naming clause ("The `task` tool describes what each type is for") is the one legitimate
	 * mention, so it is cut before the assertion: what must be free of `task` is the routing
	 * guidance that tells the model where unmatched work goes.
	 */
	it("keeps unmatched work inline instead of promoting it to task", async () => {
		const rendered = await renderDelegationPrompt(["designer"]);
		const bullet = rendered.split("\n").find((line) => line.startsWith("- **Match the type")) ?? "";
		const routing = bullet.split("The `task` tool describes what each type is for.").at(-1) ?? "";

		expect(bullet).toContain("Enabled agent types: `designer`");
		expect(routing).toContain("when none covers it, do the work inline");
		expect(routing).not.toContain("`task`");
	});
});
