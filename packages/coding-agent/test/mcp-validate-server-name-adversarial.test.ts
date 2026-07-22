import { describe, expect, it } from "bun:test";
import { validateServerName } from "@veyyon/coding-agent/mcp/config-writer";

/**
 * validateServerName accept/reject matrix for MCP server identifiers.
 * Locks the charset rule and the rejection of '.' / '..' path tokens.
 */

describe("validateServerName adversarial matrix", () => {
	const good = [
		"github",
		"my-server",
		"s1",
		"a",
		"long-name-with-many-hyphens",
		"CamelCase",
		"under_score",
		"plugin:name",
		"a.b",
	];

	it("accepts every good name (returns undefined)", () => {
		for (const name of good) {
			expect(validateServerName(name)).toBeUndefined();
		}
	});

	it("rejects empty, whitespace, spaces, slashes, and control chars", () => {
		for (const name of ["", " ", "has space", "a/b", "a\\b", "a\nb", "a\0b", "/abs"]) {
			const err = validateServerName(name);
			expect(err).toBeDefined();
			expect(String(err).length).toBeGreaterThan(0);
		}
	});

	it("rejects '.' and '..' path tokens", () => {
		expect(validateServerName(".")).toBeDefined();
		expect(validateServerName("..")).toBeDefined();
		expect(String(validateServerName("."))).toMatch(/path segment|\.|\.\./i);
	});

	it("rejects path traversal variants", () => {
		for (const name of ["../x", "..\\x", "a/../b", "a/b/c", "./x"]) {
			expect(validateServerName(name)).toBeDefined();
		}
	});

	it("allows namespaced colon forms used by marketplace plugins", () => {
		expect(validateServerName("cloudflare:cloudflare-api")).toBeUndefined();
		expect(validateServerName("x:y")).toBeUndefined();
	});

	it("rejects overlong names", () => {
		const long = "a".repeat(101);
		const err = validateServerName(long);
		expect(err).toBeDefined();
		expect(String(err).toLowerCase()).toMatch(/long|100/);
	});
});
