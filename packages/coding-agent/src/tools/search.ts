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

const fileSearchSchema = type({
	mode: "'files'",
	"path?": type("string").describe(
		'glob, file, or directory to search — a single path or a semicolon-delimited list ("src/**/*.ts; test/**/*.ts"). Omitted -> searches the workspace root (".")',
	),
	"hidden?": type("boolean").describe("include hidden files"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"limit?": type("number").describe("max results"),
});

const textSearchSchema = type({
	mode: "'text'",
	pattern: type("string").describe("regex pattern"),
	"path?": type("string").describe(
		'file, directory, glob, internal URL, or "<file>:<lines>" selector to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"case?": type("boolean").describe("case-sensitive search"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"skip?": type("number")
		.or("null")
		.describe("files to skip before collecting results — use to paginate when the prior call hit the file limit"),
});

const astSearchSchema = type({
	mode: "'ast'",
	pattern: type("string").describe("AST pattern"),
	"path?": type("string").describe(
		'file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"skip?": type("number").describe("matches to skip"),
});

const fileAndTextSearchSchema = fileSearchSchema.or(textSearchSchema);
const fileAndAstSearchSchema = fileSearchSchema.or(astSearchSchema);
const textAndAstSearchSchema = textSearchSchema.or(astSearchSchema);
const searchDisabledSchema = type({ mode: "'disabled'" });
export const searchSchema = fileAndTextSearchSchema.or(astSearchSchema);
export type UnifiedSearchToolParams = typeof searchSchema.infer;

type SearchMode = UnifiedSearchToolParams["mode"];

export interface SearchToolDetails {
	mode: SearchMode;
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
			capabilities.files ? "files" : undefined,
			capabilities.text ? "source text" : undefined,
			capabilities.ast ? "AST structure" : undefined,
		].filter((value): value is string => value !== undefined);
		return enabled.length > 0 ? `Search ${enabled.join(", ")}` : "Search is disabled";
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
		if (capabilities.files && capabilities.text) return fileAndTextSearchSchema as unknown as typeof searchSchema;
		if (capabilities.files && capabilities.ast) return fileAndAstSearchSchema as unknown as typeof searchSchema;
		if (capabilities.text && capabilities.ast) return textAndAstSearchSchema as unknown as typeof searchSchema;
		if (capabilities.files) return fileSearchSchema as unknown as typeof searchSchema;
		if (capabilities.text) return textSearchSchema as unknown as typeof searchSchema;
		if (capabilities.ast) return astSearchSchema as unknown as typeof searchSchema;
		return searchDisabledSchema as unknown as typeof searchSchema;
	}

	readonly approval = (args: unknown): ToolApprovalDecision => {
		if (!isRecord(args) || args.mode !== "text") return "read";
		return this.#grep.approval({ path: typeof args.path === "string" ? args.path : undefined });
	};

	readonly filesystemTargets = (args: unknown): string[] => searchPathFilesystemTargets(args);

	get examples(): readonly ToolExample<UnifiedSearchToolParams>[] {
		const capabilities = this.#capabilities();
		const examples: ToolExample<UnifiedSearchToolParams>[] = [];
		if (capabilities.files) {
			examples.push({
				caption: "Find TypeScript files",
				call: { mode: "files", path: "src/**/*.ts" },
			});
		}
		if (capabilities.text) {
			examples.push({
				caption: "Search text with a regular expression",
				call: { mode: "text", pattern: "TODO|FIXME", path: "src" },
			});
		}
		if (capabilities.ast) {
			examples.push({
				caption: "Search TypeScript syntax",
				call: { mode: "ast", pattern: "console.log($$$)", path: "src/**/*.ts" },
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
		if (params.mode === "files") {
			if (!this.#capabilities().files) throw new ToolError("File search is disabled in this session");
			const delegated = {
				path: params.path,
				hidden: params.hidden,
				gitignore: params.gitignore,
				limit: params.limit,
			};
			const updates: AgentToolUpdateCallback<GlobToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { mode: "files", details: update.details } })
				: undefined;
			const result = await this.#glob.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { mode: "files", details: result.details } };
		}
		if (params.mode === "text") {
			if (!this.#capabilities().text) throw new ToolError("Text search is disabled in this session");
			const delegated = {
				pattern: params.pattern,
				path: params.path,
				case: params.case,
				gitignore: params.gitignore,
				skip: params.skip,
			};
			const updates: AgentToolUpdateCallback<GrepToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { mode: "text", details: update.details } })
				: undefined;
			const result = await this.#grep.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { mode: "text", details: result.details } };
		}
		if (params.mode === "ast") {
			if (!this.#capabilities().ast) throw new ToolError("AST search is disabled in this session");
			const delegated = { pat: params.pattern, path: params.path, skip: params.skip };
			const updates: AgentToolUpdateCallback<AstGrepToolDetails> | undefined = onUpdate
				? update => onUpdate({ content: update.content, details: { mode: "ast", details: update.details } })
				: undefined;
			const result = await this.#astGrep.execute(toolCallId, delegated, signal, updates, context);
			return { content: result.content, details: { mode: "ast", details: result.details } };
		}
		throw new ToolError("Unsupported search mode");
	}
}
