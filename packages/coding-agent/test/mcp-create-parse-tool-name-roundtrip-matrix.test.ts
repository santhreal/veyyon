/**
 * createMCPToolName / parseMCPToolName: sanitize, redundant prefix strip,
 * parse first underscore after mcp__, non-mcp null, empty fallbacks.
 */
import { describe, expect, it } from "bun:test";
import {
	createMCPToolName,
	parseMCPToolName,
} from "@veyyon/coding-agent/mcp/tool-bridge";

describe("createMCPToolName / parseMCPToolName matrix", () => {
	const pairs: Array<{
		server: string;
		tool: string;
		name: string;
		parsedServer: string;
		parsedTool: string;
	}> = [
		{
			server: "github",
			tool: "listIssues",
			name: "mcp__github_listissues",
			parsedServer: "github",
			parsedTool: "listissues",
		},
		{
			server: "puppeteer",
			tool: "puppeteer_screenshot",
			name: "mcp__puppeteer_screenshot",
			parsedServer: "puppeteer",
			parsedTool: "screenshot",
		},
		{
			server: "!!!",
			tool: "@@@",
			name: "mcp__server_tool",
			parsedServer: "server",
			parsedTool: "tool",
		},
		{
			server: "My Server",
			tool: "Do-Thing",
			name: "mcp__my_server_do_thing",
			parsedServer: "my",
			parsedTool: "server_do_thing",
		},
		{
			server: "gh",
			tool: "list_pull_requests",
			name: "mcp__gh_list_pull_requests",
			parsedServer: "gh",
			parsedTool: "list_pull_requests",
		},
		{
			server: "cloudflare:api",
			tool: "call",
			name: "mcp__cloudflare_api_call",
			parsedServer: "cloudflare",
			parsedTool: "api_call",
		},
	];

	for (const p of pairs) {
		it(`${p.server}/${p.tool} → ${p.name}`, () => {
			const name = createMCPToolName(p.server, p.tool);
			expect(name).toBe(p.name);
			expect(parseMCPToolName(name)).toEqual({
				serverName: p.parsedServer,
				toolName: p.parsedTool,
			});
		});
	}

	it("parse nulls for non-mcp and incomplete", () => {
		expect(parseMCPToolName("bash")).toBeNull();
		expect(parseMCPToolName("mcp__")).toBeNull();
		expect(parseMCPToolName("mcp__onlyserver")).toBeNull();
		expect(parseMCPToolName("")).toBeNull();
		expect(parseMCPToolName("MCP__x_y")).toBeNull();
	});

	it("create always starts with mcp__", () => {
		for (const [s, t] of [
			["a", "b"],
			["", ""],
			["X-Y", "Z Z"],
		] as const) {
			expect(createMCPToolName(s, t).startsWith("mcp__")).toBe(true);
		}
	});
});
