import { AgentRegistry } from "../registry/agent-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

/**
 * Running spawns to badge in the status line, for ONE conversation.
 *
 * `scope` is the driving session's id. A collab guest passes none: its registry
 * is a mirror of the host's single conversation and carries no local scope.
 *
 * `under` is the agent the view is currently focused on, and narrows the count
 * to that agent's spawn subtree. Unfocused, the whole conversation is the
 * subtree the operator is looking at, so the parameter is omitted.
 */
export function countRunningSubagentBadgeAgents(registry: AgentRegistry, scope?: string, under?: string): number {
	return registry.runningSubagentCount(scope, under);
}
