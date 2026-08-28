export type GithubCheckRunState = "success" | "failure" | "running" | "pending" | "unknown";

const SUCCESS_CONCLUSIONS: Record<string, true> = { success: true, neutral: true, skipped: true };
const FAILURE_CONCLUSIONS: Record<string, true> = {
	action_required: true,
	cancelled: true,
	failure: true,
	startup_failure: true,
	timed_out: true,
};
const RUNNING_STATUSES: Record<string, true> = { in_progress: true };
const PENDING_STATUSES: Record<string, true> = { pending: true, queued: true, requested: true, waiting: true };

export function classifyGithubCheckRun(
	status: string | null | undefined,
	conclusion: string | null | undefined,
): GithubCheckRunState {
	if (conclusion) {
		if (SUCCESS_CONCLUSIONS[conclusion]) return "success";
		if (FAILURE_CONCLUSIONS[conclusion]) return "failure";
	}
	if (status) {
		if (RUNNING_STATUSES[status]) return "running";
		if (PENDING_STATUSES[status]) return "pending";
	}
	return "unknown";
}

export function githubIssueRefNumber(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return undefined;
}
