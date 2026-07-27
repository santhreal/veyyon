/**
 * Cache-aware GitHub issue, PR and PR-diff fetching. One shared cache row per item, whoever asks.
 *
 * WHY THIS IS NOT IN `tools/gh.ts`. It was, and that module is the `github` TOOL: 38 ops, the run-watch
 * poller, PR checkout with worktrees and remotes, four search renderers, and an arktype schema. It also
 * imports `PROMPTS` from `prompts/registry.ts` for one string, the tool's own description, which is
 * correct for a tool and which drags the whole prompt corpus (167 modules) behind it.
 *
 * `internal-urls/issue-pr-protocol.ts` wanted none of that. It resolves `issue://123` and `pr://7/diff`,
 * so it needs exactly the six names below, and it paid 352 modules to reach them. From there the cost
 * spread the way these always do: `internal-urls/router.ts` builds every handler, `tools/read.ts`
 * consults the router because reading `pr://7` is a real feature, and 54 test files import `read`.
 *
 * WHAT "CACHE-AWARE" MEANS HERE, because it is the reason these three fetchers belong together rather
 * than beside their callers. Each one renders markdown once and stores it in the SQLite row that
 * `tools/github-cache.ts` owns, keyed by repo, kind, number and whether comments were included. The
 * `github` tool and the protocol handlers therefore share a single `gh` invocation for the same item:
 * open `pr://7`, then ask the tool for PR 7, and the second read is free and identical. Splitting the
 * fetchers per caller would have quietly given each surface its own row.
 *
 * `tools/gh.ts` re-exports every name here, so no existing caller changed.
 */

import * as path from "node:path";
// From the module that owns it, not the `@veyyon/utils` barrel: 1 module against 74. This module
// exists so a `pr://` read does not import a subsystem it never calls; naming the barrel here would
// have handed most of it straight back.
import { untilAborted } from "@veyyon/utils/abortable";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";
import {
	appendRepoFlag,
	formatAuthor,
	formatLabels,
	formatShortSha,
	type GhLabel,
	type GhUser,
	normalizeOptionalString,
	normalizeText,
	parsePositiveDecimalInt,
	pushLine,
	requireNonEmpty,
} from "./gh-format";
import { parseIssueUrl } from "./gh-url";
import { type CacheStatus, getOrFetchView, resolveGithubCacheAuthKey } from "./github-cache";
import { ToolError } from "./tool-errors";

const FILE_PREVIEW_LIMIT = 50;

const REVIEW_COMMENTS_PAGE_SIZE = 100;

export interface GhRepoTopic {
	name?: string;
	topic?: { name?: string };
}

export interface GhRepoLanguage {
	name?: string;
}

export interface GhRepoBranch {
	name?: string;
}

export interface GhRepoViewData {
	nameWithOwner?: string;
	description?: string | null;
	url?: string;
	sshUrl?: string;
	defaultBranchRef?: GhRepoBranch | null;
	homepageUrl?: string | null;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: GhRepoLanguage | null;
	repositoryTopics?: GhRepoTopic[];
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string | null;
	visibility?: string | null;
}

export const GH_ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];

export const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"body",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];

export const GH_ISSUE_STATE_REASON_FIELD = "stateReason";

function ghJsonErrorNamesField(err: unknown, field: string): boolean {
	if (!(err instanceof Error) || !err.message.includes("Unknown JSON field")) return false;
	return err.message.includes(`"${field}"`) || err.message.includes(`'${field}'`) || err.message.includes(field);
}

function dropJsonField(args: readonly string[], field: string): string[] | undefined {
	const next = [...args];
	const jsonIndex = next.indexOf("--json");
	if (jsonIndex < 0) return undefined;
	const fields = next[jsonIndex + 1];
	if (!fields) return undefined;
	const splitFields = fields.split(",");
	const kept = splitFields.filter(candidate => candidate !== field);
	if (kept.length === splitFields.length) return undefined;
	next[jsonIndex + 1] = kept.join(",");
	return next;
}

/** Runs `gh --json` for issue data, retrying without optional stateReason on older gh releases. */
export async function githubIssueJsonWithStateReasonFallback<T>(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	options?: git.GhCommandOptions,
): Promise<T> {
	try {
		return await git.github.json<T>(cwd, [...args], signal, options);
	} catch (err) {
		if (!ghJsonErrorNamesField(err, GH_ISSUE_STATE_REASON_FIELD)) throw err;
		const retryArgs = dropJsonField(args, GH_ISSUE_STATE_REASON_FIELD);
		if (!retryArgs) throw err;
		return await git.github.json<T>(cwd, retryArgs, signal, options);
	}
}

export const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];

export const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];

export interface GhComment {
	author?: GhUser | null;
	body?: string;
	createdAt?: string;
	url?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
}

export interface GhIssueViewData {
	author?: GhUser | null;
	body?: string | null;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string | null;
	title?: string;
	updatedAt?: string;
	url?: string;
}

export interface GhPrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

export interface GhPrViewData extends GhIssueViewData {
	baseRefName?: string;
	files?: GhPrFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: GhRepoViewData | null;
	headRepositoryOwner?: GhUser | null;
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewComments?: GhPrReviewComment[];
	reviews?: GhPrReview[];
	reviewDecision?: string;
}

export interface GhPrReviewCommit {
	oid?: string | null;
}

export interface GhPrReview {
	author?: GhUser | null;
	body?: string | null;
	commit?: GhPrReviewCommit | null;
	state?: string | null;
	submittedAt?: string | null;
}

export interface GhPrReviewCommentApi {
	body?: string | null;
	created_at?: string | null;
	html_url?: string | null;
	id?: number;
	in_reply_to_id?: number | null;
	line?: number | null;
	original_line?: number | null;
	path?: string | null;
	side?: string | null;
	user?: GhUser | null;
}

export interface GhPrReviewComment {
	author?: GhUser | null;
	body?: string | null;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	line?: number;
	originalLine?: number;
	path?: string;
	side?: string;
	url?: string;
}

function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

/**
 * Process-lifetime cache of `gh repo view --json nameWithOwner` lookups keyed
 * by absolute cwd. Avoids repeated `gh` chatter when the same protocol handler
 * or tool call resolves the default repo many times in a row.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * `gh repo view` for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller.
 */
const DEFAULT_REPO_RESOLVED = new Map<string, string>();

const DEFAULT_REPO_INFLIGHT = new Map<string, Promise<string>>();

export async function resolveDefaultRepoMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	const key = path.resolve(cwd);
	const ready = DEFAULT_REPO_RESOLVED.get(key);
	if (ready) return ready;
	let pending = DEFAULT_REPO_INFLIGHT.get(key);
	if (!pending) {
		pending = (async () => {
			// No caller signal: this lookup is shared across every concurrent
			// waiter on the same cwd.
			const resolved = await git.github.text(cwd, [
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"-q",
				".nameWithOwner",
			]);
			const value = requireNonEmpty(resolved, "repo");
			DEFAULT_REPO_RESOLVED.set(key, value);
			return value;
		})();
		// Drop the in-flight slot on settle so failures don't poison the cache
		// and so a successful resolution survives only in `DEFAULT_REPO_RESOLVED`.
		void pending.then(
			() => DEFAULT_REPO_INFLIGHT.delete(key),
			() => DEFAULT_REPO_INFLIGHT.delete(key),
		);
		DEFAULT_REPO_INFLIGHT.set(key, pending);
	}
	return untilAborted(signal, pending);
}

async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		// Compare the raw page length: a dropped malformed item must not end
		// pagination early and silently lose the remaining pages.
		if (response.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## Comments", ""];

	if (visible.length === 0) {
		lines.push(`No visible comments. Minimized comments omitted: ${hiddenCount}.`);
		return lines;
	}

	lines[0] = `## Comments (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No comment body.");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`Minimized comments omitted: ${hiddenCount}.`);
	}

	return lines;
}

function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## Reviews (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "unknown";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`Commit: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "No review body.");
		lines.push("");
	}

	return lines;
}

function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## Review Comments (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "Location", formatReviewCommentLocation(comment));
		pushLine(lines, "Side", comment.side);
		pushLine(lines, "Reply to", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No review comment body.");
		lines.push("");
	}

	return lines;
}

function formatIssueView(data: GhIssueViewData, input: { issue: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "State reason", data.stateReason ?? undefined);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## Files (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(unknown file)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`[…${files.length - FILE_PREVIEW_LIMIT} files elided…]`);
	}

	return lines;
}

function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "current";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const data = await githubIssueJsonWithStateReasonFallback<GhIssueViewData>(cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const rendered = formatIssueView(data, { issue: identifier, repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`invalid issue identifier: ${identifier}. Pass an issue number or URL.`);
	}
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

export interface PrDiffFile {
	/** Display path. Prefers the post-image (`b/<path>`) when present. */
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Pre-image path for renames/deletes; same as `path` otherwise. */
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text as returned by `gh pr diff --color never`. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

/**
 * Split `gh pr diff` output on `^diff --git ` boundaries and parse per-file
 * metadata. The unified diff is preserved verbatim so callers can slice it by
 * byte offsets without re-running gh.
 */
export function parsePrUnifiedDiff(text: string): PrDiffPayload {
	const files: PrDiffFile[] = [];
	if (text.length === 0) {
		return { unified: text, files };
	}

	// Walk match positions manually so we capture each section's byte range.
	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		// Avoid zero-length match infinite loop (regex has fixed prefix, but
		// be explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parsePrDiffSection(section, startOffset, endOffset));
	}
	return { unified: text, files };
}

interface ParsedDiffHeaderToken {
	value: string;
	nextIndex: number;
}

function skipDiffHeaderSpaces(text: string, index: number): number {
	let i = index;
	while (text.charAt(i) === " ") i += 1;
	return i;
}

function parseDiffQuotedEscape(text: string, slashIndex: number): ParsedDiffHeaderToken {
	const next = text.charAt(slashIndex + 1);
	if (next === "") return { value: "\\", nextIndex: slashIndex + 1 };

	if (next >= "0" && next <= "7") {
		let end = slashIndex + 1;
		while (end < text.length && end < slashIndex + 4) {
			const digit = text.charAt(end);
			if (digit < "0" || digit > "7") break;
			end += 1;
		}
		return {
			value: String.fromCharCode(Number.parseInt(text.slice(slashIndex + 1, end), 8)),
			nextIndex: end,
		};
	}

	switch (next) {
		case "a":
			return { value: "\x07", nextIndex: slashIndex + 2 };
		case "b":
			return { value: "\b", nextIndex: slashIndex + 2 };
		case "f":
			return { value: "\f", nextIndex: slashIndex + 2 };
		case "n":
			return { value: "\n", nextIndex: slashIndex + 2 };
		case "r":
			return { value: "\r", nextIndex: slashIndex + 2 };
		case "t":
			return { value: "\t", nextIndex: slashIndex + 2 };
		case "v":
			return { value: "\v", nextIndex: slashIndex + 2 };
		case "\\":
		case '"':
			return { value: next, nextIndex: slashIndex + 2 };
		default:
			return { value: next, nextIndex: slashIndex + 2 };
	}
}

function parseDiffQuotedToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	if (text.charAt(startIndex) !== '"') return undefined;
	let value = "";
	for (let i = startIndex + 1; i < text.length; i += 1) {
		const ch = text.charAt(i);
		if (ch === '"') return { value, nextIndex: i + 1 };
		if (ch !== "\\") {
			value += ch;
			continue;
		}
		const escaped = parseDiffQuotedEscape(text, i);
		value += escaped.value;
		i = escaped.nextIndex - 1;
	}
	return undefined;
}

function parseDiffHeaderToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	const start = skipDiffHeaderSpaces(text, startIndex);
	if (start >= text.length) return undefined;
	const quoted = parseDiffQuotedToken(text, start);
	if (quoted) return quoted;
	const end = text.indexOf(" ", start);
	if (end === -1) return { value: text.slice(start), nextIndex: text.length };
	return { value: text.slice(start, end), nextIndex: end };
}

function stripPrDiffPathPrefix(value: string, prefix: "a/" | "b/"): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function parsePrDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	if (trail.startsWith('"')) {
		const oldToken = parseDiffQuotedToken(trail, 0);
		if (!oldToken) return {};
		const newToken = parseDiffHeaderToken(trail, oldToken.nextIndex);
		if (!newToken) return {};
		return {
			oldPath: stripPrDiffPathPrefix(oldToken.value, "a/"),
			newPath: stripPrDiffPathPrefix(newToken.value, "b/"),
		};
	}

	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) {
		return {
			oldPath: trail.slice(2, bIdx),
			newPath: trail.slice(bIdx + 3),
		};
	}
	return {};
}

function isPrDiffFileHeaderLine(line: string): boolean {
	return (
		line === "--- /dev/null" ||
		line === "+++ /dev/null" ||
		line.startsWith("--- a/") ||
		line.startsWith("+++ b/") ||
		line.startsWith('--- "a/') ||
		line.startsWith('+++ "b/')
	);
}

function parsePrDiffSection(section: string, startOffset: number, endOffset: number): PrDiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";
	const headerPaths = parsePrDiffHeaderPaths(header);
	let oldPath = headerPaths.oldPath;
	let newPath = headerPaths.newPath;

	let changeType: PrDiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	let inHunk = false;
	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk && isPrDiffFileHeaderLine(line)) continue;
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: PrDiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}

async function fetchPrDiffFresh(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const args = ["pr", "diff", String(number), "--color", "never"];
	appendRepoFlag(args, repo, String(number));
	const text = await git.github.text(cwd, args, signal, { repoProvided: true, trimOutput: false });
	const payload = parsePrUnifiedDiff(text);
	// `rendered` already carries the verbatim diff; blank the payload copy so
	// the cache row stores a potentially huge diff once instead of twice.
	// `getOrFetchPrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

/**
 * Cache-aware PR diff fetcher. Stores the full unified diff plus a parsed
 * file index in a single `pr-diff` cache row so the listing, full-diff, and
 * per-file slice variants of `pr://<n>/diff` share one `gh pr diff`
 * invocation.
 */
export async function getOrFetchPrDiff(options: PrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrDiffFresh(options.cwd, options.repo, options.number, options.signal);
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.repo,
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		// Rehydrate the unified text from `rendered` (stored once per row).
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
