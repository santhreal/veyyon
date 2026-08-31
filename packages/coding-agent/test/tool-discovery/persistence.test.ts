import { describe, expect, it } from "bun:test";
import type { DiscoverableTool } from "@veyyon/coding-agent/tool-discovery/tool-index";
import {
	buildDiscoverableToolSearchIndex,
	searchDiscoverableTools,
} from "@veyyon/coding-agent/tool-discovery/tool-index";

describe("generic index: DiscoverableTool round-trip", () => {
	const tools: DiscoverableTool[] = [
		{
			name: "workspace_files",
			label: "workspace files",
			summary: "Find files matching a path pattern",
			source: "builtin",
			schemaKeys: ["input", "path"],
		},
		{
			name: "mcp__gh_search",
			label: "github/search",
			summary: "Search GitHub repositories",
			source: "mcp",
			serverName: "github",
			mcpToolName: "search",
			schemaKeys: ["query"],
		},
	];

	it("builds and searches without loss", () => {
		const index = buildDiscoverableToolSearchIndex(tools);
		expect(index.documents).toHaveLength(2);

		const findResults = searchDiscoverableTools(index, "find files", 3);
		expect(findResults.some(result => result.tool.name === "workspace_files")).toBe(true);

		const ghResults = searchDiscoverableTools(index, "github search", 3);
		expect(ghResults.some(result => result.tool.name === "mcp__gh_search")).toBe(true);
	});

	it("preserves source field in search results", () => {
		const index = buildDiscoverableToolSearchIndex(tools);
		const results = searchDiscoverableTools(index, "github", 3);
		const ghResult = results.find(result => result.tool.name === "mcp__gh_search");
		expect(ghResult).toBeDefined();
		expect(ghResult!.tool.source).toBe("mcp");
	});
});
