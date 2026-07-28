/**
 * What kind of work an agent is FOR, derived from the tools it grants.
 *
 * WHY THIS EXISTS. The delegation prose told the model to delegate audit work no matter which agents
 * were enabled. `delegation-subagent-value.md` shipped "Use `task` to map unknown code instead of
 * reading file after file yourself", "Delegate to keep bulk reading and long tool output out of this
 * conversation" and "multi-subsystem investigation" with no gate at all, and on a stock install the
 * only enabled bundled agent is `task`, whose own description is "General-purpose subagent with full
 * capabilities for delegated multi-step tasks". So the prompt routed exploration and review into a
 * WORKER. A task is actual work: running code, reads and writes, real changes. An audit is a different
 * kind of work, and when nothing is typed for it the honest answer is to do it inline rather than to
 * hand it to whatever agent happens to be enabled.
 *
 * DERIVED, NOT LISTED. The role comes from the agent's tool grant rather than from a roster of bundled
 * names, for two reasons. A hardcoded list is banned, and more usefully, a name list is a door a
 * user-authored agent can never walk through: someone who writes their own read-only reviewer under
 * `agents/` gets the right classification here for free, because their `tools:` line already says what
 * the agent is. See {@link WORKSPACE_WRITING_TOOL_NAMES} for why `bash` is not one of the deciding
 * tools, which is the entry that makes this classification match reality rather than fight it.
 *
 * NOT A SECURITY BOUNDARY. An investigative agent with `bash` can obviously write a file if it decides
 * to. This answers what the operator SET IT UP for, which is the question the prompt needs; enforcement
 * is the sandbox's job.
 */

import { isKnownToolName, isWorkspaceWritingTool } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";

/**
 * The two kinds of work a subagent is set up for.
 *
 * Two, not more, and specifically not one per bundled agent. The prompt asks exactly one question of
 * this axis: may audits and exploration be delegated, or do they stay inline. A third value would have
 * no reader and would invite the roster to be re-encoded here under another name.
 */
export type AgentRole =
	/** Reads, searches, reviews, reports. Grants no tool that edits the workspace. */
	| "investigative"
	/** Changes things: edits, writes, runs the work. Either grants an editing tool or restricts nothing. */
	| "executing";

/**
 * The role `agent` is set up for.
 *
 * AN AGENT THAT RESTRICTS NOTHING IS EXECUTING. `tools: undefined` means the full set, which includes
 * `edit` and `write`, so the absence of a `tools:` line is a grant of everything rather than a grant of
 * nothing. Reading it the other way round would classify `task`, `sonic` and `designer` as
 * investigative and switch audit delegation on for exactly the roster that must not have it, which is
 * the bug this module exists to fix, inverted.
 *
 * AND SO IS AN AGENT GRANTING A TOOL THIS BUILD DOES NOT SHIP. "Investigative" is a POSITIVE claim, and
 * the prompt spends it by telling the model to hand exploration and review to the named agent, so it
 * needs evidence for every granted tool rather than merely the absence of the five known writers. An
 * MCP or plugin tool's capabilities live in another process: `mcp__github__create_pull_request` and
 * `mcp__github__list_issues` are the same shape from here, and MCP servers routinely expose file
 * writes, commits and deploys. Treating an unrecognised name as harmless is the silent assumption that
 * this module exists to remove, one layer along, so an unknown tool means the role cannot be proven and
 * the answer is `executing`. The cost of failing this way is that a read-only agent built on an MCP
 * server is not ADVERTISED as read-only; the cost of failing the other way is telling the model to send
 * an audit to something that can push a branch.
 */
export function agentRole(agent: AgentDefinition): AgentRole {
	if (agent.tools === undefined) return "executing";
	for (const tool of agent.tools) {
		if (isWorkspaceWritingTool(tool)) return "executing";
		if (!isKnownToolName(tool)) return "executing";
	}
	return "investigative";
}

/** Whether `agent` is set up to investigate rather than to change things. */
export function isInvestigativeAgent(agent: AgentDefinition): boolean {
	return agentRole(agent) === "investigative";
}

/**
 * The investigative agents among `agents`, in the order given.
 *
 * Order is preserved because the prompt names them, and discovery order is the order the task tool's
 * description lists them in: a prompt that named them in a different order than the tool does reads as
 * two disagreeing sources.
 */
export function investigativeAgentNames(agents: readonly AgentDefinition[]): string[] {
	return agents.filter(isInvestigativeAgent).map(agent => agent.name);
}
