import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isRecord, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import { AstGrepTool, type AstGrepToolDetails } from "./ast-grep";
import { searchPathFilesystemTargets } from "./cwd-boundary";
import { GlobTool, type GlobToolDetails } from "./glob";
import { GrepTool, type GrepToolDetails } from "./grep";
import { ToolError } from "./tool-errors";

const searchPathSchema = type("string").describe(
	'file, directory, glob, internal URL, or semicolon-delimited set to search. Omitted -> searches the workspace root (".")',
);
const searchPatternSchema = type("string").describe(
	'required for match and analyze; match: a literal or regular expression; analyze: one valid AST node such as "console.log($$$)"',
);
const locateSearchFields = {
	"hidden?": type("boolean").describe("locate only: include hidden files"),
	"limit?": type("number").describe("locate only: max results"),
} as const;
const matchSearchFields = {
	"case?": type("boolean").describe("match only: case-sensitive search"),
} as const;
const gitignoreSearchField = type("boolean").describe("locate or match: respect gitignore");
const skipSearchField = type("number").describe("match or analyze: matches to skip");
const pathSearchFields = {
	"path?": searchPathSchema,
} as const;
const patternedSearchFields = {
	"pattern?": searchPatternSchema,
} as const;

const locateSearchSchema = type({
	purpose: type.enumerated("locate").describe("locate paths, files, directories, extensions, or repository layout"),
	...pathSearchFields,
	...locateSearchFields,
	"gitignore?": gitignoreSearchField,
});
const matchSearchSchema = type({
	purpose: type
		.enumerated("match")
		.describe("match text whose syntax role is irrelevant: literals, documentation, configuration, or regex"),
	...pathSearchFields,
	...patternedSearchFields,
	...matchSearchFields,
	"gitignore?": gitignoreSearchField,
	"skip?": skipSearchField,
});
const analyzeSearchSchema = type({
	purpose: type
		.enumerated("analyze")
		.describe(
			"analyze code structure: definitions, calls, methods, types, imports, operators, or node relationships",
		),
	...pathSearchFields,
	...patternedSearchFields,
	"skip?": skipSearchField,
});
const locateAndMatchSearchSchema = type({
	purpose: type.enumerated("locate", "match").describe("locate paths or match syntax-irrelevant text"),
	...pathSearchFields,
	...patternedSearchFields,
	...locateSearchFields,
	...matchSearchFields,
	"gitignore?": gitignoreSearchField,
	"skip?": skipSearchField,
});
const locateAndAnalyzeSearchSchema = type({
	purpose: type.enumerated("locate", "analyze").describe("locate paths or analyze code structure"),
	...pathSearchFields,
	...patternedSearchFields,
	...locateSearchFields,
	"gitignore?": gitignoreSearchField,
	"skip?": skipSearchField,
});
const matchAndAnalyzeSearchSchema = type({
	purpose: type.enumerated("match", "analyze").describe("match syntax-irrelevant text or analyze code structure"),
	...pathSearchFields,
	...patternedSearchFields,
	...matchSearchFields,
	"gitignore?": gitignoreSearchField,
	"skip?": skipSearchField,
});
const searchDisabledSchema = type({ purpose: "'disabled'" });
export const searchSchema = type({
	purpose: type
		.enumerated("locate", "match", "analyze")
		.describe("locate paths, match syntax-irrelevant text, or analyze code structure"),
	...pathSearchFields,
	...patternedSearchFields,
	...locateSearchFields,
	...matchSearchFields,
	"gitignore?": gitignoreSearchField,
	"skip?": skipSearchField,
});
export type UnifiedSearchToolParams = typeof searchSchema.infer;

type SearchPurpose = UnifiedSearchToolParams["purpose"];

export interface SearchToolDetails {
	purpose: SearchPurpose;
	details?: GlobToolDetails | GrepToolDetails | AstGrepToolDetails;
}

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly loadMode = "essential";
	readonly strict = true;
	readonly #glob: GlobTool;
	readonly #grep: GrepTool;
	readonly #astGrep: AstGrepTool;

	get summary(): string {
		const capabilities = this.#capabilities();
		const enabled = [
			capabilities.files ? "locate paths" : undefined,
			capabilities.text ? "match exact content" : undefined,
			capabilities.ast ? "analyze code structure" : undefined,
		].filter((value): value is string => value !== undefined);
		return enabled.length > 0 ? `Workspace search: ${enabled.join(", ")}` : "Workspace search is disabled";
	}

	get description(): string {
		const capabilities = this.#capabilities();
		return prompt.render(toolsPrompts["tools/search"].text, {
			FILES_ENABLED: capabilities.files,
			TEXT_ENABLED: capabilities.text,
			AST_ENABLED: capabilities.ast,
		});
	}

	get parameters(): typeof searchSchema {
		const capabilities = this.#capabilities();
		if (capabilities.files && capabilities.text && capabilities.ast) return searchSchema;
		if (capabilities.files && capabilities.text) return locateAndMatchSearchSchema as unknown as typeof searchSchema;
		if (capabilities.files && capabilities.ast) return locateAndAnalyzeSearchSchema as unknown as typeof searchSchema;
		if (capabilities.text && capabilities.ast) return matchAndAnalyzeSearchSchema as unknown as typeof searchSchema;
		if (capabilities.files) return locateSearchSchema as unknown as typeof searchSchema;
		if (capabilities.text) return matchSearchSchema as unknown as typeof searchSchema;
		if (capabilities.ast) return analyzeSearchSchema as unknown as typeof searchSchema;
		return searchDisabledSchema as unknown as typeof searchSchema;
	}

	readonly approval = (args: unknown): ToolApprovalDecision => {
		if (!isRecord(args) || args.purpose !== "match") return "read";
		return this.#grep.approval({ path: typeof args.path === "string" ? args.path : undefined });
	};

	readonly filesystemTargets = (args: unknown): string[] => searchPathFilesystemTargets(args);

	get examples(): readonly ToolExample<UnifiedSearchToolParams>[] {
		const capabilities = this.#capabilities();
		const examples: ToolExample<UnifiedSearchToolParams>[] = [];
		if (capabilities.files) {
			examples.push({
				caption: "Locate TypeScript files",
				call: { purpose: "locate", path: "src/**/*.ts" },
			});
		}
		if (capabilities.text) {
			examples.push({
				caption: "Find exact text with a regular expression",
				call: { purpose: "match", pattern: "TODO|FIXME", path: "src" },
			});
		}
		if (capabilities.ast) {
			examples.push({
				caption: "Analyze TypeScript call structure",
				call: { purpose: "analyze", pattern: "console.log($$$)", path: "src/**/*.ts" },
			});
		}
		return examples;
	}

	constructor(private readonly session: ToolSession) {
		this.#glob = new GlobTool(session, { rootPathAlias: true });
		this.#grep = new GrepTool(session);
		this.#astGrep = new AstGrepTool(session);
	}

	#capabilities(): { files: boolean; text: boolean; ast: boolean } {
		return {
			files: this.session.settings.get("glob.enabled") ?? true,
			text: this.session.settings.get("grep.enabled") ?? true,
			ast: this.session.settings.get("astGrep.enabled") ?? true,
		};
	}

	async execute(
		toolCallId: string,
		params: UnifiedSearchToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SearchToolDetails, typeof searchSchema>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		if (params.purpose === "locate") {
			if (!this.#capabilities().files) throw new ToolError("Path location is disabled in this session");
			const delegated = {
				path: params.path,
				hidden: params.hidden,
				gitignore: params.gitignore,
				limit: params.limit,
			};
			const updates: AgentToolUpdateCallback<GlobToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { purpose: "locate", details: update.details } })
				: undefined;
			const result = await this.#glob.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { purpose: "locate", details: result.details } };
		}
		if (params.purpose === "match") {
			if (!this.#capabilities().text) throw new ToolError("Content matching is disabled in this session");
			if (params.pattern === undefined) throw new ToolError("Content matching requires a pattern");
			const delegated = {
				pattern: params.pattern,
				path: params.path,
				case: params.case,
				gitignore: params.gitignore,
				skip: params.skip,
			};
			const updates: AgentToolUpdateCallback<GrepToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { purpose: "match", details: update.details } })
				: undefined;
			const result = await this.#grep.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { purpose: "match", details: result.details } };
		}
		if (params.purpose === "analyze") {
			if (!this.#capabilities().ast) throw new ToolError("Structural code analysis is disabled in this session");
			if (params.pattern === undefined) throw new ToolError("Structural code analysis requires a pattern");
			const delegated = { pat: params.pattern, path: params.path, skip: params.skip };
			const updates: AgentToolUpdateCallback<AstGrepToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { purpose: "analyze", details: update.details } })
				: undefined;
			const result = await this.#astGrep.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { purpose: "analyze", details: result.details } };
		}
		throw new ToolError("Unsupported search purpose");
	}
}
