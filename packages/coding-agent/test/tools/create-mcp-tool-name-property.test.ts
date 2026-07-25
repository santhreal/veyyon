import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";

/**
 * createMCPToolName / parseMCPToolName properties over many simple names.
 */

describe("createMCPToolName property-style", () => {
	it("every simple letter pair round-trips under lowercasing", () => {
		// Sanitizer keeps [a-z0-9_] after lowercasing; everything else folds to a
		// single underscore. These names are all letters, so the class boundary is
		// pinned by the digit test below rather than here.
		const servers = ["a", "github", "svc", "mytool", "xyz"];
		const tools = ["run", "list", "getData", "doThing", "x"];
		for (const s of servers) {
			for (const t of tools) {
				const name = createMCPToolName(s, t);
				expect(name.startsWith("mcp__")).toBe(true);
				const parsed = parseMCPToolName(name);
				expect(parsed).not.toBeNull();
				const expectServer =
					s
						.toLowerCase()
						.replace(/[^a-z0-9_]+/g, "_")
						.replace(/_+/g, "_")
						.replace(/^_+|_+$/g, "") || "server";
				expect(parsed!.serverName).toBe(expectServer);
				expect(parsed!.toolName.length).toBeGreaterThan(0);
			}
		}
	});

	it("keeps digits, so numbered servers do not collide", () => {
		// This test previously asserted the OPPOSITE — that `x1` sanitized to `x`
		// — and in doing so pinned a real defect (MCP-5): the sanitizer replaced
		// every character outside `a-z_`, so `github1` and `github2` both became
		// `github` and every tool they shared a name for collided outright. Two
		// registry entries under one name means a call goes to whichever the
		// lookup reaches first, with nothing to warn you.
		//
		// Numbered servers are completely ordinary (`mcp-server-1`, `jira2`), and
		// every provider allows digits in a tool name, so the erasure bought
		// nothing and cost correctness.
		expect(createMCPToolName("x1", "t2")).toBe("mcp__x1_t2");
		expect(parseMCPToolName("mcp__x1_t2")).toEqual({ serverName: "x1", toolName: "t2" });
		expect(createMCPToolName("github1", "search")).not.toBe(createMCPToolName("github2", "search"));
	});

	it("parse of non-mcp names is always null", () => {
		for (const n of ["bash", "read", "write", "mcp_", "mcp", "", "notmcp__a_b"]) {
			expect(parseMCPToolName(n)).toBeNull();
		}
	});

	it("created names always contain exactly one mcp__ prefix", () => {
		for (let i = 0; i < 50; i++) {
			const name = createMCPToolName(`s${i}`, `t${i}`);
			expect(name.indexOf("mcp__")).toBe(0);
			expect(name.indexOf("mcp__", 1)).toBe(-1);
		}
	});
});
