/**
 * createMCPToolName/parseMCPToolName for simple alphanumeric names.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "../src/mcp/tool-bridge";

describe("create/parse simple names", () => {
	const pairs: Array<[string, string]> = [
		["github", "search"],
		["exa", "find"],
		["fs", "read"],
		["mem", "store"],
		["tool", "run"],
	];
	for (const [s, t] of pairs) {
		it(`${s}/${t}`, () => {
			const name = createMCPToolName(s, t);
			expect(name).toBe(`mcp__${s}_${t}`);
			expect(parseMCPToolName(name)).toEqual({ serverName: s, toolName: t });
		});
	}
});
