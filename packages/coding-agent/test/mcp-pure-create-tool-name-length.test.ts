/**
 * createMCPToolName always starts with mcp__ and contains underscore separator.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "../src/mcp/tool-bridge";

describe("createMCPToolName shape contract", () => {
	const pairs: Array<[string, string]> = [
		["a", "b"],
		["server", "tool"],
		["My-Server", "Do_Thing"],
		["!!!", "???"],
		["gh", "list_issues"],
		["s", "a"],
	];
	for (const [s, t] of pairs) {
		it(`${s}/${t}`, () => {
			const name = createMCPToolName(s, t);
			expect(name.startsWith("mcp__")).toBe(true);
			expect(name.includes("_")).toBe(true);
			const parsed = parseMCPToolName(name);
			expect(parsed).not.toBeNull();
			expect(parsed!.serverName.length).toBeGreaterThan(0);
			expect(parsed!.toolName.length).toBeGreaterThan(0);
		});
	}
});
