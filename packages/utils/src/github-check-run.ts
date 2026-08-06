/**
 * The one owner of how a GitHub Actions check run is classified for display, and of how a
 * pull-request or issue reference is read back to its number.
 *
 * Both renderers of the `github` tool's output carried their own copy of these tables: the
 * terminal one in `coding-agent/src/tools/gh-renderer.ts` and the React one in
 * `tool-render/src/tools/github.tsx`. They had already drifted, the terminal side knowing a
 * `queued`/`requested`/`waiting`/`pending` group the React side did not, so the same run
 * showed a muted pending row in one view and the unknown-state fallback in the other.
 * Nothing reported the divergence, and adding a conclusion to one table would silently repeat
 * it. This file is dependency-free and holds no rendering decisions, only the vocabulary, so
 * the browser bundle can read it as safely as the terminal can.
 */

/**
 * What a run or job is doing, as far as anything that draws it needs to know. Every renderer
 * maps these five to its own icons and colors; the mapping is theirs, the classification is
 * not.
 */
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

/**
 * Classify one run or job. A `conclusion` wins over a `status`, because GitHub keeps reporting
 * the terminal status alongside the conclusion once a run finishes. Anything unrecognized is
 * `unknown` rather than a guess, so a new GitHub conclusion shows as unknown in every view at
 * once instead of green in one and grey in another.
 */
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

/**
 * The number in a pull-request or issue reference, as `#123`: a bare number, or a `.../pull/N`
 * or `.../issues/N` URL. Anything else (a branch name, a search query) is `undefined`, and
 * each caller decides how to show the literal it was given, because they cut it to different
 * widths.
 */
export function githubIssueRefNumber(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return undefined;
}
