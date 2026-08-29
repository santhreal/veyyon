import type { AgentProgress } from "../task/types";

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	progress?: AgentProgress;
}

export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";

export const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};
