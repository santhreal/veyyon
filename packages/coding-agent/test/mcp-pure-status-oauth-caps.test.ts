/**
 * Pure MCP: connection status event validator, status error sanitize,
 * OAuth header detection, capability predicates. No transport / natives.
 */
import { describe, expect, it } from "bun:test";
import {
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	sanitizeMcpStatusError,
} from "../src/mcp/startup-events";
import { hasMcpAuthorizationHeader, mcpOAuthCredentialIdsForServerUrl, selectMcpOAuthRefreshMaterial } from "../src/mcp/oauth-credentials";
import {
	serverSupportsPrompts,
	serverSupportsResourceSubscriptions,
	serverSupportsResources,
	serverSupportsTools,
} from "../src/mcp/client";
import type { MCPServerCapabilities } from "../src/mcp/types";

describe("MCP_CONNECTION_STATUS_EVENT_CHANNEL", () => {
	it("is the fixed bus channel name", () => {
		expect(MCP_CONNECTION_STATUS_EVENT_CHANNEL).toBe("mcp:connection-status");
	});
});

describe("isMcpConnectionStatusEvent", () => {
	it("accepts connecting with string[] serverNames", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a", "b"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [] })).toBe(true);
	});

	it("rejects connecting with non-string array items", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [1] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting" })).toBe(false);
	});

	it("accepts connected with serverName", () => {
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "github" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: 1 })).toBe(false);
	});

	it("accepts failed with optional foreign flag", () => {
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "boom" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "boom", foreign: true })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "boom", foreign: "yes" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x" })).toBe(false);
	});

	it("rejects unknown type and non-objects", () => {
		expect(isMcpConnectionStatusEvent({ type: "other" })).toBe(false);
		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent("connecting")).toBe(false);
		expect(isMcpConnectionStatusEvent(undefined)).toBe(false);
	});
});

describe("sanitizeMcpStatusError", () => {
	it("collapses newlines and tabs to spaces", () => {
		const out = sanitizeMcpStatusError("line1\nline2\r\nline3\tmore");
		expect(out).not.toMatch(/[\r\n\t]/);
		expect(out).toContain("line1");
		expect(out).toContain("line2");
	});

	it("empty-ish input becomes (unnamed)", () => {
		expect(sanitizeMcpStatusError("   ")).toBe("(unnamed)");
		expect(sanitizeMcpStatusError("\n\t")).toBe("(unnamed)");
	});

	it("does not throw on long adversarial input", () => {
		const long = "x".repeat(50_000);
		const out = sanitizeMcpStatusError(long);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		expect(out.length).toBeLessThan(long.length);
	});
});

describe("hasMcpAuthorizationHeader / oauth id helpers", () => {
	it("false for stdio configs", () => {
		expect(hasMcpAuthorizationHeader({ command: "npx" })).toBe(false);
	});

	it("true when headers contain Authorization case-insensitively", () => {
		expect(
			hasMcpAuthorizationHeader({ type: "http", url: "https://x", headers: { Authorization: "Bearer t" } }),
		).toBe(true);
		expect(
			hasMcpAuthorizationHeader({ type: "sse", url: "https://x", headers: { authorization: "Bearer t" } }),
		).toBe(true);
		expect(hasMcpAuthorizationHeader({ type: "http", url: "https://x", headers: { "X-Api-Key": "k" } })).toBe(
			false,
		);
		expect(hasMcpAuthorizationHeader({ type: "http", url: "https://x" })).toBe(false);
	});

	it("mcpOAuthCredentialIdsForServerUrl empty for undefined", () => {
		expect(mcpOAuthCredentialIdsForServerUrl(undefined)).toEqual([]);
		expect(mcpOAuthCredentialIdsForServerUrl("")).toEqual([]);
	});

	it("mcpOAuthCredentialIdsForServerUrl returns at least one id for a url", () => {
		const ids = mcpOAuthCredentialIdsForServerUrl("https://mcp.example.com/sse");
		expect(ids.length).toBeGreaterThanOrEqual(1);
		expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
		// stable for same input
		expect(mcpOAuthCredentialIdsForServerUrl("https://mcp.example.com/sse")).toEqual(ids);
	});

	it("selectMcpOAuthRefreshMaterial prefers credential when tokenUrl present", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0, tokenUrl: "https://t" };
		const auth = { type: "oauth" as const, tokenUrl: "https://other" };
		expect(selectMcpOAuthRefreshMaterial(cred as never, auth)).toBe(cred);
		const noUrl = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
		expect(selectMcpOAuthRefreshMaterial(noUrl as never, auth)).toBe(auth);
	});
});

describe("server capability predicates", () => {
	const empty: MCPServerCapabilities = {};
	const full: MCPServerCapabilities = {
		tools: {},
		resources: { subscribe: true },
		prompts: {},
	};

	it("serverSupportsTools", () => {
		expect(serverSupportsTools(empty)).toBe(false);
		expect(serverSupportsTools(full)).toBe(true);
		expect(serverSupportsTools({ tools: {} })).toBe(true);
	});

	it("serverSupportsResources", () => {
		expect(serverSupportsResources(empty)).toBe(false);
		expect(serverSupportsResources({ resources: {} })).toBe(true);
		expect(serverSupportsResources(full)).toBe(true);
	});

	it("serverSupportsResourceSubscriptions requires subscribe flag", () => {
		expect(serverSupportsResourceSubscriptions({ resources: {} })).toBe(false);
		expect(serverSupportsResourceSubscriptions({ resources: { subscribe: true } })).toBe(true);
		expect(serverSupportsResourceSubscriptions(full)).toBe(true);
	});

	it("serverSupportsPrompts", () => {
		expect(serverSupportsPrompts(empty)).toBe(false);
		expect(serverSupportsPrompts({ prompts: {} })).toBe(true);
	});
});
