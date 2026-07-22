/**
 * createMCPToolName × parseMCPToolName matrix: exact names and parse splits.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "../src/mcp/tool-bridge";

describe("createMCPToolName matrix", () => {
	const cases: Array<{ server: string; tool: string; name: string; parsed: { serverName: string; toolName: string } }> = [
		{ server: "a", tool: "b", name: "mcp__a_b", parsed: { serverName: "a", toolName: "b" } },
		{ server: "GH", tool: "List", name: "mcp__gh_list", parsed: { serverName: "gh", toolName: "list" } },
		{
			server: "exa",
			tool: "exa_search",
			name: "mcp__exa_search",
			parsed: { serverName: "exa", toolName: "search" },
		},
		{
			server: "s",
			tool: "a_b_c",
			name: "mcp__s_a_b_c",
			parsed: { serverName: "s", toolName: "a_b_c" },
		},
		{
			server: "!!!",
			tool: "???",
			name: "mcp__server_tool",
			parsed: { serverName: "server", toolName: "tool" },
		},
	];

	for (const c of cases) {
		it(`${c.server}/${c.tool} -> ${c.name}`, () => {
			const name = createMCPToolName(c.server, c.tool);
			expect(name).toBe(c.name);
			expect(parseMCPToolName(name)).toEqual(c.parsed);
		});
	}

	it("parse nulls", () => {
		expect(parseMCPToolName("")).toBeNull();
		expect(parseMCPToolName("mcp__")).toBeNull();
		expect(parseMCPToolName("mcp__only")).toBeNull();
		expect(parseMCPToolName("notmcp__a_b")).toBeNull();
	});
});
