import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";

import {
	clamp,
	DAY_MS,
	errorMessage,
	getWorktreeDir,
	HOUR_MS,
	hashPath,
	isDateOnly,
	isEnoent,
	nonEmptyTrimmed,
	prompt,
	removeTempPath,
	untilAborted,
	WEEK_MS,
} from "@veyyon/utils";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { abortedPartway } from "./aborted-partway";
import {
	GH_PR_FIELDS_NO_COMMENTS,
	type GhPrViewData,
	type GhRepoViewData,
	resolveDefaultRepoMemoized,
} from "./gh-fetch";
import {
	appendRepoFlag,
	formatAuthor,
	formatLabels,
	formatShortSha,
	type GhLabel,
	type GhUser,
	normalizeBlock,
	normalizeOptionalString,
	normalizeText,
	pushLine,
	requireNonEmpty,
} from "./gh-format";

export type {
	GhIssueViewData,
	GhPrViewData,
	IssueViewLookupOptions,
	PrDiffFile,
	PrDiffLookupOptions,
	PrDiffPayload,
	PrViewLookupOptions,
	ViewLookupResult,
} from "./gh-fetch";
/**
 * The fetchers moved to `./gh-fetch`, which imports neither the prompt registry nor this tool. Every
 * name is re-exported here because the `github` tool was their only public home for a long time and
 * `tools/gh-renderer.ts` and the tests still name it. See that module's header for the split.
 */
export {
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	parsePrUnifiedDiff,
	resolveDefaultRepoMemoized,
} from "./gh-fetch";
export { parsePositiveDecimalInt } from "./gh-format";

import { parsePrUrl } from "./gh-url";
import { invalidateAllForNumber } from "./github-cache";
import { saveOutputArtifact } from "./output-artifact";
import type { OutputMeta } from "./output-meta";
import { type ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];

const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];
const GH_PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
];
// /search/<endpoint> API response shapes (subset). Used when projecting raw
// REST results into the normalized `GhSearch*Result` shapes the formatters
// consume. We talk to the API directly because `gh search prs`/`issues`
// quotes multi-token positional queries (`is:"merged is:pr"`) and returns 0
// hits — see https://github.com/cli/cli for the upstream regression.
interface GhApiSearchResponse<T> {
	total_count?: number;
	incomplete_results?: boolean;
	items?: T[];
}
interface GhApiUser {
	login?: string;
	name?: string | null;
}
interface GhApiLabel {
	name?: string;
}
interface GhApiPullRequestRef {
	merged_at?: string | null;
}
interface GhApiSearchIssueItem {
	number?: number;
	title?: string;
	state?: string;
	state_reason?: string | null;
	user?: GhApiUser | null;
	labels?: GhApiLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
	repository_url?: string;
	pull_request?: GhApiPullRequestRef | null;
}
interface GhApiSearchCodeItem {
	name?: string;
	path?: string;
	sha?: string;
	html_url?: string;
	repository?: { full_name?: string } | null;
	text_matches?: Array<{ fragment?: string; property?: string }>;
}
interface GhApiSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}
interface GhApiSearchCommitItem {
	sha?: string;
	node_id?: string;
	html_url?: string;
	author?: GhApiUser | null;
	committer?: GhApiUser | null;
	commit?: {
		author?: GhApiSearchCommitGitActor | null;
		committer?: GhApiSearchCommitGitActor | null;
		message?: string;
	} | null;
	repository?: { full_name?: string } | null;
}
interface GhApiSearchRepoItem {
	full_name?: string;
	description?: string | null;
	language?: string | null;
	stargazers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	archived?: boolean;
	fork?: boolean;
	private?: boolean;
	visibility?: string | null;
	updated_at?: string;
	created_at?: string;
	html_url?: string;
	owner?: GhApiUser | null;
}
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const RUN_WATCH_INTERVAL_DEFAULT = 3;
const RUN_WATCH_INTERVAL_SLOW = 15;
const RUN_WATCH_FAST_WINDOW_MS = 60_000;
const RUN_WATCH_NO_RUNS_GIVE_UP_MS = 90_000;
const RUN_WATCH_MAX_POLL_FAILURES = 5;
const RUN_WATCH_GRACE_DEFAULT = 5;
const RUN_WATCH_TAIL_DEFAULT = 15;
const RUN_WATCH_TAIL_MAX = 200;
const RUN_JOBS_PAGE_SIZE = 100;
const RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RUN_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const GITHUB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

const githubSchema = type({
	op: type(
		"'repo_view' | 'pr_create' | 'pr_checkout' | 'pr_push' | 'search_issues' | 'search_prs' | 'search_code' | 'search_commits' | 'search_repos' | 'run_watch'",
	).describe("github operation"),
	"repo?": type("string").describe("owner/repo"),
	"branch?": type("string").describe("branch"),
	"pr?": type("string | string[]").describe("pr number, url, or branch"),
	"force?": type("boolean").describe("reset existing local branch"),
	"forceWithLease?": type("boolean").describe("force-with-lease push"),
	"title?": type("string").describe("pr title"),
	"body?": type("string").describe("pr body markdown"),
	"base?": type("string").describe("pr base branch"),
	"head?": type("string").describe("pr head branch"),
	"draft?": type("boolean").describe("open pr as draft"),
	"fill?": type("boolean").describe("auto-fill pr title/body from commits"),
	"reviewer?": type("string[]").describe("reviewers"),
	"assignee?": type("string[]").describe("assignees"),
	"label?": type("string[]").describe("labels"),
	"query?": type("string").describe("search query"),
	"since?": type("string").describe("lower-bound date filter"),
	"until?": type("string").describe("upper-bound date filter"),
	"dateField?": type("'created' | 'updated'").describe("date field"),
	"limit?": type("number").describe("max results"),
	"run?": type("string").describe("actions run id or url"),
	"tail?": type("number").describe("log lines per failed job"),
});

type GithubInput = typeof githubSchema.infer;

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

interface GhBranchApiResponse {
	commit?: {
		sha?: string | null;
	} | null;
}

interface GhSearchRepository {
	nameWithOwner?: string;
}

interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhSearchCodeTextMatch {
	fragment?: string;
	property?: string;
}

interface GhSearchCodeResult {
	path?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	textMatches?: GhSearchCodeTextMatch[];
	url?: string;
}

interface GhSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

interface GhSearchCommitDetail {
	author?: GhSearchCommitGitActor | null;
	committer?: GhSearchCommitGitActor | null;
	message?: string;
}

interface GhSearchCommitResult {
	author?: GhUser | null;
	commit?: GhSearchCommitDetail | null;
	committer?: GhUser | null;
	id?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	url?: string;
}

interface GhSearchRepoResult {
	createdAt?: string;
	description?: string | null;
	forksCount?: number;
	fullName?: string;
	isArchived?: boolean;
	isFork?: boolean;
	isPrivate?: boolean;
	language?: string | null;
	openIssuesCount?: number;
	owner?: GhUser | null;
	stargazersCount?: number;
	updatedAt?: string;
	url?: string;
	visibility?: string | null;
}

interface GhRunReference {
	repo?: string;
	runId?: number;
}

interface GhActionsRunListResponse {
	workflow_runs?: GhActionsRunApi[];
}

interface GhActionsRunApi {
	id?: number;
	name?: string | null;
	display_title?: string | null;
	status?: string | null;
	conclusion?: string | null;
	head_branch?: string | null;
	head_sha?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	html_url?: string | null;
}

interface GhActionsJobsResponse {
	total_count?: number;
	jobs?: GhActionsJobApi[];
}

interface GhActionsJobApi {
	id?: number;
	name?: string | null;
	status?: string | null;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	html_url?: string | null;
}

interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

function normalizePrIdentifierList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return nonEmptyTrimmed(typeof value === "string" ? [value] : value);
}

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit must be a positive number");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

/** @internal Exported for testing. */
export function resolveTailLimit(value: number | undefined): number {
	if (value === undefined) {
		return RUN_WATCH_TAIL_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("tail must be a positive number");
	}

	// Floor to a whole line count but never below 1. A fractional request in
	// (0, 1) floors to 0, and `tailLogLines` does `lines.slice(-tail)`, where
	// `slice(-0)` is `slice(0)` — it would return the ENTIRE log where a tiny
	// tail was asked for. Clamp up so any positive tail yields at least one line.
	return clamp(Math.floor(value), 1, RUN_WATCH_TAIL_MAX);
}

const REPO_API_URL_PREFIX = "https://api.github.com/repos/";

const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const FIXED_UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: HOUR_MS,
	d: DAY_MS,
	w: WEEK_MS,
};

/**
 * Resolve a search date bound to a GitHub-search-compatible literal. Returns
 * either a `YYYY-MM-DD` date (relative durations and date-only inputs) or a
 * full ISO 8601 datetime string (datetime inputs), so the caller can drop it
 * straight into a qualifier like `created:>=<value>`.
 */
export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new ToolError("date bound must not be empty");
	}

	const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
	if (relMatch) {
		const count = Number(relMatch[1]);
		const unit = relMatch[2].toLowerCase();
		const fixedMs = FIXED_UNIT_MS[unit];
		let bound: Date;
		if (fixedMs !== undefined) {
			bound = new Date(now.getTime() - count * fixedMs);
		} else {
			bound = new Date(now);
			if (unit === "mo") {
				bound.setUTCMonth(bound.getUTCMonth() - count);
			} else {
				bound.setUTCFullYear(bound.getUTCFullYear() - count);
			}
		}
		return bound.toISOString().slice(0, 10);
	}

	if (isDateOnly(trimmed)) {
		return trimmed;
	}

	const parsedMs = Date.parse(trimmed);
	if (!Number.isNaN(parsedMs)) {
		// GitHub search qualifiers accept seconds precision only
		// (`YYYY-MM-DDTHH:MM:SSZ`); strip the milliseconds toISOString emits.
		return new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	throw new ToolError(
		`invalid date bound: ${raw}. Expected a relative duration like "3d", "12h", "2w", an ISO date "YYYY-MM-DD", or an ISO datetime.`,
	);
}

/**
 * Build the GitHub-search qualifier (e.g. `created:>=2026-05-09`) for the
 * provided bounds, or `undefined` if neither bound is set.
 */
export function buildSearchDateQualifier(
	field: string,
	since: string | undefined,
	until: string | undefined,
	now?: Date,
): string | undefined {
	const sinceVal = since ? parseSearchDateBound(since, now) : undefined;
	const untilVal = until ? parseSearchDateBound(until, now) : undefined;
	if (sinceVal && untilVal) {
		return `${field}:${sinceVal}..${untilVal}`;
	}
	if (sinceVal) {
		return `${field}:>=${sinceVal}`;
	}
	if (untilVal) {
		return `${field}:<=${untilVal}`;
	}
	return undefined;
}

function resolveSearchDateField(
	command: "issues" | "prs" | "commits" | "repos",
	requested: "created" | "updated" | undefined,
): string {
	if (command === "commits") {
		return "committer-date";
	}
	const dateField = requested ?? "created";
	if (command === "repos" && dateField === "updated") {
		return "pushed";
	}
	return dateField;
}

function composeSearchQuery(parts: ReadonlyArray<string | undefined>): string {
	const cleaned = nonEmptyTrimmed(parts);
	if (cleaned.length === 0) {
		throw new ToolError("query is required (or pass since/until to filter by date)");
	}
	return cleaned.join(" ");
}

function buildGhApiSearchArgs(
	endpoint: "issues" | "code" | "commits" | "repositories",
	query: string,
	limit: number,
	extraHeaders?: ReadonlyArray<string>,
): string[] {
	const args = ["api", "-X", "GET", `/search/${endpoint}`, "-f", `q=${query}`, "-F", `per_page=${limit}`];
	for (const header of extraHeaders ?? []) {
		args.push("-H", header);
	}
	return args;
}

function repoFromRepositoryUrl(value: string | undefined): string | undefined {
	if (!value?.startsWith(REPO_API_URL_PREFIX)) return undefined;
	return value.slice(REPO_API_URL_PREFIX.length);
}

function githubRepoSlugEquals(left: string | undefined, right: string): boolean {
	if (left === undefined || left.length !== right.length) return false;
	for (let idx = 0; idx < left.length; idx += 1) {
		let leftCode = left.charCodeAt(idx);
		let rightCode = right.charCodeAt(idx);
		if (leftCode >= 65 && leftCode <= 90) leftCode += 32;
		if (rightCode >= 65 && rightCode <= 90) rightCode += 32;
		if (leftCode !== rightCode) return false;
	}
	return true;
}

function apiUserToGhUser(user: GhApiUser | null | undefined): GhUser | undefined {
	if (!user) return undefined;
	const login = user.login ?? undefined;
	const name = user.name ?? undefined;
	if (login === undefined && name === undefined) return undefined;
	return { login, name };
}

function apiLabelsToGhLabels(labels: GhApiLabel[] | undefined): GhLabel[] {
	return labels?.map(label => ({ name: label.name })) ?? [];
}

function apiIssueToSearchResult(item: GhApiSearchIssueItem): GhSearchResult {
	const merged = Boolean(item.pull_request?.merged_at);
	return {
		author: apiUserToGhUser(item.user) ?? null,
		createdAt: item.created_at,
		labels: apiLabelsToGhLabels(item.labels),
		number: item.number,
		repository: { nameWithOwner: repoFromRepositoryUrl(item.repository_url) },
		state: merged ? "merged" : item.state,
		title: item.title,
		updatedAt: item.updated_at,
		url: item.html_url,
	};
}

function apiCodeToSearchResult(item: GhApiSearchCodeItem): GhSearchCodeResult {
	return {
		path: item.path,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		textMatches: item.text_matches?.map(match => ({ fragment: match.fragment, property: match.property })),
		url: item.html_url,
	};
}

function apiCommitToSearchResult(item: GhApiSearchCommitItem): GhSearchCommitResult {
	return {
		author: apiUserToGhUser(item.author) ?? null,
		commit: item.commit
			? {
					author: item.commit.author ?? null,
					committer: item.commit.committer ?? null,
					message: item.commit.message,
				}
			: null,
		committer: apiUserToGhUser(item.committer) ?? null,
		id: item.node_id,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		url: item.html_url,
	};
}

function apiRepoToSearchResult(item: GhApiSearchRepoItem): GhSearchRepoResult {
	return {
		createdAt: item.created_at,
		description: item.description,
		forksCount: item.forks_count,
		fullName: item.full_name,
		isArchived: item.archived,
		isFork: item.fork,
		isPrivate: item.private,
		language: item.language,
		openIssuesCount: item.open_issues_count,
		owner: apiUserToGhUser(item.owner) ?? null,
		stargazersCount: item.stargazers_count,
		updatedAt: item.updated_at,
		url: item.html_url,
		visibility: item.visibility ?? null,
	};
}

function sanitizeRemoteName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized.length > 0 ? `fork-${sanitized}` : "fork";
}

/** Maximum disambiguation suffixes we try before giving up on a worktree path. */
const WORKTREE_PATH_MAX_SUFFIX = 100;

function toLocalBranchRef(value: string): string {
	return `refs/heads/${value}`;
}

async function requireGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(cwd, signal);
	if (!repoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return repoRoot;
}

async function requirePrimaryGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const primaryRepoRoot = await git.repo.primaryRoot(cwd, signal);
	if (!primaryRepoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return primaryRepoRoot;
}

async function requireCurrentGitBranch(cwd: string, signal?: AbortSignal): Promise<string> {
	const branch = await git.branch.current(cwd, signal);
	if (!branch) {
		throw new ToolError("Current git branch is unavailable. Pass `branch` or `run` explicitly.");
	}

	return branch;
}

async function requireCurrentGitHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const headSha = await git.head.sha(cwd, signal);
	if (!headSha) {
		throw new ToolError("Current git HEAD is unavailable. Pass `run` explicitly.");
	}

	return headSha;
}

/**
 * Resolve a worktree path that is free of conflicts.
 *
 * Given a `basePath`, return either `basePath` itself or `${basePath}-2`,
 * `${basePath}-3`, … up to {@link WORKTREE_PATH_MAX_SUFFIX} — whichever is the
 * first variant that is **not** registered with git as another worktree and
 * **not** present on disk. The numeric tail salvages two rare cases that
 * would otherwise abort a checkout: stale leftover dirs from an interrupted
 * `git worktree add`, and the (vanishingly unlikely) `hashPath` collision
 * between two repos that happen to produce the same 7-hex digest.
 */
async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) {
				return candidate;
			}
			throw error;
		}
	}
	throw new ToolError(
		`could not find an unused worktree path under ${basePath} (tried ${WORKTREE_PATH_MAX_SUFFIX} suffixes)`,
	);
}

function selectPrCloneUrl(originUrl: string | undefined, repo: Pick<GhRepoViewData, "url" | "sshUrl">): string {
	if (originUrl?.startsWith("http://") || originUrl?.startsWith("https://")) {
		return normalizeOptionalString(repo.url) ?? normalizeOptionalString(repo.sshUrl) ?? "";
	}

	return normalizeOptionalString(repo.sshUrl) ?? normalizeOptionalString(repo.url) ?? "";
}

async function getRemoteUrls(repoRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const remotes = await git.remote.list(repoRoot, signal);
	const urls = new Map<string, string>();
	for (const remoteName of remotes) {
		const remoteUrl = await git.remote.url(repoRoot, remoteName, signal);
		if (remoteUrl) {
			urls.set(remoteName, remoteUrl);
		}
	}
	return urls;
}

async function ensurePrRemote(
	repoRoot: string,
	data: GhPrViewData,
	signal?: AbortSignal,
): Promise<{ name: string; url: string }> {
	if (!data.isCrossRepository) {
		const originUrl = await git.remote.url(repoRoot, "origin", signal);
		if (!originUrl) {
			throw new ToolError("origin remote is unavailable for this repository.");
		}

		return {
			name: "origin",
			url: originUrl,
		};
	}

	const headRepository = requireNonEmpty(data.headRepository?.nameWithOwner, "head repository");
	const repoSummary = await git.github.json<GhRepoViewData>(
		repoRoot,
		["repo", "view", headRepository, "--json", GH_REPO_CLONE_FIELDS.join(",")],
		signal,
		{ repoProvided: true },
	);
	const originUrl = await git.remote.url(repoRoot, "origin", signal);
	const remoteUrl = selectPrCloneUrl(originUrl, repoSummary);
	if (!remoteUrl) {
		throw new ToolError(`Could not determine a clone URL for ${headRepository}.`);
	}

	const remotes = await getRemoteUrls(repoRoot, signal);
	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) {
			return { name: remoteName, url };
		}
	}

	const preferredRemoteName = sanitizeRemoteName(
		data.headRepositoryOwner?.login ?? headRepository.split("/")[0] ?? "fork",
	);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}

	await git.remote.add(repoRoot, remoteName, remoteUrl, signal);

	return {
		name: remoteName,
		url: remoteUrl,
	};
}

/**
 * Read branch-scoped PR-checkout metadata. New checkouts write `veyyonPr*`
 * keys; `ompPr*` is consulted as the pre-rebrand fallback so branches checked
 * out by older builds keep their push metadata.
 */
async function getBranchPrMeta(
	repoRoot: string,
	localBranch: string,
	key: "PrHeadRef" | "PrUrl" | "PrMaintainerCanModify" | "PrIsCrossRepository",
	signal?: AbortSignal,
): Promise<string | undefined> {
	return (
		(await git.config.getBranch(repoRoot, localBranch, `veyyon${key}`, signal)) ??
		(await git.config.getBranch(repoRoot, localBranch, `omp${key}`, signal))
	);
}

async function resolvePrBranchPushTarget(
	repoRoot: string,
	localBranch: string,
	signal?: AbortSignal,
): Promise<{
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	maintainerCanModify?: boolean;
	isCrossRepository: boolean;
}> {
	const headRef = await getBranchPrMeta(repoRoot, localBranch, "PrHeadRef", signal);
	if (!headRef) {
		throw new ToolError(`branch ${localBranch} has no PR push metadata; check it out via op: pr_checkout first`);
	}

	const pushRemote = await git.config.getBranch(repoRoot, localBranch, "pushRemote", signal);
	const remote = await git.config.getBranch(repoRoot, localBranch, "remote", signal);
	const prUrl = await getBranchPrMeta(repoRoot, localBranch, "PrUrl", signal);
	const maintainerCanModifyValue = await getBranchPrMeta(repoRoot, localBranch, "PrMaintainerCanModify", signal);
	const isCrossRepositoryValue = await getBranchPrMeta(repoRoot, localBranch, "PrIsCrossRepository", signal);

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`branch ${localBranch} has no configured push remote`);
	}

	return {
		remoteName,
		remoteBranch: headRef,
		remoteUrl: await git.remote.url(repoRoot, remoteName, signal),
		prUrl,
		maintainerCanModify:
			maintainerCanModifyValue === undefined
				? undefined
				: ["1", "true", "yes", "on"].includes(maintainerCanModifyValue.toLowerCase()),
		isCrossRepository: ["1", "true", "yes", "on"].includes((isCrossRepositoryValue ?? "").toLowerCase()),
	};
}

function parseRunReference(value: string | undefined): GhRunReference {
	const run = normalizeOptionalString(value);
	if (!run) {
		return {};
	}

	if (/^\d+$/.test(run)) {
		return { runId: Number(run) };
	}

	const match = run.match(RUN_URL_PATTERN);
	if (!match) {
		throw new ToolError("run must be a numeric workflow run ID or a full GitHub Actions run URL");
	}

	return {
		repo: match[1],
		runId: Number(match[2]),
	};
}

function normalizeRunJob(job: GhActionsJobApi): GhRunJobSnapshot | null {
	if (typeof job.id !== "number") {
		return null;
	}

	return {
		id: job.id,
		name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
		status: normalizeOptionalString(job.status),
		conclusion: normalizeOptionalString(job.conclusion),
		startedAt: normalizeOptionalString(job.started_at),
		completedAt: normalizeOptionalString(job.completed_at),
		url: normalizeOptionalString(job.html_url),
	};
}

function normalizeRunSnapshot(run: GhActionsRunApi, jobs: GhRunJobSnapshot[]): GhRunSnapshot {
	if (typeof run.id !== "number") {
		throw new ToolError("GitHub Actions run response did not include a run ID.");
	}

	return {
		id: run.id,
		workflowName: normalizeOptionalString(run.name),
		displayTitle: normalizeOptionalString(run.display_title),
		status: normalizeOptionalString(run.status),
		conclusion: normalizeOptionalString(run.conclusion),
		branch: normalizeOptionalString(run.head_branch),
		headSha: normalizeOptionalString(run.head_sha),
		createdAt: normalizeOptionalString(run.created_at),
		updatedAt: normalizeOptionalString(run.updated_at),
		url: normalizeOptionalString(run.html_url),
		jobs,
	};
}

function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
	if (!value) {
		return "pending";
	}

	if (RUN_SUCCESS_CONCLUSIONS.has(value)) {
		return "success";
	}

	if (RUN_FAILURE_CONCLUSIONS.has(value)) {
		return "failure";
	}

	return "pending";
}

function getRunSnapshotOutcome(run: GhRunSnapshot): "success" | "failure" | "pending" {
	if (run.status !== "completed") {
		return "pending";
	}

	return getRunOutcome(run.conclusion);
}

function getRunCollectionOutcome(runs: GhRunSnapshot[]): "success" | "failure" | "pending" {
	if (runs.length === 0) {
		return "pending";
	}

	let pending = false;
	for (const run of runs) {
		if (run.jobs.some(isFailedJob)) {
			return "failure";
		}

		const outcome = getRunSnapshotOutcome(run);
		if (outcome === "failure") {
			return "failure";
		}
		if (outcome === "pending") {
			pending = true;
		}
	}

	return pending ? "pending" : "success";
}

function getRunCollectionSignature(runs: GhRunSnapshot[]): string {
	return runs
		.map(run => run.id)
		.sort((left, right) => left - right)
		.join(",");
}

function isFailedJob(job: GhRunJobSnapshot): boolean {
	return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

const GH_RATE_LIMIT_ERROR_PATTERN = /rate limit|HTTP 429|abuse detection/i;

/**
 * Rate-limit / secondary-limit gh failures are transient; the run_watch poll
 * loops back off and retry them instead of discarding the whole watch.
 */
function isRateLimitedGhError(err: unknown): boolean {
	return err instanceof ToolError && GH_RATE_LIMIT_ERROR_PATTERN.test(err.message);
}

function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getJobDurationSeconds(job: GhRunJobSnapshot, observedAtMs: number): number | undefined {
	const startedAtMs = parseTimestampMs(job.startedAt);
	if (startedAtMs === undefined) {
		return undefined;
	}

	const completedAtMs = parseTimestampMs(job.completedAt) ?? observedAtMs;
	return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}

function buildRunWatchJobDetails(job: GhRunJobSnapshot, observedAtMs: number): GhRunWatchJobDetails {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion,
		durationSeconds: getJobDurationSeconds(job, observedAtMs),
		url: job.url,
	};
}

function buildRunWatchRunDetails(run: GhRunSnapshot, observedAtMs: number): GhRunWatchRunDetails {
	return {
		id: run.id,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.branch,
		headSha: run.headSha,
		url: run.url,
		jobs: run.jobs.map(job => buildRunWatchJobDetails(job, observedAtMs)),
	};
}

function buildFailedLogDetails(failedJobLogs: GhFailedJobLog[]): GhRunWatchFailedLogDetails[] {
	return failedJobLogs.map(entry => ({
		runId: entry.run.id,
		workflowName: entry.run.workflowName,
		jobName: entry.job.name,
		conclusion: entry.job.conclusion,
		tail: entry.tail,
		available: entry.available,
	}));
}

function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

function formatRunWatchSnapshot(
	repo: string,
	run: GhRunSnapshot,
	pollCount: number,
	note?: string,
	includeOutcome: boolean = false,
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# Watching GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (includeOutcome) {
		lines.push("");
		lines.push(failedJobs.length > 0 ? "Failures detected." : "All jobs passed.");
	}

	return lines.join("\n").trim();
}

function formatRunWatchResult(
	repo: string,
	run: GhRunSnapshot,
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (failedJobs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Run failed.");
	} else if (getRunOutcome(run.conclusion) === "success") {
		lines.push("");
		lines.push("All jobs passed.");
	} else {
		lines.push("");
		lines.push("Run completed without successful jobs, but no failed job logs were available.");
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchSnapshot(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	pollCount: number,
	note?: string,
): string {
	const failedJobs = runs.flatMap(run => run.jobs.filter(isFailedJob));
	const completedRuns = runs.filter(run => run.status === "completed").length;
	const lines: string[] = [`# Watching GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Runs", runs.length);
	pushLine(lines, "Completed runs", `${completedRuns}/${runs.length}`);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	if (runs.length === 0) {
		lines.push("");
		lines.push("Waiting for workflow runs for this commit.");
		return lines.join("\n").trim();
	}

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchResult(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const outcome = getRunCollectionOutcome(runs);
	const lines: string[] = [`# GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Runs", runs.length);

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	if (failedJobLogs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Workflow runs for this commit failed.");
	} else if (outcome === "success") {
		lines.push("");
		lines.push("All workflow runs for this commit passed.");
	} else {
		lines.push("");
		lines.push("Workflow runs for this commit did not complete successfully.");
	}

	return lines.join("\n").trim();
}

function buildGhDetails(repo: string, run: GhRunSnapshot): GhToolDetails {
	return {
		repo,
		branch: run.branch,
		headSha: run.headSha,
		runId: run.id,
		runIds: [run.id],
		status: run.status,
		conclusion: run.conclusion,
		failedJobs: run.jobs.filter(isFailedJob).map(job => job.name),
	};
}

function buildRunWatchDetails(
	repo: string,
	run: GhRunSnapshot,
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhDetails(repo, run),
		watch: {
			mode: "run",
			state: options?.state ?? "completed",
			repo,
			branch: run.branch,
			headSha: run.headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			run: buildRunWatchRunDetails(run, observedAtMs),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

function buildGhRunCollectionDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
): GhToolDetails {
	const outcome = getRunCollectionOutcome(runs);
	return {
		repo,
		branch,
		headSha,
		runIds: runs.map(run => run.id),
		status: runs.length > 0 && runs.every(run => run.status === "completed") ? "completed" : "in_progress",
		conclusion: outcome,
		failedJobs: runs.flatMap(run =>
			run.jobs.filter(isFailedJob).map(job => `${run.workflowName ?? `run ${run.id}`}: ${job.name}`),
		),
	};
}

function buildCommitRunWatchDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhRunCollectionDetails(repo, headSha, branch, runs),
		watch: {
			mode: "commit",
			state: options?.state ?? "completed",
			repo,
			branch,
			headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			runs: runs.map(run => buildRunWatchRunDetails(run, observedAtMs)),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

async function resolveGitHubRepo(
	cwd: string,
	repo: string | undefined,
	runRepo: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (repo && runRepo && !githubRepoSlugEquals(repo, runRepo)) {
		throw new ToolError("run URL repository does not match the provided repo");
	}

	if (repo) {
		return repo;
	}

	if (runRepo) {
		return runRepo;
	}

	const resolved = await git.github.text(
		cwd,
		["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
		signal,
	);
	return requireNonEmpty(resolved, "repo");
}

/**
 * Best-effort cached cwd → `owner/repo` resolution that swallows any failure
 * (not a git checkout, no GitHub remote, `gh` unauthenticated, …) into
 * `undefined`. Use where the cwd repo is a convenience fallback, not a safety
 * check.
 */
async function tryResolveCurrentRepo(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveDefaultRepoMemoized(cwd, signal);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort fresh cwd → `owner/repo` resolution for safety checks that must
 * reflect the repository currently mounted at `cwd`, not the process-lifetime
 * default-repo cache.
 */
async function tryResolveCurrentRepoFresh(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveGitHubRepo(cwd, undefined, undefined, signal);
	} catch {
		// Undefined does not go unnoticed: the one caller compares it against the explicit `repo` and throws a
		// ToolError naming "not a GitHub repository", so an unresolvable cwd fails CLOSED rather than letting a
		// watch stream a confident wrong-repo status. Reporting here as well would say it twice.
		return undefined;
	}
}

/**
 * Matches search-query qualifiers that already scope to a repository, org, or
 * user. When present, callers should avoid layering a default `repo:<current>`
 * on top — the user has already expressed an explicit scope.
 *
 * Only the leading `repo:`/`org:`/`user:`/`owner:` token is treated as a
 * scope marker; arbitrary substrings (e.g. inside quoted text) are ignored.
 */
const REPO_SCOPE_QUALIFIER_PATTERN = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;

/**
 * Resolve the effective `repo:` scope for a search op. Returns the explicit
 * `repo` when set, `undefined` when the query already carries a scoping
 * qualifier, and otherwise the current checkout's `owner/repo` via
 * `resolveDefaultRepoMemoized`. Resolution failures (no git/gh context, no
 * configured remote) silently fall back to `undefined` so the search proceeds
 * across all of GitHub instead of throwing.
 */
async function resolveSearchRepoScope(
	cwd: string,
	repo: string | undefined,
	query: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (repo) return repo;
	if (query && REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined;
	return tryResolveCurrentRepo(cwd, signal);
}

async function resolveGitHubBranchHead(
	cwd: string,
	repo: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const response = await git.github.json<GhBranchApiResponse>(
		cwd,
		["api", "--method", "GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`],
		signal,
		{ repoProvided: true },
	);
	return requireNonEmpty(response.commit?.sha, `head SHA for branch ${branch}`);
}

async function fetchRunsForCommit(
	cwd: string,
	repo: string,
	headSha: string,
	signal?: AbortSignal,
	completedRunJobsCache?: Map<number, GhRunJobSnapshot[]>,
): Promise<GhRunSnapshot[]> {
	// Filter only by `head_sha`. The SHA uniquely identifies the commit, so
	// adding the GitHub `branch=` filter would wrongly exclude workflow runs
	// whose `head_branch` is not the local checkout — e.g. tag-push triggered
	// release workflows (`head_branch=v1.2.3`) or PR-triggered runs
	// (`head_branch=<pr head>`). See coding-agent issue tracker for details.
	const response = await git.github.json<GhActionsRunListResponse>(
		cwd,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo}/actions/runs`,
			"-F",
			`head_sha=${headSha}`,
			"-F",
			`per_page=${RUN_JOBS_PAGE_SIZE}`,
		],
		signal,
		{ repoProvided: true },
	);

	return Promise.all(
		(response.workflow_runs ?? [])
			.filter((run): run is GhActionsRunApi & { id: number } => typeof run.id === "number")
			.map(async run => {
				// Completed runs' job lists are stable until a re-run flips
				// `status` off "completed"; reuse them across watch polls so a
				// long watch does not refetch every finished run's jobs. A run
				// observed non-completed evicts its entry — when the re-run
				// completes, `status` flips back to "completed" and a stale
				// entry would serve the FIRST attempt's jobs and logs forever.
				const completed = run.status === "completed";
				if (!completed) completedRunJobsCache?.delete(run.id);
				let jobs = completed ? completedRunJobsCache?.get(run.id) : undefined;
				if (!jobs) {
					jobs = await fetchRunJobs(cwd, repo, run.id, signal);
					if (completed) completedRunJobsCache?.set(run.id, jobs);
				}
				return normalizeRunSnapshot(run, jobs);
			}),
	);
}

async function fetchRunJobs(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunJobSnapshot[]> {
	const jobs: GhRunJobSnapshot[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhActionsJobsResponse>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/actions/runs/${runId}/jobs`,
				"-F",
				`per_page=${RUN_JOBS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		const rawPage = response.jobs ?? [];
		const pageJobs = rawPage.map(job => normalizeRunJob(job)).filter((job): job is GhRunJobSnapshot => job !== null);
		jobs.push(...pageJobs);

		// Compare the raw page length: normalizeRunJob drops malformed items,
		// and a post-filter short page must not end pagination early.
		if (rawPage.length < RUN_JOBS_PAGE_SIZE) {
			break;
		}

		if ((response.total_count ?? 0) <= jobs.length) {
			break;
		}

		page += 1;
	}

	return jobs;
}

async function fetchRunSnapshot(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunSnapshot> {
	const [run, jobs] = await Promise.all([
		git.github.json<GhActionsRunApi>(
			cwd,
			["api", "--method", "GET", `/repos/${repo}/actions/runs/${runId}`],
			signal,
			{
				repoProvided: true,
			},
		),
		fetchRunJobs(cwd, repo, runId, signal),
	]);

	return normalizeRunSnapshot(run, jobs);
}

function tailLogLines(log: string, tail: number): string | undefined {
	const normalized = normalizeBlock(log);
	if (!normalized) {
		return undefined;
	}

	const lines = normalized.split("\n");
	return lines.slice(-tail).join("\n").trimEnd();
}

async function fetchFailedJobLogs(
	cwd: string,
	repo: string,
	failedJobs: Array<{ run: GhRunSnapshot; job: GhRunJobSnapshot }>,
	tail: number,
	signal?: AbortSignal,
): Promise<GhFailedJobLog[]> {
	return Promise.all(
		failedJobs.map(async entry => {
			const result = await git.github.run(cwd, ["api", `/repos/${repo}/actions/jobs/${entry.job.id}/logs`], signal);
			const fullLog = result.exitCode === 0 ? normalizeBlock(result.stdout) : undefined;
			const logTail = fullLog ? tailLogLines(fullLog, tail) : undefined;
			return {
				run: entry.run,
				job: entry.job,
				full: fullLog,
				tail: logTail,
				available: Boolean(fullLog),
			};
		}),
	);
}

function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Default branch", data.defaultBranchRef?.name);
	pushLine(lines, "Branch", normalizeOptionalString(input.branch));
	pushLine(lines, "Visibility", data.visibility ?? undefined);
	pushLine(lines, "Viewer permission", data.viewerPermission ?? undefined);
	pushLine(lines, "Primary language", data.primaryLanguage?.name);
	pushLine(lines, "Stars", data.stargazerCount);
	pushLine(lines, "Forks", data.forkCount);
	pushLine(lines, "Archived", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Homepage", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "Topics", topics || undefined);
	return lines.join("\n").trim();
}

function formatPrCheckoutResult(options: {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	reused: boolean;
}): string {
	const { data, localBranch, worktreePath, remoteName, remoteUrl, reused } = options;
	const lines: string[] = [
		reused ? `# Pull Request #${data.number ?? "?"} Worktree` : `# Checked Out Pull Request #${data.number ?? "?"}`,
		"",
	];
	pushLine(lines, "Title", data.title ?? undefined);
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Local branch", localBranch);
	pushLine(lines, "Worktree", worktreePath);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote URL", remoteUrl);
	pushLine(lines, "Cross repository", data.isCrossRepository);
	pushLine(lines, "Maintainer can modify", data.maintainerCanModify);
	lines.push("");
	lines.push(
		reused
			? "Reused the existing PR worktree."
			: "Created a dedicated worktree for this PR and configured the local branch to push back to the PR head branch.",
	);
	return lines.join("\n").trim();
}

function formatPrPushResult(options: {
	localBranch: string;
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	forceWithLease: boolean;
}): string {
	const lines: string[] = ["# Pushed Pull Request Branch", ""];
	pushLine(lines, "Local branch", options.localBranch);
	pushLine(lines, "Remote", options.remoteName);
	pushLine(lines, "Remote branch", options.remoteBranch);
	pushLine(lines, "Remote URL", options.remoteUrl);
	pushLine(lines, "PR", options.prUrl);
	pushLine(lines, "Force with lease", options.forceWithLease);
	lines.push("");
	lines.push(`Pushed ${options.localBranch} to ${options.remoteName}:${options.remoteBranch}.`);
	return lines.join("\n").trim();
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`No ${kind} found.`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  State", item.state);
		pushLine(lines, "  Author", formatAuthor(item.author));
		pushLine(lines, "  Labels", formatLabels(item.labels));
		pushLine(lines, "  Created", item.createdAt);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhSearchCodeResult[]): string {
	const lines: string[] = [`# GitHub code search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No code matches found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.path ?? "(unknown path)"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Commit", formatShortSha(item.sha));
		pushLine(lines, "  URL", item.url);
		const fragment = item.textMatches?.find(match => match.fragment)?.fragment;
		if (fragment) {
			pushLine(lines, "  Match", normalizeText(fragment).split("\n", 1)[0]);
		}
	}

	return lines.join("\n").trim();
}

function formatSearchCommitMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const firstLine = normalizeText(message).split("\n", 1)[0];
	return firstLine || undefined;
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhSearchCommitResult[]): string {
	const lines: string[] = [`# GitHub commits search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No commits found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		const sha = formatShortSha(item.sha) ?? "(unknown sha)";
		const subject = formatSearchCommitMessage(item.commit?.message) ?? "(no commit message)";
		lines.push(`- ${sha} ${subject}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Author", formatAuthor(item.author) ?? item.commit?.author?.name);
		pushLine(lines, "  Date", item.commit?.author?.date ?? item.commit?.committer?.date);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhSearchRepoResult[]): string {
	const lines: string[] = [`# GitHub repositories search`, "", `Query: ${query}`];
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No repositories found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.fullName ?? "(unknown repository)"}`);
		const description = normalizeText(item.description).split("\n", 1)[0];
		if (description) {
			pushLine(lines, "  Description", description);
		}
		pushLine(lines, "  Language", item.language ?? undefined);
		pushLine(lines, "  Stars", item.stargazersCount);
		pushLine(lines, "  Forks", item.forksCount);
		pushLine(lines, "  Open issues", item.openIssuesCount);
		pushLine(lines, "  Visibility", item.visibility ?? undefined);
		pushLine(lines, "  Archived", item.isArchived);
		pushLine(lines, "  Fork", item.isFork);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function saveArtifactText(session: ToolSession, toolType: string, text: string): Promise<string | undefined> {
	return saveOutputArtifact(session, toolType, text);
}

function appendArtifactReference(text: string, artifactId: string | undefined, label: string): string {
	if (!artifactId) {
		return text;
	}

	return `${text}\n\n${label}: artifact://${artifactId}`;
}

function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GhToolDetails,
	options?: { artifactId?: string; artifactLabel?: string; useless?: boolean },
): AgentToolResult<GhToolDetails> {
	const builder = toolResult<GhToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "Saved artifact"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	if (options?.useless) {
		builder.useless();
	}
	return builder.done();
}

/**
 * The ops that change something: local git state, or the repository on GitHub.
 *
 * Kept as a set beside the dispatcher rather than a test inside it, because it is read by
 * {@link GithubTool.execute} to decide whether an abort may abandon the work in flight. An op
 * added to the schema that writes anything belongs here; the cost of forgetting is that a
 * cancellation walks away from a half-finished push. Exported so that classification can be
 * asserted against the schema's own op list rather than restated in a test.
 */
export const MUTATING_GITHUB_OPS: ReadonlySet<string> = new Set(["pr_create", "pr_checkout", "pr_push"]);

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub issues, pull requests, and repositories";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(toolsPrompts["tools/github"].text);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		throwIfAborted(signal);
		const dispatch = async (): Promise<AgentToolResult<GhToolDetails>> => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		};
		// The ops that MUTATE are awaited; the rest race the signal.
		//
		// `untilAborted` rejects the moment the signal fires and leaves the work running
		// unobserved. For a read or a poll that is exactly right: nothing was changed, and
		// returning early is the point. For the three ops that write, it was wrong twice over.
		// The git mutations kept going after the tool had already rejected, so worktrees,
		// branches and pushes carried on with nobody waiting for them; and the race discarded
		// the abort each of those builds for itself, so the message naming the worktrees that
		// DID get created (see {@link abortedMidCheckout}) never reached the caller. The
		// operator was told "The operation was aborted" and given no paths.
		//
		// Each of the three threads `signal` into every git call it makes, so a cancellation
		// still takes effect promptly. Awaiting them is what makes the tool report where it
		// stopped instead of walking away from it.
		if (MUTATING_GITHUB_OPS.has(params.op)) return dispatch();
		return untilAborted(signal, dispatch);
	}
}

async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// PR diff fetcher
//
// Used by the `pr://<n>/diff[/…]` internal-URL family. Stores the verbatim
// `gh pr diff` text plus a parsed file index so the listing, full-diff, and
// per-file slice variants all share one cache row.
// ────────────────────────────────────────────────────────────────────────────

function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

/**
 * The abort thrown when a multi-PR checkout is cancelled with work already on disk.
 *
 * A checked-out PR is not an in-memory result: it is a worktree directory, a local branch, and
 * sometimes a fork remote. Reporting only "Operation aborted" leaves those unnamed, and the next
 * thing the operator or the agent does is often to check out the same PR again, which then finds
 * a branch it did not know existed. So the message names every worktree that exists, and names
 * the PRs that were not reached, in the sentence `tools/aborted-partway.ts` also builds for a
 * cancelled multi-file edit and a cancelled `retain`.
 */
function abortedMidCheckout(
	created: readonly PrCheckoutOutcome[],
	unfinished: ReadonlyArray<{ prRef: string | undefined }>,
	cause: unknown,
): ToolAbortError {
	return abortedPartway(
		{
			operation: "PR checkout",
			unit: { one: "pull request", many: "pull requests" },
			done: created.map(outcome => `${outcome.localBranch} at ${outcome.worktreePath}`),
			pending: unfinished.map(entry => entry.prRef ?? "(current branch)"),
			doneLabel: "already checked out",
			pendingLabel: "NOT checked out",
			adviceWhenDone: "the worktrees above are on disk and were left in place",
		},
		cause,
	);
}

async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const settled = await Promise.allSettled(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);
	const outcomes: PrCheckoutOutcome[] = [];
	const failures: Array<{ prRef: string | undefined; reason: unknown }> = [];
	for (let i = 0; i < settled.length; i++) {
		const entry = settled[i];
		if (entry.status === "fulfilled") outcomes.push(entry.value);
		else failures.push({ prRef: prRefs[i], reason: entry.reason });
	}
	if (failures.length > 0) {
		// A cancellation is not a failed checkout, and the difference matters here more
		// than anywhere else in this tool: the checkouts that DID finish created real
		// worktree directories, local branches, and possibly a new remote. The plain
		// `throwIfAborted` that used to stand here threw before the partial-success
		// report two blocks down, so an operator who pressed Escape during a multi-PR
		// checkout was told "Operation aborted" and never learned which worktrees were
		// now on their disk. So the abort still propagates as an abort -- the agent loop
		// must not retry a cancellation the way it retries a failure -- but it carries
		// the paths with it.
		if (signal?.aborted) throw abortedMidCheckout(outcomes, failures, signal.reason);
		const failureLines = failures.map(f => `- ${f.prRef ?? "(current branch)"}: ${errorMessage(f.reason)}`);
		if (outcomes.length === 0) {
			if (failures.length === 1) throw failures[0].reason;
			throw new ToolError(`all ${failures.length} PR checkouts failed:\n${failureLines.join("\n")}`);
		}
		// Partial success: report the worktrees that did get created alongside
		// the failures so the agent does not lose track of them.
		const sections = outcomes.map(formatPrCheckoutResult);
		const header = `# ${outcomes.length}/${settled.length} Pull Request Worktrees checked out (${failures.length} failed)`;
		const text = [header, "", ...joinSections(sections), "", "## Failed", ...failureLines].join("\n").trim();
		return buildTextResult(text, undefined, {
			repo,
			checkouts: outcomes.map(outcomeToSummary),
		});
	}

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Pull Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	if (prRef?.startsWith("-")) {
		throw new ToolError(`invalid PR identifier: ${prRef}. Pass a PR number, URL, or branch name.`);
	}
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI did not return a pull request number.");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head branch");
	const headRefOid = requireNonEmpty(data.headRefOid, "head commit");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = getWorktreeDir(`${prNumber}-${hashPath(primaryRepoRoot)}`);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				{ signal },
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "veyyonPrHeadRef", headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, "veyyonPrUrl", data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"veyyonPrIsCrossRepository",
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"veyyonPrMaintainerCanModify",
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	// A successful push changes what `pr://N` and `pr://N/diff` should show;
	// drop the cached rows so the canonical "push → re-read diff" flow sees
	// fresh data instead of a soft-TTL stale snapshot.
	const pushedPr = parsePrUrl(target.prUrl);
	if (pushedPr.prNumber !== undefined) {
		invalidateAllForNumber(pushedPr.prNumber, pushedPr.repo);
	}

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

async function executePrCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body;
	const base = normalizeOptionalString(params.base);
	const head = normalizeOptionalString(params.head);
	const draft = params.draft ?? false;
	const fill = params.fill ?? false;
	const reviewers = normalizePrIdentifierList(params.reviewer);
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (!fill && !title) {
		throw new ToolError("title is required unless fill is true");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}

	const args = ["pr", "create"];
	appendRepoFlag(args, repo);
	if (title) args.push("--title", title);
	if (base) args.push("--base", base);
	if (head) args.push("--head", head);
	if (draft) args.push("--draft");
	if (fill) args.push("--fill");
	for (const reviewer of reviewers) args.push("--reviewer", reviewer);
	for (const assignee of assignees) args.push("--assignee", assignee);
	for (const label of labels) args.push("--label", label);

	let bodyDir: string | undefined;
	try {
		if (!fill) {
			if (body !== undefined && body.length > 0) {
				// Route through a temp file so multi-KB bodies stay clear of any
				// argv-length limits and shell-quoting hazards on uncommon platforms.
				bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-body-"));
				const bodyFile = path.join(bodyDir, "body.md");
				await Bun.write(bodyFile, body);
				args.push("--body-file", bodyFile);
			} else {
				// Avoid gh dropping into an interactive editor when no body is given.
				args.push("--body", "");
			}
		}

		const output = await git.github.text(session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const url =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("https://github.com/")) ?? output.trim();
		const parsed = parsePrUrl(url);
		const resolvedRepo = repo ?? parsed.repo;

		let prView: GhPrViewData | undefined;
		if (resolvedRepo && parsed.prNumber !== undefined) {
			try {
				prView = await git.github.json<GhPrViewData>(
					session.cwd,
					[
						"pr",
						"view",
						String(parsed.prNumber),
						"--repo",
						resolvedRepo,
						"--json",
						GH_PR_FIELDS_NO_COMMENTS.join(","),
					],
					signal,
					{ repoProvided: true },
				);
			} catch {
				// Best-effort summary; PR creation already succeeded.
			}
		}

		const text = formatPrCreateResult({
			url,
			prNumber: parsed.prNumber,
			data: prView,
			title,
			base,
			head,
			draft,
		});
		return buildTextResult(text, url || prView?.url);
	} finally {
		if (bodyDir) {
			await removeTempPath(bodyDir, "gh-pr-body-dir");
		}
	}
}

function formatPrCreateResult(options: {
	url: string;
	prNumber?: number;
	data?: GhPrViewData;
	title?: string;
	base?: string;
	head?: string;
	draft?: boolean;
}): string {
	const number = options.prNumber ?? options.data?.number;
	const headerTitle = options.data?.title ?? options.title ?? "Untitled";
	const header =
		number !== undefined
			? `# Created Pull Request #${number}: ${headerTitle}`
			: `# Created Pull Request: ${headerTitle}`;
	const lines: string[] = [header, ""];
	pushLine(lines, "URL", options.url || options.data?.url);
	pushLine(lines, "State", options.data?.state);
	pushLine(lines, "Draft", options.data?.isDraft ?? options.draft);
	pushLine(lines, "Base", options.data?.baseRefName ?? options.base);
	pushLine(lines, "Head", options.data?.headRefName ?? options.head);
	pushLine(lines, "Author", formatAuthor(options.data?.author));
	pushLine(lines, "Created", options.data?.createdAt);
	pushLine(lines, "Labels", formatLabels(options.data?.labels));

	const bodyText = normalizeText(options.data?.body);
	if (bodyText) {
		lines.push("");
		lines.push("## Body");
		lines.push("");
		lines.push(bodyText);
	}

	return lines.join("\n").trim();
}

async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("issues", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:issue"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("issues", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("prs", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:pr"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("pull requests", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const since = normalizeOptionalString(params.since);
	const until = normalizeOptionalString(params.until);
	if (since !== undefined || until !== undefined) {
		throw new ToolError("search_code does not support since/until; GitHub code search has no date qualifier.");
	}
	const limit = resolveSearchLimit(params.limit);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), query, signal);
	const apiQuery = composeSearchQuery([query, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("code", apiQuery, limit, ["Accept: application/vnd.github.text-match+json"]);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCodeItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCodeToSearchResult);
	return buildTextResult(formatSearchCodeResults(query, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("commits", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("commits", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCommitItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCommitToSearchResult);
	return buildTextResult(formatSearchCommitsResults(displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("repos", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const query = composeSearchQuery([params.query, dateQualifier]);
	const args = buildGhApiSearchArgs("repositories", query, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchRepoItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiRepoToSearchResult);
	return buildTextResult(formatSearchReposResults(query, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const explicitRepo = normalizeOptionalString(params.repo);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, explicitRepo, runReference.repo, signal);
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	const watchStartMs = Date.now();
	// Fast polls for the first minute for snappy feedback, then back off:
	// every commit-watch poll is one runs-list call plus one jobs call per
	// non-completed run, and long builds must not burn the shared
	// authenticated REST quota.
	const currentIntervalSeconds = () =>
		Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW;
	let consecutivePollFailures = 0;
	const handlePollError = async (err: unknown): Promise<void> => {
		if (signal?.aborted) throw err;
		consecutivePollFailures += 1;
		if (!isRateLimitedGhError(err) || consecutivePollFailures > RUN_WATCH_MAX_POLL_FAILURES) throw err;
		// Rate-limited: back off with the slow interval and retry instead of
		// discarding the whole watch (and its accumulated context).
		await scheduler.wait(RUN_WATCH_INTERVAL_SLOW * 1000, { signal });
	};
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run: GhRunSnapshot;
			try {
				run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			} catch (err) {
				await handlePollError(err);
				continue;
			}
			consecutivePollFailures = 0;
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			let failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await scheduler.wait(graceSeconds * 1000, { signal });
					try {
						const refetched = await fetchRunSnapshot(session.cwd, repo, runId, signal);
						const refetchedFailed = refetched.jobs.filter(isFailedJob);
						// An auto-retry can reset job conclusions between
						// detection and refetch; keep the originally-detected
						// failure list (and its snapshot) when the refetch no
						// longer shows any failures so the watch never ends
						// with a failure result and zero logs.
						if (refetchedFailed.length > 0) {
							run = refetched;
							failedJobs = refetchedFailed;
						}
					} catch (err) {
						if (signal?.aborted) throw err;
						// Refetch failure: report from the original snapshot.
					}
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					failedJobs.map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "Full failed-job logs" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
		}
	}

	let branch: string;
	let headSha: string;
	if (branchInput) {
		branch = branchInput;
		headSha = await resolveGitHubBranchHead(session.cwd, repo, branch, signal);
	} else {
		// No branch/run selector — derive the commit from the current checkout,
		// but only when cwd actually points at `repo`. Otherwise we'd watch an
		// unrelated commit SHA against the explicit repo and silently stream a
		// confident wrong-repo status (issue #1949). GitHub `owner/repo` slugs
		// are case-insensitive — `gh repo view` returns the canonical casing
		// while callers may pass any casing — so the equality check normalizes
		// both sides before deciding the cwd is a different repo (PR #1951).
		const cwdRepo = await tryResolveCurrentRepoFresh(session.cwd, signal);
		if (!githubRepoSlugEquals(cwdRepo, repo)) {
			throw new ToolError(
				`Cannot infer the watched commit for ${repo}: current checkout is ${cwdRepo ?? "not a GitHub repository"}. Pass \`branch\` or \`run\` to scope the watch.`,
			);
		}
		branch = await requireCurrentGitBranch(session.cwd, signal);
		headSha = await requireCurrentGitHead(session.cwd, signal);
	}
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;
	let everSawRuns = false;
	const completedRunJobsCache = new Map<number, GhRunJobSnapshot[]>();

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs: GhRunSnapshot[];
		try {
			runs = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
		} catch (err) {
			await handlePollError(err);
			continue;
		}
		consecutivePollFailures = 0;
		if (runs.length > 0) everSawRuns = true;
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			let failedPairs = runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
			if (graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				try {
					const refetched = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
					const refetchedPairs = refetched.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
					// Keep the originally-detected failure list when an
					// auto-retry reset the conclusions during the grace window
					// (see the run-id branch above).
					if (refetchedPairs.length > 0) {
						runs = refetched;
						failedPairs = refetchedPairs;
					}
				} catch (err) {
					if (signal?.aborted) throw err;
					// Refetch failure: report from the original snapshots.
				}
			}

			const failedJobLogs = await fetchFailedJobLogs(session.cwd, repo, failedPairs, tail, signal);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "Full failed-job logs" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const confirmWaitSeconds = currentIntervalSeconds();
			const note = `All known workflow runs completed successfully. Waiting ${confirmWaitSeconds}s to ensure no additional runs appear for this commit.`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await scheduler.wait(confirmWaitSeconds * 1000, { signal });
			continue;
		}

		settledSuccessSignature = undefined;
		if (!everSawRuns && Date.now() - watchStartMs >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
			// A repo with no Actions configured (or Actions disabled) never
			// produces a run for this commit; give up with a clear message
			// instead of polling forever.
			const elapsedSec = Math.round((Date.now() - watchStartMs) / 1000);
			return buildTextResult(
				`No workflow runs found for ${repo}@${formatShortSha(headSha) ?? headSha} after ${elapsedSec}s (${pollCount} polls). The commit may not trigger any GitHub Actions workflows, or Actions may be disabled for this repository. Pass \`run\` to watch a specific run.`,
				undefined,
				buildCommitRunWatchDetails(repo, headSha, branch, runs, { state: "completed", pollCount }),
				{ useless: true },
			);
		}
		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
	}
}
