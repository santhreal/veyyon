/**
 * What the search domain contributes.
 *
 * Finding things and rewriting what was found: the path/text/structure sweeps behind one `search`
 * tool, the structural rewriter, and the BM25 index over the tool catalogue itself.
 *
 * The factories stay dynamic for the reason the whole dispatch table does — a session that never
 * searches never parses the matchers, the tree-sitter grammars or the BM25 index — and this file is
 * one of the six the dynamic-import baseline names for it.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import type { BuiltinToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";

export const searchTools = {
	search: async s => new (await import("./search")).SearchTool(s),
	ast_edit: async s => new (await import("./ast-edit")).AstEditTool(s),
	search_tool_bm25: async s => (await import("./search-tool-bm25")).SearchToolBm25Tool.createIf(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const searchDomain: ToolDomainManifest<ToolFactory> = { domain: "search", tools: searchTools };
