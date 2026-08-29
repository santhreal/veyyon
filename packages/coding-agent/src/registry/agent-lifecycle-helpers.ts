import type { AgentSession } from "../session/agent-session";
import type { AgentRef } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;
export type PersistedSubagentIdleTtlResolver = (ref: AgentRef) => number;

export interface PersistedSubagentCloseBudget {
	parkedMs: number;
	waitingMs: number;
}
export type PersistedSubagentCloseBudgetResolver = (ref: AgentRef) => PersistedSubagentCloseBudget;

export interface AdoptOptions {
	idleTtlMs: number;
	closeParkedMs?: number;
	closeWaitingMs?: number;
	revive?: AgentReviver;
}

export interface AdoptedAgent {
	idleTtlMs: number;
	closeParkedMs: number;
	closeWaitingMs: number;
	revive?: AgentReviver;
	deadline?: number;
	stage?: "park" | "close";
}

export function arm(adopted: AdoptedAgent, at: number, stage: "park" | "close"): void {
	adopted.deadline = at;
	adopted.stage = stage;
}

export function disarm(adopted: AdoptedAgent): void {
	adopted.deadline = undefined;
	adopted.stage = undefined;
}

export function normalizeCloseBudgets(
	parkedMs: number | undefined,
	waitingMs: number | undefined,
): PersistedSubagentCloseBudget {
	const parked = Math.max(0, parkedMs ?? 0);
	return { parkedMs: parked, waitingMs: parked === 0 ? 0 : Math.max(parked, waitingMs ?? parked) };
}

export const REVIVE_RECHECK_MS = 1_000;
