import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@veyyon/coding-agent/task";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("disables read summarization for scout and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
});
