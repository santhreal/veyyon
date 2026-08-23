import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isRecord, prompt } from "@veyyon/utils";
import { z } from "zod/v4";
import { toolsPrompts } from "../prompts/tools/rows";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { searchPathFilesystemTargets } from "./cwd-boundary";
import { executeFileSearch, type FileSearchDetails } from "./file-search";
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
			'TEXT/STRUCTURE ONLY — NEVER use with files; files put the complete scope/glob in input. Narrow scope: file, directory, glob, internal URL, or semicolon-delimited set. ssh:// is text-only. Omitted -> workspace root (".")',
		),
	case: z.boolean().optional().describe("text only: case-sensitive matching"),
	hidden: z.boolean().optional().describe("files only: include hidden files"),
	gitignore: z.boolean().optional().describe("files or text only: respect gitignore"),
	limit: z.number().optional().describe("files only: maximum results"),
	skip: z.number().optional().describe("text or structure only: results to skip for pagination"),
});

export type SearchToolInput = z.infer<typeof searchSchema>;
export type SearchType = SearchToolInput["type"];

export type SearchToolDetails =
	| { type: "files"; result: FileSearchDetails }
	| { type: "text"; result: TextSearchDetails }
	| { type: "structure"; result: StructureSearchDetails };

const TYPE_FIELDS: Record<SearchType, ReadonlySet<keyof SearchToolInput>> = {
	files: new Set(["type", "input", "hidden", "gitignore", "limit"]),
	text: new Set(["type", "input", "path", "case", "gitignore", "skip"]),
	structure: new Set(["type", "input", "path", "skip"]),
};

function rejectCrossTypeFields(params: SearchToolInput): void {
	const allowed = TYPE_FIELDS[params.type];
	if (!allowed) {
		throw new ToolError(`Invalid search type "${params.type}"`);
	}
	const invalid = Object.keys(params).filter(
		key => params[key as keyof SearchToolInput] !== undefined && !allowed.has(key as keyof SearchToolInput),
	);
	if (invalid.length === 0) return;
	throw new ToolError(`Search type "${params.type}" does not accept: ${invalid.join(", ")}`);
}

const SEARCH_TARGET_FIELDS: Record<SearchType, "input" | "path"> = {
	files: "input",
	text: "path",
	structure: "path",
};

function searchFilesystemTargets(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const type = args.type as SearchType | undefined;
	if (typeof type !== "string") return [];
	const targetField = SEARCH_TARGET_FIELDS[type];
	if (!targetField) return [];
	return searchPathFilesystemTargets(args[targetField]);
}

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly loadMode = "essential";
	readonly summary = "Search workspace files, text, or code structure";
	readonly parameters = searchSchema;
	readonly strict = true;
	readonly description: string;
	readonly filesystemTargets = searchFilesystemTargets;
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
					path: params.input,
					hidden: params.hidden,
					gitignore: params.gitignore,
					limit: params.limit,
				},
				signal,
				update,
				{ rootPathAlias: true },
			);
			if (!result.details) throw new ToolError("File search returned no result details");
			return { ...result, details: { type: "files", result: result.details } };
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
			if (!result.details) throw new ToolError("Text search returned no result details");
			return { ...result, details: { type: "text", result: result.details } };
		}

		const result = await executeStructureSearch(
			this.session,
			{ pattern: params.input, path: params.path, skip: params.skip },
			signal,
		);
		if (!result.details) throw new ToolError("Structure search returned no result details");
		return { ...result, details: { type: "structure", result: result.details } };
	}
}
