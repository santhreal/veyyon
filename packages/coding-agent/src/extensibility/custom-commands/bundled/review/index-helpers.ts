import { errorMessage, isRecord, prompt } from "@veyyon/utils";
import type { BundledCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import { requestsPrompts } from "../../../../prompts/requests/rows";
import * as gh from "../../../../tools/gh";

export interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

export interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
}

export interface CurrentReviewDiff {
	diffInstruction: string;
	diffText: string;
	emptyMessage?: string;
	mode: string;
}

export interface ReviewPrRef {
	repo: string;
	number: number;
	raw: string;
	kind: "github-url" | "pr-url";
}

export interface ParsedReviewArgs {
	prRef: ReviewPrRef | undefined;
	extraInstructions: string;
}

export type ReviewMenuChoice =
	| { kind: "detected-pr"; ref: ReviewPrRef }
	| { kind: "base-branch" }
	| { kind: "uncommitted" }
	| { kind: "commit" }
	| { kind: "custom" };

export const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },

	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },

	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

export function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

export function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];

		let linesAdded = 0;
		let linesRemoved = 0;

		const lines = chunk.split("\n");
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
		} else {
			files.push({
				path,
				linesAdded,
				linesRemoved,
				hunks: `diff --git ${chunk}`,
			});
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
		}
	}

	return { files, totalAdded, totalRemoved, excluded };
}

export function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

export function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

export function getDiffPreview(hunks: string, maxLines: number): string {
	const lines = hunks.split("\n");
	const contentLines: string[] = [];

	for (const line of lines) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

export const MAX_DIFF_CHARS = 50_000; // Don't include diff above this
export const MAX_FILES_FOR_INLINE_DIFF = 20; // Don't include diff if more files than this
export const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
export const DEFAULT_CONTEXT_INSTRUCTION = "MAY read full file context as needed via `read`";
export const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
export const JJ_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

export function buildReviewPrompt(
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	options: { additionalInstructions?: string; diffInstruction?: string; contextInstruction?: string } = {},
): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;

	const filesWithExt = stats.files.map(f => ({
		...f,
		ext: getFileExt(f.path),
		hunksPreview: skipDiff ? getDiffPreview(f.hunks, linesPerFile) : "",
	}));

	return prompt.render(requestsPrompts["requests/review"].text, {
		mode,
		files: filesWithExt,
		excluded: stats.excluded,
		totalAdded: stats.totalAdded,
		totalRemoved: stats.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions: options.additionalInstructions,
		diffInstruction: options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION,
		contextInstruction: options.contextInstruction ?? DEFAULT_CONTEXT_INSTRUCTION,
	});
}

export function buildCustomReviewPrompt(instructions: string): string {
	return prompt.render(requestsPrompts["requests/review-custom"].text, { instructions });
}

export function buildHeadlessReviewPrompt(focus?: string): string {
	return prompt.render(requestsPrompts["requests/review-headless"].text, { focus });
}

export const REVIEW_CONTEXT_PR_LIMIT = 3;
export const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const PR_SCHEME_PATTERN =
	/^pr:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([1-9]\d*)(?:\/diff(?:\/(?:all|[1-9]\d*))?)?$/;
export const PR_REF_TEXT_PATTERN =
	/https:\/\/github\.com\/[^\s<>"']+|pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s<>"']+/g;

export function stripTrailingPrRefPunctuation(text: string): string {
	return text.replace(/[.,)\]>]+$/g, "");
}

export function isValidRepoSegment(segment: string | undefined): segment is string {
	return segment !== undefined && REPO_SEGMENT_PATTERN.test(segment);
}

export function parsePositivePrNumber(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseGithubPrUrl(text: string): ReviewPrRef | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}

	if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[2] !== "pull") return undefined;

	const [owner, repo, , numberPart] = parts;
	if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return undefined;

	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "github-url" };
}

export function parsePrSchemeRef(text: string): ReviewPrRef | undefined {
	const match = PR_SCHEME_PATTERN.exec(text);
	if (!match) return undefined;

	const [, owner, repo, numberPart] = match;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "pr-url" };
}

export function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return parseGithubPrUrl(candidate) ?? parsePrSchemeRef(candidate);
}

export function buildPrLargeDiffInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST read assigned PR file diffs from \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\`; NEVER use local \`git diff\`/\`git show\` for PR diff content`;
}

export function buildPrContextInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST NOT read local workspace files for PR file context; use the fetched PR diff and \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\` only`;
}

export function extractReviewPrRefFromArgs(args: string[]): ParsedReviewArgs {
	let prRef: ReviewPrRef | undefined;
	let prRefIndex = -1;
	for (const [idx, arg] of args.entries()) {
		const parsed = parseReviewPrRef(arg);
		if (parsed) {
			prRef = parsed;
			prRefIndex = idx;
			break;
		}
	}

	return {
		prRef,
		extraInstructions: args.filter((_, idx) => idx !== prRefIndex).join(" "),
	};
}

export function extractReviewPrRefsFromText(text: string): ReviewPrRef[] {
	return Array.from(text.matchAll(PR_REF_TEXT_PATTERN), match => parseReviewPrRef(match[0])).filter(
		(ref): ref is ReviewPrRef => ref !== undefined,
	);
}

export function buildReviewPromptFromDiff(
	ctx: HookCommandContext,
	mode: string,
	diffText: string,
	extraInstructions: string | undefined,
	emptyMessage: string,
	options: { diffInstruction?: string; filteredMessage?: string; contextInstruction?: string } = {},
): string | undefined {
	if (!diffText.trim()) {
		if (ctx.hasUI) ctx.ui.notify(emptyMessage, "warning");
		return undefined;
	}

	const stats = parseDiff(diffText);
	if (stats.files.length === 0) {
		if (ctx.hasUI)
			ctx.ui.notify(options.filteredMessage ?? "No reviewable files (all changes filtered out)", "warning");
		return undefined;
	}

	return buildReviewPrompt(mode, stats, diffText, {
		additionalInstructions: extraInstructions,
		diffInstruction: options.diffInstruction,
		contextInstruction: options.contextInstruction,
	});
}

export async function buildPrReviewPrompt(
	api: BundledCommandAPI,
	ctx: HookCommandContext,
	ref: ReviewPrRef,
	extraInstructions: string,
): Promise<string | undefined> {
	let diffText: string;
	try {
		const lookup = await gh.getOrFetchPrDiff({ cwd: api.cwd, repo: ref.repo, number: ref.number });
		diffText = lookup.payload.unified;
	} catch (err) {
		const message = errorMessage(err);
		const failure = `Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${message}`;
		if (ctx.hasUI) {
			ctx.ui.notify(failure, "error");
			return undefined;
		}
		return failure;
	}

	const promptText = buildReviewPromptFromDiff(
		ctx,
		`PR ${ref.repo}#${ref.number}`,
		diffText,
		extraInstructions || undefined,
		`PR ${ref.repo}#${ref.number} has no diff content available`,
		{ diffInstruction: buildPrLargeDiffInstruction(ref), contextInstruction: buildPrContextInstruction(ref) },
	);
	if (promptText !== undefined || ctx.hasUI) return promptText;
	return `Unable to review PR ${ref.repo}#${ref.number}: no diff content available.`;
}

export function getTextContentParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		}
	}
	return parts;
}

export function findRecentPrRefs(ctx: HookCommandContext, limit: number): ReviewPrRef[] {
	const refs: ReviewPrRef[] = [];
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getBranch();

	for (let idx = entries.length - 1; idx >= 0 && refs.length < limit; idx--) {
		const entry = entries[idx];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const parts = getTextContentParts(message.content);
		for (let partIdx = parts.length - 1; partIdx >= 0; partIdx--) {
			const part = parts[partIdx];
			const partRefs = extractReviewPrRefsFromText(part);
			for (let refIdx = partRefs.length - 1; refIdx >= 0; refIdx--) {
				const ref = partRefs[refIdx];
				const key = `${ref.repo.toLowerCase()}#${ref.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push(ref);
				if (refs.length >= limit) break;
			}
			if (refs.length >= limit) break;
		}
	}

	return refs;
}
