import { tryParseJson } from "@veyyon/utils";
import {
	buildResult,
	formatIsoDate,
	formatNumber,
	loadPage,
	type RenderResult,
	type ScraperDegrade,
	type SpecialHandler,
	scraperDegrade,
	tryParseUrl,
} from "./types";

interface GitLabUrl {
	/** Project path: `namespace/project`, or deeper for a project in a subgroup. */
	project: string;
	type: "repo" | "blob" | "tree" | "issue" | "merge_request";
	ref?: string;
	path?: string;
	id?: number;
}

/** The URL type of each numbered `/-/` route. */
const NUMBERED_ROUTES: Record<string, "issue" | "merge_request"> = {
	issues: "issue",
	merge_requests: "merge_request",
};

/**
 * Parse a gitlab.com URL: a two-segment project root, or a project path of any
 * depth followed by a `/-/blob`, `/-/tree`, `/-/issues` or `/-/merge_requests` route.
 */
function parseGitLabUrl(url: string): GitLabUrl | null {
	const parsed = tryParseUrl(url);
	if (parsed?.hostname !== "gitlab.com") return null;

	// Decoded, since each part is re-encoded into the API request it addresses.
	const segments = parsed.pathname
		.split("/")
		.filter(Boolean)
		.map(segment => decodeURIComponent(segment));
	const separator = segments.indexOf("-");
	if (separator === -1) return segments.length === 2 ? { project: segments.join("/"), type: "repo" } : null;
	if (separator < 2) return null;

	const project = segments.slice(0, separator).join("/");
	const [route, ref, ...pathParts] = segments.slice(separator + 1);
	if (route === "blob" && pathParts.length > 0) return { project, type: "blob", ref, path: pathParts.join("/") };
	if (route === "tree" && ref !== undefined) {
		return { project, type: "tree", ref, path: pathParts.length > 0 ? pathParts.join("/") : undefined };
	}

	const type = Object.hasOwn(NUMBERED_ROUTES, route) ? NUMBERED_ROUTES[route] : undefined;
	if (!type || ref === undefined || pathParts.length > 0) return null;
	const id = parseInt(ref, 10);
	return Number.isNaN(id) ? null : { project, type, id };
}

/** The REST endpoint of a project; the API takes the URL-encoded project path as its id. */
function projectApiUrl(gl: GitLabUrl): string {
	return `https://gitlab.com/api/v4/projects/${encodeURIComponent(gl.project)}`;
}

async function loadJson<T>(apiUrl: string, timeout: number, signal?: AbortSignal): Promise<T | null> {
	const result = await loadPage(apiUrl, { timeout, signal });
	return result.ok ? tryParseJson<T>(result.content) : null;
}

async function renderGitLabRepo(gl: GitLabUrl, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const repo = await loadJson<{
		name: string;
		description?: string;
		star_count: number;
		forks_count: number;
		open_issues_count: number;
		default_branch: string;
		visibility: string;
		created_at: string;
		last_activity_at: string;
		topics?: string[];
		readme_url?: string;
	}>(projectApiUrl(gl), timeout, signal);
	if (!repo) return null;

	let md = `# ${repo.name}\n\n`;
	if (repo.description) md += `${repo.description}\n\n`;
	md += `**Stars:** ${formatNumber(repo.star_count)} · **Forks:** ${formatNumber(repo.forks_count)} · **Issues:** ${formatNumber(repo.open_issues_count)}\n`;
	md += `**Visibility:** ${repo.visibility} · **Default Branch:** ${repo.default_branch}\n`;
	if (repo.topics && repo.topics.length > 0) md += `**Topics:** ${repo.topics.join(", ")}\n`;
	md += `**Created:** ${formatIsoDate(repo.created_at)} · **Last Activity:** ${formatIsoDate(repo.last_activity_at)}\n\n`;

	// `readme_url` is the README's web blob page; its `/-/raw/` twin serves the file itself.
	const readmeUrl = repo.readme_url?.includes("/-/blob/") ? repo.readme_url.replace("/-/blob/", "/-/raw/") : null;
	const readme = readmeUrl ? await loadPage(readmeUrl, { timeout, signal }) : null;
	if (readme?.ok && readme.content.trim().length > 0) md += `---\n\n## README\n\n${readme.content}\n`;
	return md;
}

async function renderGitLabFile(gl: GitLabUrl, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const filePath = encodeURIComponent(gl.path ?? "");
	const apiUrl = `${projectApiUrl(gl)}/repository/files/${filePath}/raw?ref=${encodeURIComponent(gl.ref ?? "")}`;
	const result = await loadPage(apiUrl, { timeout, signal });
	return result.ok ? result.content : null;
}

async function renderGitLabTree(gl: GitLabUrl, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const query = `ref=${encodeURIComponent(gl.ref ?? "")}&path=${encodeURIComponent(gl.path ?? "")}&per_page=100`;
	const tree = await loadJson<Array<{ name: string; type: "tree" | "blob" }>>(
		`${projectApiUrl(gl)}/repository/tree?${query}`,
		timeout,
		signal,
	);
	if (!tree) return null;

	let md = `# Directory: ${gl.path || "/"}\n\n**Ref:** ${gl.ref}\n\n`;
	const dirs = tree.filter(item => item.type === "tree");
	const files = tree.filter(item => item.type === "blob");
	if (dirs.length > 0) md += `## Directories (${dirs.length})\n\n${dirs.map(dir => `- 📁 ${dir.name}/\n`).join("")}\n`;
	if (files.length > 0) md += `## Files (${files.length})\n\n${files.map(file => `- 📄 ${file.name}\n`).join("")}`;
	return md;
}

/** The fields an issue and a merge request share. */
interface GitLabWorkItem {
	title: string;
	description?: string | null;
	state: string;
	author: { name: string; username: string };
	created_at: string;
	updated_at: string;
	labels: string[];
	upvotes: number;
	downvotes: number;
	user_notes_count: number;
	assignees?: Array<{ name: string }>;
}

/** Labels and assignees lines, then the description, which the API returns as markdown. */
function formatWorkItemTail(item: GitLabWorkItem): string {
	let md = "";
	if (item.labels.length > 0) md += `**Labels:** ${item.labels.join(", ")}\n`;
	if (item.assignees && item.assignees.length > 0) {
		md += `**Assignees:** ${item.assignees.map(a => a.name).join(", ")}\n`;
	}
	return `${md}\n---\n\n## Description\n\n${item.description?.trim() || "*No description*"}`;
}

async function renderGitLabIssue(gl: GitLabUrl, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const issue = await loadJson<GitLabWorkItem>(`${projectApiUrl(gl)}/issues/${gl.id}`, timeout, signal);
	if (!issue) return null;

	let md = `# Issue #${gl.id}: ${issue.title}\n\n`;
	md += `**State:** ${issue.state.toUpperCase()} · **Author:** ${issue.author.name} (@${issue.author.username})\n`;
	md += `**Created:** ${formatIsoDate(issue.created_at)} · **Updated:** ${formatIsoDate(issue.updated_at)}\n`;
	md += `**Upvotes:** ${issue.upvotes} · **Downvotes:** ${issue.downvotes} · **Comments:** ${issue.user_notes_count}\n`;
	return md + formatWorkItemTail(issue);
}

async function renderGitLabMR(gl: GitLabUrl, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const mr = await loadJson<
		GitLabWorkItem & { source_branch: string; target_branch: string; draft: boolean; merge_status: string }
	>(`${projectApiUrl(gl)}/merge_requests/${gl.id}`, timeout, signal);
	if (!mr) return null;

	let md = `# MR !${gl.id}: ${mr.title}\n\n`;
	if (mr.draft) md += `**[DRAFT]** `;
	md += `**State:** ${mr.state.toUpperCase()} · **Author:** ${mr.author.name} (@${mr.author.username})\n`;
	md += `**Branch:** ${mr.source_branch} → ${mr.target_branch}\n`;
	md += `**Created:** ${formatIsoDate(mr.created_at)} · **Updated:** ${formatIsoDate(mr.updated_at)}\n`;
	md += `**Merge Status:** ${mr.merge_status} · **Upvotes:** ${mr.upvotes} · **Downvotes:** ${mr.downvotes} · **Comments:** ${mr.user_notes_count}\n`;
	return md + formatWorkItemTail(mr);
}

interface GitLabReader {
	method: string;
	note: string;
	contentType?: string;
	render: (gl: GitLabUrl, timeout: number, signal?: AbortSignal) => Promise<string | null>;
}

/** The result method, note and REST renderer of each GitLab URL type. */
const READERS: Record<GitLabUrl["type"], GitLabReader> = {
	repo: { method: "gitlab-repo", note: "Fetched repository via GitLab API", render: renderGitLabRepo },
	blob: {
		method: "gitlab-raw",
		note: "Fetched raw file via GitLab API",
		contentType: "text/plain",
		render: renderGitLabFile,
	},
	tree: { method: "gitlab-tree", note: "Fetched directory tree via GitLab API", render: renderGitLabTree },
	issue: { method: "gitlab-issue", note: "Fetched issue via GitLab API", render: renderGitLabIssue },
	merge_request: { method: "gitlab-mr", note: "Fetched merge request via GitLab API", render: renderGitLabMR },
};

/**
 * Handle GitLab URLs specially
 */
export const handleGitLab: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	const gl = parseGitLabUrl(url);
	if (!gl) return null;

	const fetchedAt = new Date().toISOString();
	const reader = READERS[gl.type];
	const content = await reader.render(gl, timeout, signal);
	if (content !== null) {
		const { method, note, contentType } = reader;
		return buildResult(content, { url, method, fetchedAt, notes: [note], contentType });
	}

	// Matched a GitLab URL but every API path failed: degrade loudly so the
	// generic fetch result records why the rich rendering is missing.
	return scraperDegrade("gitlab", "GitLab API requests failed");
};
