/**
 * createMCPToolName: alphanumeric servers/tools roundtrip; specials sanitize.
 * Why: tool registry names must stay mcp__* and parse back where safe.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "../src/mcp/tool-bridge";

describe("createMCPToolName charset grid", () => {
	const servers = ["a", "ab", "github", "exa", "s1", "cloudflare", "ns1"];
	const tools = ["t", "get", "list", "search", "read_file", "x1"];

	for (const s of servers) {
		for (const t of tools) {
			it(`${s}/${t}`, () => {
				const name = createMCPToolName(s, t);
				expect(name.startsWith("mcp__")).toBe(true);
				expect(name).toMatch(/^mcp__[a-z0-9_]+$/);
				const p = parseMCPToolName(name);
				expect(p).not.toBeNull();
			});
		}
	}

	it("upper folds", () => {
		expect(createMCPToolName("GitHub", "Search")).toBe("mcp__github_search");
	});

	it("hyphen and slash sanitize", () => {
		const name = createMCPToolName("my-server", "list/files");
		expect(name).toBe("mcp__my_server_list_files");
	});

	it("colon in server sanitized", () => {
		const name = createMCPToolName("ns:svc", "tool");
		expect(name.startsWith("mcp__")).toBe(true);
		expect(name.includes(":")).toBe(false);
	});
});
