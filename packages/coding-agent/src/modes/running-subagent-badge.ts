import { AgentRegistry } from "../registry/agent-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

/** Running spawns to badge in the status line, for ONE conversation. `scope` is the driving session's id. A collab guest passes none: its registry */
export function countRunningSubagentBadgeAgents(registry: AgentRegistry, scope?: string, under?: string): number {
	return registry.runningSubagentCount(scope, under);
}
