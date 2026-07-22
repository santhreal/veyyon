/**
 * createMCPToolName / parseMCPToolName round-trip grid for server×tool pairs.
 * Why: tool routing depends on mcp__{server}_{tool} and parse must recover parts.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";

describe("mcp tool name create parse roundtrip grid", () => {
	const servers = ["github", "exa", "s1", "my-server", "a.b"];
	const tools = ["search", "list_files", "t", "read-resource", "x_y"];

	for (const server of servers) {
		for (const tool of tools) {
			it(`${server} / ${tool}`, () => {
				const name = createMCPToolName(server, tool);
				expect(name.startsWith("mcp__")).toBe(true);
				const parsed = parseMCPToolName(name);
				expect(parsed).not.toBeNull();
				// server is sanitized; tool may have server_ prefix stripped
				expect(parsed!.serverName.length).toBeGreaterThan(0);
				expect(parsed!.toolName.length).toBeGreaterThan(0);
				// re-create from parsed parts yields same name
				expect(createMCPToolName(parsed!.serverName, parsed!.toolName)).toBe(name);
			});
		}
	}

	it("parse rejects non-mcp prefix", () => {
		expect(parseMCPToolName("bash")).toBeNull();
		expect(parseMCPToolName("mcp_")).toBeNull();
		expect(parseMCPToolName("")).toBeNull();
		expect(parseMCPToolName("mcp__onlyserver")).toBeNull(); // no underscore after server
	});

	it("create strips redundant server_ tool prefix", () => {
		const name = createMCPToolName("github", "github_search");
		// after strip: mcp__github_search
		expect(name).toBe("mcp__github_search");
		const p = parseMCPToolName(name);
		expect(p).toEqual({ serverName: "github", toolName: "search" });
	});

	it("exact known forms", () => {
		expect(createMCPToolName("s", "t")).toBe("mcp__s_t");
		expect(parseMCPToolName("mcp__s_t")).toEqual({ serverName: "s", toolName: "t" });
		expect(parseMCPToolName("mcp__s_a_b")).toEqual({ serverName: "s", toolName: "a_b" });
	});
});
