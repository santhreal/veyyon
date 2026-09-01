import type { AgentSession } from "./agent-session";

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

export type InteractiveSessionFactory = () => Promise<AgentSession>;

export interface KeptSession {
	readonly session: AgentSession;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly detachedAt: number;
	readonly handoff: number;
	readonly settled: Promise<void>;
}
