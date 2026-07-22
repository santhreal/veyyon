/**
 * parseMCPToolName null cases.
 */
import { describe, expect, it } from "bun:test";
import { parseMCPToolName } from "../src/mcp/tool-bridge";

describe("parseMCPToolName nulls", () => {
	const bad = ["", "mcp__", "mcp__only", "bash", "mcp_x_y", "notmcp__a_b", "mcp__"];
	for (const name of bad) {
		it(JSON.stringify(name), () => {
			expect(parseMCPToolName(name)).toBeNull();
		});
	}
});
