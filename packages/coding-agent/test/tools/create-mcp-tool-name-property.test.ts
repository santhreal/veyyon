import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";

/**
 * createMCPToolName / parseMCPToolName properties over many simple names.
 */

describe("createMCPToolName property-style", () => {
	it("every simple letter pair round-trips under lowercasing", () => {
		// Sanitizer is [a-z_] only after lowercasing — digits become underscores.
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
						.replace(/[^a-z_]+/g, "_")
						.replace(/_+/g, "_")
						.replace(/^_+|_+$/g, "") || "server";
				expect(parsed!.serverName).toBe(expectServer);
				expect(parsed!.toolName.length).toBeGreaterThan(0);
			}
		}
	});

	it("digits in names are replaced by underscores during sanitize", () => {
		const name = createMCPToolName("x1", "t2");
		// x1 → x (1 → _), trailing _ stripped → x; t2 → t
		expect(name).toBe("mcp__x_t");
		expect(parseMCPToolName(name)).toEqual({ serverName: "x", toolName: "t" });
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
