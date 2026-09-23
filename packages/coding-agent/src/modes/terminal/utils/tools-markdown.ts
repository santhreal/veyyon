import { escapeMarkdownTableCell } from "@veyyon/utils/markdown-table";
import type { Tool } from "../../../tools";
import { BUILTIN_TOOL_SUMMARIES, type BuiltinToolName } from "../../../tools/core/builtin-names";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<Pick<Tool, "description" | "name"> & { summary?: string }>;
}

/**
 * Extract a clean, human-readable one-sentence summary for a tool.
 *
 * Priority:
 * 1. Dedicated summary field on the tool instance (e.g. `tool.summary`).
 * 2. Curated built-in summary map for standard tools.
 * 3. First clean sentence extracted from the tool description, stripping XML tags,
 *    headings, and flattened markdown lists.
 */
export function extractToolSummary(tool: Pick<Tool, "description" | "name"> & { summary?: string }): string {
	if (typeof tool.summary === "string" && tool.summary.trim()) {
		return tool.summary.trim();
	}
	if (Object.hasOwn(BUILTIN_TOOL_SUMMARIES, tool.name)) {
		return BUILTIN_TOOL_SUMMARIES[tool.name as BuiltinToolName];
	}

	// Strip XML-like tags such as <instruction> and <critical>, then markdown headings.
	const strippedTags = (tool.description ?? "").replace(/<[^>]+>/g, " ");
	const strippedHeaders = strippedTags.replace(/^#+\s+[^\n]+/gm, " ");
	const flattened = strippedHeaders.replace(/\s+/g, " ").trim();
	const match = flattened.match(/^(.+?[.!?])(?:\s|$)/);
	return (match ? match[1] : flattened).trim() || "No description provided.";
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0) {
		return "No tools are currently visible to the agent.";
	}

	return [
		"| Tool | Description |",
		"|------|-------------|",
		...bindings.tools.map(tool => {
			const summary = extractToolSummary(tool);
			const description = escapeMarkdownTableCell(summary).trim() || "No description provided.";
			return `| \`${tool.name}\` | ${description} |`;
		}),
	].join("\n");
}
