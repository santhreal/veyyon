import { formatCount } from "@veyyon/utils/format";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import {
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	type PrDiffFile,
	resolveDefaultRepoMemoized,
} from "../tools/gh-fetch";
import { parsePositiveDecimalInt } from "../tools/gh-format";
import { type CacheStatus, formatFreshnessNote } from "../tools/github-cache";
import * as git from "../utils/git";
import type { InternalResource, InternalUrl, ResolveContext } from "./types";

export type Scheme = "issue" | "pr";

export interface ParsedSingle {
	kind: "single";
	repo?: string;
	number: number;
	comments: boolean;
}

export interface ParsedPrDiff {
	kind: "pr-diff";
	repo?: string;
	number: number;
	mode: "list" | "all" | "slice";
	index?: number;
}

export interface ParsedList {
	kind: "list";
	repo?: string;
	state: "open" | "closed" | "merged" | "all";
	limit: number;
	author: string | undefined;
	label: string | undefined;
}

export type Parsed = ParsedSingle | ParsedList | ParsedPrDiff;

export const LIST_LIMIT_DEFAULT = 30;
export const LIST_LIMIT_MAX = 100;

export function parseListOptions(url: InternalUrl, scheme: Scheme, repo: string | undefined): ParsedList {
	const stateRaw = url.searchParams.get("state");
	const allowedStates: ParsedList["state"][] =
		scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
	if (stateRaw !== null && !(allowedStates as string[]).includes(stateRaw)) {
		throw new Error(`Invalid ${scheme}:// list state '${stateRaw}'. Expected one of: ${allowedStates.join(", ")}.`);
	}
	const state = (stateRaw ?? "open") as ParsedList["state"];

	const limitRaw = url.searchParams.get("limit");
	let limit = LIST_LIMIT_DEFAULT;
	if (limitRaw !== null) {
		const parsed = parsePositiveDecimalInt(limitRaw);
		if (parsed === undefined) {
			throw new Error(
				`Invalid ${scheme}:// list limit '${limitRaw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`,
			);
		}
		limit = Math.min(parsed, LIST_LIMIT_MAX);
	}
	return {
		kind: "list",
		repo,
		state,
		limit,
		author: url.searchParams.get("author") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	};
}

export function parseUrl(url: InternalUrl, scheme: Scheme): Parsed {
	const host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts: string[] = [];
	if (stripped !== "") {
		for (const seg of stripped.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
			}
			if (decoded === "" || decoded === "." || decoded === "..") {
				throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
			}
			parts.push(seg);
		}
	}

	let repo: string | undefined;
	let numberPart: string | undefined;
	let diffParts: string[] = [];

	if (!host && parts.length === 0) {
		return parseListOptions(url, scheme, undefined);
	}
	if (host && parts.length === 0) {
		numberPart = host;
	} else if (parts[0] === "diff" && parsePositiveDecimalInt(host) !== undefined) {
		numberPart = host;
		diffParts = parts;
	} else if (host && parts.length === 1) {
		repo = `${host}/${parts[0]}`;
		return parseListOptions(url, scheme, repo);
	} else if (host && parts.length >= 2) {
		repo = `${host}/${parts[0]}`;
		numberPart = parts[1];
		diffParts = parts.slice(2);
	} else {
		throw new Error(
			`Invalid ${scheme}:// URL. Expected ${scheme}://, ${scheme}://<number>, ${scheme}://<owner>/<repo>, or ${scheme}://<owner>/<repo>/<number>`,
		);
	}

	if (diffParts.length > 0) {
		if (scheme === "issue") {
			throw new Error(
				`Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.`,
			);
		}
		if (diffParts[0] !== "diff" || diffParts.length > 2) {
			throw new Error(
				`Invalid pr:// URL. Expected pr://<n>, pr://<n>/diff, pr://<n>/diff/all, or pr://<n>/diff/<i>`,
			);
		}
	}

	const num = parsePositiveDecimalInt(numberPart);
	if (num === undefined) {
		throw new Error(`Invalid ${scheme}:// number: ${numberPart ?? "(missing)"}`);
	}

	if (diffParts.length === 0) {
		const commentsParam = url.searchParams.get("comments");
		const comments =
			commentsParam === null ? true : !(commentsParam === "0" || commentsParam.toLowerCase() === "false");
		return { kind: "single", repo, number: num, comments };
	}

	if (diffParts.length === 1) {
		return { kind: "pr-diff", repo, number: num, mode: "list" };
	}
	const sub = diffParts[1] ?? "";
	if (sub === "all") {
		return { kind: "pr-diff", repo, number: num, mode: "all" };
	}
	const idx = parsePositiveDecimalInt(sub);
	if (idx === undefined) {
		throw new Error(`Invalid pr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`);
	}
	return { kind: "pr-diff", repo, number: num, mode: "slice", index: idx };
}

export function resolveCwd(context: ResolveContext | undefined): string {
	if (context?.cwd) return context.cwd;
	const cwds: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const cwd = ref.session?.sessionManager?.getCwd();
		if (cwd && !cwds.includes(cwd)) cwds.push(cwd);
	}
	if (cwds.length === 1) return cwds[0] as string;
	return process.cwd();
}

export function settingsFromContext(context: ResolveContext | undefined): Settings | undefined {
	const raw = context?.settings;
	if (!raw || typeof raw !== "object") return undefined;
	if (typeof (raw as { get?: unknown }).get !== "function") return undefined;
	return raw as Settings;
}

export async function resolveListRepo(
	scheme: Scheme,
	parsedRepo: string | undefined,
	context: ResolveContext | undefined,
): Promise<string> {
	if (parsedRepo) return parsedRepo;
	const cwd = resolveCwd(context);
	try {
		return await resolveDefaultRepoMemoized(cwd, context?.signal);
	} catch (err) {
		const message = errorMessage(err);
		throw new Error(
			`${scheme}:// could not resolve a default repo from the current session: ${message}\nUse ${scheme}://<owner>/<repo> instead.`,
		);
	}
}

export interface IssueListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string } | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

export interface PrListItem extends IssueListItem {
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

export function formatListItem(scheme: Scheme, repo: string, item: IssueListItem | PrListItem): string {
	const number = item.number ?? "?";
	const title = item.title ?? "(no title)";
	const state = item.state?.toLowerCase() ?? "?";
	const author = item.author?.login ?? "?";
	const updated = item.updatedAt ?? item.createdAt ?? "";
	const draftSuffix = scheme === "pr" && (item as PrListItem).isDraft ? " [draft]" : "";
	const labels = (item.labels ?? [])
		.map(l => l.name)
		.filter(Boolean)
		.join(", ");
	const labelSuffix = labels ? `  labels: ${labels}` : "";
	const itemUrl = number === "?" ? `${scheme}://${repo}` : `${scheme}://${repo}/${number}`;
	return `- [${state}${draftSuffix}] #${number}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`;
}

export async function fetchAndRenderList(
	scheme: Scheme,
	options: ParsedList,
	url: InternalUrl,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const repo = await resolveListRepo(scheme, options.repo, context);
	const cwd = resolveCwd(context);
	const fields =
		scheme === "issue"
			? ["number", "title", "state", "author", "labels", "createdAt", "updatedAt", "url"]
			: [
					"number",
					"title",
					"state",
					"isDraft",
					"author",
					"baseRefName",
					"headRefName",
					"labels",
					"createdAt",
					"updatedAt",
					"url",
				];
	const args = [
		scheme,
		"list",
		"--repo",
		repo,
		"--state",
		options.state,
		"--limit",
		String(options.limit),
		"--json",
		fields.join(","),
	];
	if (options.author) args.push("--author", options.author);
	if (options.label) args.push("--label", options.label);

	const items =
		scheme === "issue"
			? await githubIssueJsonWithStateReasonFallback<Array<IssueListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				})
			: await git.github.json<Array<PrListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				});
	const header =
		scheme === "issue"
			? `# Issues in ${repo} (${options.state}, up to ${options.limit})`
			: `# Pull Requests in ${repo} (${options.state}, up to ${options.limit})`;
	const body =
		items.length === 0 ? "_No matches._" : items.map(item => formatListItem(scheme, repo, item)).join("\n\n");
	const footer = `\n\n---\nRead a specific item: \`${scheme}://${repo}/<N>\` (or \`${scheme}://<N>\` for the current repo).`;
	const rendered = `${header}\n\n${body}${footer}`;

	return {
		url: url.href,
		content: rendered,
		contentType: "text/markdown",
		size: Buffer.byteLength(rendered, "utf-8"),
		notes: [`Live listing for ${repo}`],
	};
}

export interface BuildSingleArgs {
	url: InternalUrl;
	scheme: Scheme;
	parsed: ParsedSingle;
	rendered: string;
	status: CacheStatus;
	fetchedAt: number;
	repo?: string;
}

export function buildSingleResource({
	url,
	scheme,
	parsed,
	rendered,
	status,
	fetchedAt,
	repo,
}: BuildSingleArgs): InternalResource {
	const notes: string[] = [formatFreshnessNote(status, fetchedAt)];
	if (!parsed.comments) notes.push("Comments disabled");
	if (scheme === "pr") {
		const repoSegment = repo ?? parsed.repo;
		const diffUrl = repoSegment ? `pr://${repoSegment}/${parsed.number}/diff` : `pr://${parsed.number}/diff`;
		notes.push(`Diff: ${diffUrl}`);
	}
	const content =
		status === "stale"
			? `> WARNING: Live GitHub refresh failed; this ${scheme} content is cached and may be stale.\n\n${rendered}`
			: rendered;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes,
	};
}

export function formatFileLine(idx: number, file: PrDiffFile, repo: string, prNumber: number): string {
	const stats = file.changeType === "binary" ? "(binary)" : `+${file.additions} -${file.deletions}`;
	const rename = file.oldPath ? `  (renamed from ${file.oldPath})` : "";
	return `${idx}. ${file.path}  ${stats}  [${file.changeType}]${rename}\n   pr://${repo}/${prNumber}/diff/${idx}`;
}

export async function fetchAndRenderPrDiff(
	url: InternalUrl,
	parsed: ParsedPrDiff,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const cwd = resolveCwd(context);
	let repo = parsed.repo;
	if (!repo) {
		try {
			repo = await resolveDefaultRepoMemoized(cwd, context?.signal);
		} catch (err) {
			const message = errorMessage(err);
			throw new Error(
				`pr://${parsed.number}/diff could not resolve a default repo from the current session: ${message}\nUse pr://<owner>/<repo>/${parsed.number}/diff.`,
			);
		}
	}
	const lookup = await getOrFetchPrDiff({
		cwd,
		repo,
		number: parsed.number,
		signal: context?.signal,
		settings: settingsFromContext(context),
	});
	const files = lookup.payload.files;
	const freshness = formatFreshnessNote(lookup.status, lookup.fetchedAt);

	if (parsed.mode === "all") {
		const content = lookup.payload.unified;
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [freshness, `Full diff for pr://${repo}/${parsed.number} (${formatCount("file", files.length)})`],
		};
	}

	if (parsed.mode === "slice") {
		const index = parsed.index ?? 0;
		if (index < 1 || index > files.length) {
			throw new Error(
				`pr://${repo}/${parsed.number}/diff/${index} is out of range; PR has ${formatCount("file", files.length)}. Use pr://${repo}/${parsed.number}/diff to list available indices.`,
			);
		}
		const file = files[index - 1];
		if (!file) {
			throw new Error(`pr://${repo}/${parsed.number}/diff/${index} resolved to a missing slice (parser bug).`);
		}
		const content = lookup.payload.unified.slice(file.startOffset, file.endOffset);
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				freshness,
				`Showing file ${index}/${files.length}: ${file.path}`,
				`Read all: pr://${repo}/${parsed.number}/diff/all`,
			],
		};
	}

	const header = `# Pull Request Diff: ${repo}#${parsed.number} (${formatCount("file", files.length)})`;
	const body =
		files.length === 0
			? "_No file changes._"
			: files.map((f, i) => formatFileLine(i + 1, f, repo, parsed.number)).join("\n\n");
	const footer = `\n\n---\nRead all: \`pr://${repo}/${parsed.number}/diff/all\`. Each file is also available as \`pr://${repo}/${parsed.number}/diff/<i>\`.`;
	const content = `${header}\n\n${body}${footer}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [freshness, `File listing for pr://${repo}/${parsed.number}`],
	};
}
