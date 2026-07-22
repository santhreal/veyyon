/**
 * resolveMCPTimeoutMs / isMCPTimeoutEnabled / describeMCPTimeout exact contracts.
 * Why: timeout 0 disables; positive enables; env overrides config when valid.
 */
import { describe, expect, it } from "bun:test";
import {
	describeMCPTimeout,
	isMCPTimeoutEnabled,
	resolveMCPTimeoutMs,
} from "@veyyon/coding-agent/mcp/timeout";

describe("mcp timeout pure matrix", () => {
	it("isMCPTimeoutEnabled: >0 true, 0 false, negative false", () => {
		expect(isMCPTimeoutEnabled(1)).toBe(true);
		expect(isMCPTimeoutEnabled(30_000)).toBe(true);
		expect(isMCPTimeoutEnabled(0)).toBe(false);
		expect(isMCPTimeoutEnabled(-1)).toBe(false);
	});

	it("describeMCPTimeout enabled shows ms", () => {
		expect(describeMCPTimeout(1000)).toBe("1000ms");
		expect(describeMCPTimeout(30_000)).toBe("30000ms");
	});

	it("describeMCPTimeout disabled", () => {
		expect(describeMCPTimeout(0)).toBe("disabled");
		expect(describeMCPTimeout(-5)).toBe("disabled");
	});

	it("resolveMCPTimeoutMs returns non-negative finite number", () => {
		// env may override; lock shape only for undefined/config interaction
		const a = resolveMCPTimeoutMs(undefined);
		const b = resolveMCPTimeoutMs(12_345);
		expect(Number.isFinite(a)).toBe(true);
		expect(a).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(b)).toBe(true);
		expect(b).toBeGreaterThanOrEqual(0);
		// when env unset, config wins; when env set, both equal env
		if (!Bun.env.VEYYON_MCP_TIMEOUT_MS?.trim()) {
			expect(a).toBe(30_000);
			expect(b).toBe(12_345);
			expect(resolveMCPTimeoutMs(0)).toBe(0);
		}
	});
});
