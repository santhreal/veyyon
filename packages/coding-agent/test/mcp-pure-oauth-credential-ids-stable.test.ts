/**
 * mcpOAuthCredentialIdsForServerUrl stable and non-empty for URLs.
 */
import { describe, expect, it } from "bun:test";
import { mcpOAuthCredentialIdsForServerUrl } from "../src/mcp/oauth-credentials";

describe("mcpOAuthCredentialIdsForServerUrl stable", () => {
	const urls = ["https://mcp.example.com/sse", "https://api.github.com/mcp", "http://localhost:3000/mcp"];
	for (const url of urls) {
		it(url, () => {
			const a = mcpOAuthCredentialIdsForServerUrl(url);
			const b = mcpOAuthCredentialIdsForServerUrl(url);
			expect(a.length).toBeGreaterThanOrEqual(1);
			expect(a).toEqual(b);
			expect(a.every(id => typeof id === "string" && id.length > 0)).toBe(true);
		});
	}

	it("undefined and empty", () => {
		expect(mcpOAuthCredentialIdsForServerUrl(undefined)).toEqual([]);
		expect(mcpOAuthCredentialIdsForServerUrl("")).toEqual([]);
	});
});
