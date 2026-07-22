/**
 * sanitizeMcpStatusError collapses newlines and never throws on long input.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeMcpStatusError } from "../src/mcp/startup-events";

describe("sanitizeMcpStatusError", () => {
	it("collapses newlines", () => {
		const out = sanitizeMcpStatusError("a\nb\rc\r\nd");
		expect(out).not.toMatch(/[\r\n]/);
		expect(out).toContain("a");
		expect(out).toContain("b");
	});

	it("blank becomes unnamed", () => {
		expect(sanitizeMcpStatusError("   ")).toBe("(unnamed)");
	});

	it("long input truncates", () => {
		const long = "x".repeat(100_000);
		const out = sanitizeMcpStatusError(long);
		expect(out.length).toBeGreaterThan(0);
		expect(out.length).toBeLessThan(long.length);
	});
});
