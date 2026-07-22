/**
 * describeMCPTimeout and isMCPTimeoutEnabled matrix.
 */
import { describe, expect, it } from "bun:test";
import { describeMCPTimeout, isMCPTimeoutEnabled } from "../src/mcp/timeout";

describe("MCP timeout describe/enabled", () => {
	it("disabled at 0", () => {
		expect(isMCPTimeoutEnabled(0)).toBe(false);
		expect(describeMCPTimeout(0)).toBe("disabled");
	});

	for (const ms of [1, 100, 1500, 30000, 60000]) {
		it(`enabled ${ms}`, () => {
			expect(isMCPTimeoutEnabled(ms)).toBe(true);
			expect(describeMCPTimeout(ms)).toBe(`${ms}ms`);
		});
	}
});
