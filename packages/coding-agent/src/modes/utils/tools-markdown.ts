import type { Tool } from "../../tools";
import { escapeMarkdownTableCell } from "../../utils/markdown-table";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<Pick<Tool, "description" | "name">>;
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0) {
		return "No tools are currently visible to the agent.";
	}

	return [
		"| Tool | Description |",
		"|------|-------------|",
		...bindings.tools.map(tool => {
			// Trim after escaping so an all-whitespace description collapses to "" and
			// falls back, matching the prior behavior.
			const description = escapeMarkdownTableCell(tool.description).trim() || "No description provided.";
			return `| \`${tool.name}\` | ${description} |`;
		}),
	].join("\n");
}
