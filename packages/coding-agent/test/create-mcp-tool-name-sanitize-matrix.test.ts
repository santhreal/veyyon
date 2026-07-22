/**
 * createMCPToolName sanitizes special characters in server and tool parts.
 * Why: tool names must stay mcp__{safe}_{safe} for provider schemas.
 * Sanitize: lowercases, non [a-z_] → _, collapse/trim underscores.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";

describe("createMCPToolName sanitize matrix", () => {
	const cases: [string, string, string][] = [
		["simple", "tool", "mcp__simple_tool"],
		["a-b", "c-d", "mcp__a_b_c_d"],
		["s", "t", "mcp__s_t"],
		["MyServer", "ListFiles", "mcp__myserver_listfiles"],
		["", "", "mcp__server_tool"],
		["my server", "list/files", "mcp__my_server_list_files"],
	];

	for (const [server, tool, expected] of cases) {
		it(`${JSON.stringify(server)}/${JSON.stringify(tool)} → ${expected}`, () => {
			expect(createMCPToolName(server, tool)).toBe(expected);
		});
	}

	it("spaces and slashes become underscores", () => {
		const name = createMCPToolName("my server", "list/files");
		expect(name).toBe("mcp__my_server_list_files");
		expect(parseMCPToolName(name)).toEqual({
			serverName: "my",
			toolName: "server_list_files",
		});
	});

	const servers = ["github", "exa", "s1", "cloudflare"];
	const tools = ["search", "get", "list_x", "a"];
	for (const s of servers) {
		for (const t of tools) {
			it(`roundtrip ${s}/${t}`, () => {
				const name = createMCPToolName(s, t);
				const p = parseMCPToolName(name)!;
				expect(createMCPToolName(p.serverName, p.toolName)).toBe(name);
			});
		}
	}
});
