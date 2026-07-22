/**
 * mcpOAuthCredentialId pure: stable encoding of server URL + profile.
 */
import { describe, expect, it } from "bun:test";
import {
	isManagedMCPOAuthCredentialId,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
} from "@veyyon/coding-agent/mcp/oauth-flow";

describe("mcpOAuthCredentialId pure matrix", () => {
	it("stable for same url+profile", () => {
		const a = mcpOAuthCredentialId("https://example.com/mcp", "default");
		const b = mcpOAuthCredentialId("https://example.com/mcp", "default");
		expect(a).toBe(b);
		expect(isManagedMCPOAuthCredentialId(a)).toBe(true);
	});

	it("differs by url", () => {
		const a = mcpOAuthCredentialId("https://a.example/mcp", "p");
		const b = mcpOAuthCredentialId("https://b.example/mcp", "p");
		expect(a).not.toBe(b);
	});

	it("differs by profile", () => {
		const a = mcpOAuthCredentialId("https://example.com/mcp", "p1");
		const b = mcpOAuthCredentialId("https://example.com/mcp", "p2");
		expect(a).not.toBe(b);
	});

	it("profile roundtrip when managed", () => {
		const id = mcpOAuthCredentialId("https://example.com/mcp", "work");
		expect(mcpOAuthCredentialProfile(id)).toBe("work");
	});

	it("non-managed ids rejected", () => {
		expect(isManagedMCPOAuthCredentialId(undefined)).toBe(false);
		expect(isManagedMCPOAuthCredentialId("")).toBe(false);
		expect(isManagedMCPOAuthCredentialId("random")).toBe(false);
	});
});
