import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isRecord, prompt, trimTrailingSlashes } from "@veyyon/utils";
import { z } from "zod/v4";
import { toolsPrompts } from "../prompts/tools/rows";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { searchPathFilesystemTargets } from "./cwd-boundary";
import { executeFileSearch, type FileSearchDetails } from "./file-search";
import type { OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntriesSync,
	hasGlobPathChars,
	isInternalUrlPath,
	normalizePathLikeInput,
	parseFindPattern,
	toPathList,
} from "./path-utils";
import { executeStructureSearch, type StructureSearchDetails } from "./structure-search";
import { executeTextSearch, type TextSearchDetails, textSearchApproval } from "./text-search";
import { ToolError } from "./tool-errors";

export const searchSchema = z.strictObject({
	type: z
		.enum(["files", "text", "structure"])
		.describe(
			"representation to match: files for paths and repository layout, text for syntax-irrelevant content, structure for code syntax and relationships",
		),
	input: z
		.string()
		.describe(
			"type-specific match: path or glob for files, literal or regular expression for text, or one valid code pattern for structure; text and structure scopes belong in path",
		),
	path: z
		.string()
		.optional()
		.describe(
			'Scope. text/structure: file, directory, glob, internal URL, or semicolon-delimited set; ssh:// is text-only. files: a directory the globs in input are searched under, so { path: "src", input: "*.ts" } is src/**/*.ts. Omitted -> workspace root (".")',
		),
	case: z
		.boolean()
		.optional()
		.describe("text only: case-sensitive matching, on by default; pass false to match case-insensitively"),
	paths: z
		.boolean()
		.optional()
		.describe("text only: return the matching file paths with per-file counts instead of match lines"),
	hidden: z.boolean().optional().describe("files only: include hidden files"),
	gitignore: z.boolean().optional().describe("files or text only: respect gitignore"),
	limit: z.number().optional().describe("files only: maximum results"),
	skip: z.number().optional().describe("text or structure only: results to skip for pagination"),
});

export type SearchToolInput = z.infer<typeof searchSchema>;
export type SearchType = SearchToolInput["type"];

/**
 * The three sub-searches attach their own `OutputMeta`, and the shared layer in
 * `output-meta.ts` reads it at `details.meta`: it appends the truncation and
 * limit notice to the model text, and skips a result the tool already spilled.
 * Nesting the sub-result under `result` put that meta one level out of reach, so
 * a capped `search` said nothing to the model about the cap and an already
 * spilled result was spilled a second time. The renderer keeps reading the inner
 * copy through `details.result`.
 */
export type SearchToolDetails =
	| { type: "files"; result: FileSearchDetails; meta?: OutputMeta }
	| { type: "text"; result: TextSearchDetails; meta?: OutputMeta }
	| { type: "structure"; result: StructureSearchDetails; meta?: OutputMeta };

/** Fields each search type accepts. A result that advises a field outside its own
 * set costs the caller a rejected call and a round trip, so this is the set a
 * pagination or limit notice may name. */
export const TYPE_FIELDS: Record<SearchType, ReadonlySet<keyof SearchToolInput>> = {
	files: new Set(["type", "input", "path", "hidden", "gitignore", "limit"]),
	text: new Set(["type", "input", "path", "case", "paths", "gitignore", "skip"]),
	structure: new Set(["type", "input", "path", "skip"]),
};

/**
 * A file search's `path` is the directory its `input` globs are searched
 * under, the way `path` scopes a text search. Every entry of `input` keeps the
 * meaning it has on its own: a leading glob stays recursive (`*.ts` under
 * `src` is `src/**` + `/*.ts`), a directory-prefixed glob keeps its depth, and
 * a bare directory lists itself. The scope is one directory: a glob, an
 * internal URL or an absolute `input` has nowhere to be scoped under, and each
 * is rejected with the spelling that works. Sync, because the approval
 * boundary reads the same targets before the call runs.
 */
export function scopeFilePatterns(scope: string, input: string, cwd: string): string[] {
	const trimmed = normalizePathLikeInput(scope).replace(/\\/g, "/");
	// `/` reads as the workspace root here as it does in `input`.
	const base = /^\/+$/.test(trimmed) ? "." : trimTrailingSlashes(trimmed);
	if (base.length === 0) {
		throw new ToolError('File search `path` must name a directory; omit it to search from the workspace root (".")');
	}
	if (hasGlobPathChars(base) || isInternalUrlPath(base)) {
		throw new ToolError(
			`File search \`path\` is the directory to search under, not a pattern: put ${base} in \`input\` and drop \`path\`, or set \`path\` to the directory and \`input\` to the glob.`,
		);
	}
	const entries = expandDelimitedPathEntriesSync(toPathList(input), cwd, { splitter: parseFindPattern });
	const scoped: string[] = [];
	for (const entry of entries) {
		const pattern = normalizePathLikeInput(entry).replace(/\\/g, "/");
		if (pattern.length === 0) continue;
		if (isInternalUrlPath(pattern)) {
			throw new ToolError(
				`File search \`input\` ${pattern} is an internal URL and cannot be scoped under \`path\`; drop \`path\`.`,
			);
		}
		if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern)) {
			throw new ToolError(
				`File search \`input\` ${pattern} is absolute and cannot be scoped under \`path\` ${base}; make \`input\` relative to \`path\`, or drop \`path\`.`,
			);
		}
		if (pattern === ".") {
			scoped.push(base);
			continue;
		}
		const parsed = parseFindPattern(pattern);
		const relative =
			parsed.basePath === "." ? parsed.globPattern : `${trimTrailingSlashes(parsed.basePath)}/${parsed.globPattern}`;
		scoped.push(`${base}/${relative}`);
	}
	if (scoped.length === 0) {
		throw new ToolError("`input` must contain non-empty globs or paths");
	}
	return scoped;
}

/** The `input` a file search runs, with `path` folded in when it was given. */
function fileSearchInput(params: Pick<SearchToolInput, "input" | "path">, cwd: string): string {
	if (params.path === undefined) return params.input;
	const scoped = scopeFilePatterns(params.path, params.input, cwd);
	return scoped.length === 1 ? scoped[0] : JSON.stringify(scoped);
}

function rejectCrossTypeFields(params: SearchToolInput): void {
	const allowed = TYPE_FIELDS[params.type];
	if (!allowed) {
		throw new ToolError(`Invalid search type "${params.type}"`);
	}
	const invalid = Object.keys(params).filter(
		key => params[key as keyof SearchToolInput] !== undefined && !allowed.has(key as keyof SearchToolInput),
	);
	if (invalid.length === 0) return;
	// The rejection is a whole request the caller paid for, so it states the set
	// that would have worked rather than leaving the retry to a guess. A model in
	// a real trial sent `limit` to a text search, read "does not accept: limit",
	// and spent a second call rediscovering the field by removing it.
	throw new ToolError(
		`Search type "${params.type}" does not accept: ${invalid.join(", ")}. It accepts: ${[...allowed].join(", ")}.`,
	);
}

const SEARCH_TARGET_FIELDS: Record<SearchType, "input" | "path"> = {
	files: "input",
	text: "path",
	structure: "path",
};

function searchFilesystemTargets(args: unknown, cwd?: string): string[] {
	if (!isRecord(args)) return [];
	const type = args.type as SearchType | undefined;
	if (typeof type !== "string") return [];
	const targetField = SEARCH_TARGET_FIELDS[type];
	if (!targetField) return [];
	if (type === "files" && typeof args.path === "string" && typeof args.input === "string") {
		// The boundary reads what the call will scan. A scope the call rejects
		// scans nothing, and both fields together are the conservative read.
		try {
			return searchPathFilesystemTargets(scopeFilePatterns(args.path, args.input, cwd ?? process.cwd()), cwd);
		} catch {
			return searchPathFilesystemTargets([args.path, args.input], cwd);
		}
	}
	return searchPathFilesystemTargets(args[targetField], cwd);
}

/**
 * Reduce a text result to the files that matched. A locate query pays for
 * every match line and its context even when the answer is a path: measured
 * over this repository, `buildSystemPrompt` under packages/coding-agent/src
 * costs 3,492 tokens as match lines and 215 as a file list. The bash
 * interceptor redirects `rg -l` here, so the mode has to be reachable here.
 *
 * A per-file count is the number of matches the search reported, which the
 * per-file cap can hold below the true number, so a capped result says so
 * rather than presenting a cap as a count.
 */
function projectToMatchingPaths(result: AgentToolResult<TextSearchDetails>): AgentToolResult<TextSearchDetails> {
	const details = result.details;
	const fileMatches = details?.fileMatches ?? [];
	if (fileMatches.length === 0) return result;
	const lines = [
		`${fileMatches.length} file${fileMatches.length === 1 ? "" : "s"} matched (${details?.matchCount ?? 0} matches):`,
		...fileMatches.map(entry => `${entry.path}: ${entry.count}`),
	];
	if ((details?.perFileLimitReached ?? 0) > 0) {
		lines.push("A count at the per-file cap is a floor, not a total.");
	}
	if ((details?.fileLimitReached ?? 0) > 0) {
		lines.push("More files matched than are listed; page with `skip`.");
	}
	if (details?.missingPaths?.length) {
		lines.push(`Paths not found: ${details.missingPaths.join(", ")}`);
	}
	const text = lines.join("\n");
	return {
		...result,
		content: [{ type: "text", text }],
		details: { ...details, displayContent: text, pathsOnly: true },
	};
}

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly loadMode = "essential";
	readonly summary = "Search workspace files, text, or code structure";
	readonly parameters = searchSchema;
	readonly strict = true;
	readonly description: string;
	readonly filesystemTargets = (args: unknown, cwd = this.session.cwd): string[] => searchFilesystemTargets(args, cwd);
	readonly examples: readonly ToolExample<SearchToolInput>[] = [
		{
			caption: "Find TypeScript files",
			call: { type: "files", input: "src/**/*.ts" },
		},
		{
			caption: "Find syntax-irrelevant text",
			call: { type: "text", input: "TODO|FIXME", path: "src" },
		},
		{
			caption: "Find TypeScript call structure",
			call: { type: "structure", input: "console.log($$$)", path: "src/**/*.ts" },
		},
	];

	readonly approval = (args: unknown): ToolTier => {
		if (!isRecord(args) || args.type !== "text") return "read";
		return textSearchApproval({ path: args.path });
	};

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(toolsPrompts["tools/search"].text, {
			HASH_LINES: displayMode.hashLines,
			LINE_NUMBERS: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async execute(
		_toolCallId: string,
		params: SearchToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SearchToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		if (params.input.trim().length === 0) throw new ToolError("Search input must not be empty");
		rejectCrossTypeFields(params);

		if (params.type === "files") {
			const update: AgentToolUpdateCallback<FileSearchDetails> | undefined = onUpdate
				? event => {
						const partial: AgentToolResult<SearchToolDetails> = { content: event.content };
						if (event.details) partial.details = { type: "files", result: event.details };
						if (event.isError !== undefined) partial.isError = event.isError;
						if (event.useless !== undefined) partial.useless = event.useless;
						onUpdate(partial);
					}
				: undefined;
			const result = await executeFileSearch(
				this.session,
				{
					path: fileSearchInput(params, this.session.cwd),
					hidden: params.hidden,
					gitignore: params.gitignore,
					limit: params.limit,
				},
				signal,
				update,
				{ rootPathAlias: true },
			);
			if (!result.details) throw new ToolError("File search returned no result details");
			return { ...result, details: { type: "files", result: result.details, meta: result.details.meta } };
		}

		if (params.type === "text") {
			const result = await executeTextSearch(
				this.session,
				{
					pattern: params.input,
					path: params.path,
					case: params.case,
					gitignore: params.gitignore,
					skip: params.skip,
				},
				signal,
			);
			const projected = params.paths === true ? projectToMatchingPaths(result) : result;
			if (!projected.details) throw new ToolError("Text search returned no result details");
			return { ...projected, details: { type: "text", result: projected.details, meta: projected.details.meta } };
		}

		const result = await executeStructureSearch(
			this.session,
			{ pattern: params.input, path: params.path, skip: params.skip },
			signal,
		);
		if (!result.details) throw new ToolError("Structure search returned no result details");
		// Each type's own meta is hoisted onto the wrapper, because the output layer
		// reads `details.meta` and would otherwise see the wrapper's `undefined`.
		return { ...result, details: { type: "structure", result: result.details, meta: result.details.meta } };
	}
}
