/**
 * isMcpConnectionStatusEvent shape gate; sanitizeMcpStatusError newline collapse;
 * resolveMCPTimeoutMs defaults and config; describe/is enabled.
 */
import { describe, expect, it } from "bun:test";
import {
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	sanitizeMcpStatusError,
} from "@veyyon/coding-agent/mcp/startup-events";
import {
	describeMCPTimeout,
	isMCPTimeoutEnabled,
	resolveMCPTimeoutMs,
} from "@veyyon/coding-agent/mcp/timeout";

describe("isMcpConnectionStatusEvent matrix", () => {
	it("accepts connecting with string array", () => {
		expect(
			isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a", "b"] }),
		).toBe(true);
	});

	it("accepts connected", () => {
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "x" })).toBe(true);
	});

	it("accepts failed with optional foreign", () => {
		expect(
			isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "boom" }),
		).toBe(true);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "x",
				error: "boom",
				foreign: true,
			}),
		).toBe(true);
	});

	it("rejects wrong shapes", () => {
		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent({})).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting" })).toBe(false);
		expect(
			isMcpConnectionStatusEvent({ type: "connecting", serverNames: [1] }),
		).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connected" })).toBe(false);
		expect(
			isMcpConnectionStatusEvent({ type: "failed", serverName: "x" }),
		).toBe(false);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "x",
				error: "e",
				foreign: "yes",
			}),
		).toBe(false);
		expect(
			isMcpConnectionStatusEvent({
				channel: MCP_CONNECTION_STATUS_EVENT_CHANNEL,
				status: "ok",
			}),
		).toBe(false);
	});
});

describe("sanitizeMcpStatusError", () => {
	it("collapses newlines to spaces", () => {
		expect(sanitizeMcpStatusError("line1\nline2\r\nline3")).toBe("line1 line2 line3");
	});

	it("trims", () => {
		expect(sanitizeMcpStatusError("  hi  ")).toBe("hi");
	});
});

describe("MCP timeout pure matrix", () => {
	it("default 30000 when no config and no env override", () => {
		// Only assert when env is unset; if set, honor it.
		const prev = Bun.env.VEYYON_MCP_TIMEOUT_MS;
		delete Bun.env.VEYYON_MCP_TIMEOUT_MS;
		try {
			expect(resolveMCPTimeoutMs(undefined)).toBe(30_000);
			expect(resolveMCPTimeoutMs(5000)).toBe(5000);
		} finally {
			if (prev !== undefined) Bun.env.VEYYON_MCP_TIMEOUT_MS = prev;
		}
	});

	it("isMCPTimeoutEnabled and describe", () => {
		expect(isMCPTimeoutEnabled(1)).toBe(true);
		expect(isMCPTimeoutEnabled(0)).toBe(false);
		expect(isMCPTimeoutEnabled(-1)).toBe(false);
		expect(describeMCPTimeout(30000)).toBe("30000ms");
		expect(describeMCPTimeout(0)).toBe("disabled");
	});
});
