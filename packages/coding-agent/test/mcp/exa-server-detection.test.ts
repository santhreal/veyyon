import { describe, expect, it } from "bun:test";
import { isExaMCPServer } from "@veyyon/coding-agent/mcp/config";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";

/**
 * isExaMCPServer decides whether a configured MCP server is Exa, which gates Exa-specific handling
 * downstream. It had no direct test. A false negative disables that handling; a false positive
 * misroutes a non-Exa server. Pinned: the name "exa" (case-insensitive) always matches; an http/sse
 * server matches when its url contains mcp.exa.ai; a stdio (or type-less) server matches when any
 * arg contains mcp.exa.ai; a url field on a stdio config is ignored (only http/sse read url).
 */

describe("isExaMCPServer", () => {
	it("matches the reserved name exa case-insensitively", () => {
		expect(isExaMCPServer("exa", { type: "stdio", command: "x" } as MCPServerConfig)).toBe(true);
		expect(isExaMCPServer("EXA", { type: "stdio", command: "x" } as MCPServerConfig)).toBe(true);
	});

	it("matches an http or sse server whose url contains mcp.exa.ai (case-insensitive)", () => {
		expect(isExaMCPServer("srv", { type: "http", url: "https://mcp.exa.ai/mcp" } as MCPServerConfig)).toBe(true);
		expect(isExaMCPServer("srv", { type: "sse", url: "https://MCP.EXA.AI/x" } as MCPServerConfig)).toBe(true);
		expect(isExaMCPServer("srv", { type: "http", url: "https://example.com" } as MCPServerConfig)).toBe(false);
	});

	it("matches a stdio or type-less server when an arg contains the exa mcp url", () => {
		expect(
			isExaMCPServer("srv", {
				type: "stdio",
				command: "npx",
				args: ["mcp-remote", "https://mcp.exa.ai/mcp"],
			} as MCPServerConfig),
		).toBe(true);
		expect(isExaMCPServer("srv", { command: "npx", args: ["https://mcp.exa.ai"] } as MCPServerConfig)).toBe(true);
		expect(isExaMCPServer("srv", { type: "stdio", command: "npx", args: ["other"] } as MCPServerConfig)).toBe(false);
	});

	it("ignores a url field on a stdio config (only http/sse read url)", () => {
		expect(
			isExaMCPServer("srv", {
				type: "stdio",
				command: "x",
				url: "https://mcp.exa.ai",
			} as unknown as MCPServerConfig),
		).toBe(false);
	});
});
