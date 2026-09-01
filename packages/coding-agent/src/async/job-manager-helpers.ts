export const DELIVERY_RETRY_BASE_MS = 500;
export const DELIVERY_RETRY_MAX_MS = 30_000;
export const DELIVERY_RETRY_JITTER_MS = 200;
export const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_RUNNING_JOBS = 15;

export const POLL_WAIT_LADDER_MS = [30_000, 4 * 60_000] as const;
export const POLL_ESCALATION_RESET_MS = 60_000;

export interface PollEscalationState {
	level: number;
	lastPollEndAt: number;
}

export type AsyncJobType = "bash" | "task" | "launch";

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	ownerId?: string;
	agentId?: string;
	toolCallId?: string;
	queued?: boolean;
}

export interface AsyncJobManagerOptions {
	onJobComplete: (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;
	maxRunningJobs?: number;
	retentionMs?: number;
}

export interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	ownerId?: string;
	agentId?: string;
	toolCallId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	queued?: boolean;
}

export interface AsyncJobFilter {
	ownerId?: string;
}
