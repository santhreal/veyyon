import { AgentRegistry } from "../../registry/agent-registry";

export interface RunningAgentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningAgentBadgeRegistry(collabGuest: RunningAgentRegistrySource | undefined): AgentRegistry {
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
export function countRunningAgentBadgeAgents(registry: AgentRegistry, scope?: string, under?: string): number {
	return registry.runningAgentCount(scope, under);
}
