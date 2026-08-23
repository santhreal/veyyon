import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isRecord, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import {
	executeStructureSearch,
	type StructureSearchDetails,
} from "./ast-grep";
import { searchPathFilesystemTargets } from "./cwd-boundary";
import { executeFileSearch, type FileSearchDetails } from "./glob";
import {
	executeTextSearch,
	type TextSearchDetails,
	textSearchApproval,
} from "./grep";
import { ToolError } from "./tool-errors";

export const searchSchema = type({
	type: type.enumerated("files", "text", "structure").describe(
		"representation to match: files for paths and repository layout, text for syntax-irrelevant content, structure for code syntax and relationships",
	),
	input: type("string").describe(
		"what to match: a path or glob for files, a literal or regular expression for text, or one valid structural code pattern for structure",
	),
	"path?": type("string").describe(
		'text or structure only: file, directory, glob, internal URL, or semicolon-delimited search scope. Omitted -> workspace root (".")',
	),
	"case?": type("boolean").describe("text only: case-sensitive matching"),
	"hidden?": type("boolean").describe("files only: include hidden files"),
	"gitignore?": type("boolean").describe("files or text only: respect gitignore"),
	"limit?": type("number").describe("files only: maximum results"),
	"skip?": type("number").describe("text or structure only: results to skip for pagination"),
});

export type SearchToolInput = typeof searchSchema.infer;
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
	const invalid = Object.keys(params).filter(key => !allowed.has(key as keyof SearchToolInput));
	if (invalid.length === 0) return;
	throw new ToolError(`Search type "${params.type}" does not accept: ${invalid.join(", ")}`);
}

function searchFilesystemTargets(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const type = args.type;
	if (type === "files") {
		return searchPathFilesystemTargets({ path: typeof args.input === "string" ? args.input : undefined });
	}
	return searchPathFilesystemTargets({ path: typeof args.path === "string" ? args.path : undefined });
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
		return textSearchApproval({ path: typeof args.path === "string" ? args.path : undefined });
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
				? event => onUpdate({ content: event.content, details: { type: "files", result: event.details } })
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
			);
			return { content: result.content, details: { type: "files", result: result.details } };
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
			return { content: result.content, details: { type: "text", result: result.details } };
		}

		const result = await executeStructureSearch(
			this.session,
			{ pattern: params.input, path: params.path, skip: params.skip },
			signal,
		);
		return { content: result.content, details: { type: "structure", result: result.details } };
	}
}
