import { type } from "arktype";
import type { AsyncJobType } from "../async";

export const jobSchema = type({
	"poll?": type("string[]").describe("job ids to wait for; omit to wait on all running jobs"),
	"cancel?": type("string[]").describe("job ids to cancel"),
	"list?": type("boolean").describe("snapshot all jobs"),
});

export type JobParams = typeof jobSchema.infer;

export const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

export function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

export interface JobSnapshot {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

export type CancelStatus = "cancelled" | "not_found" | "already_completed";

export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	activity?: string;
	ageMs: number;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	agents?: AgentActivitySnapshot[];
}

export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as JobToolDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
