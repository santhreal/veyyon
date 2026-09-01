import type { AgentSession } from "../session/agent-session";

export const MAIN_AGENT_ID = "Main";

export function mainAgentIdFor(sessionId: string): string {
	return `main:${sessionId}`;
}

export const AGENT_STATUSES = ["running", "idle", "parked", "aborted"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentKind = "main" | "sub" | "advisor";

export interface PendingApproval {
	toolName: string;
	reason?: string;
	since: number;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	scope?: string;
	activity?: string;
	model?: string;
	waitingOnPeer?: boolean;
	pendingApproval?: PendingApproval;
	approvalWaitedMs?: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

export type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	scope?: string;
	status?: AgentStatus;
	model?: string;
}
