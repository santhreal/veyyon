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

	/** The two refusals, derived from the source's wording rather than retyped per case. */
	const EMPTY_MESSAGE =
		"Server name cannot be empty. Fix: give the server a short id you will type in `/mcp` commands, for example `filesystem`.";
	const charsetMessage = (name: string): string =>
		`Server name "${name}" can only contain letters, numbers, dash, underscore, dot, and colon. Fix: replace the other characters, for example \`my-server\` rather than \`my server\`.`;

	// WHY the exact message and not merely "some error": the return value IS the
	// sentence `/mcp add` prints, and a name is refused for one of three distinct
	// reasons (empty, charset, path token). A test that only asked whether
	// something was returned would pass with every case collapsed onto one
	// message, leaving the operator told to fix the wrong thing.
	it("rejects empty, whitespace, spaces, slashes, and control chars, naming the rule each breaks", () => {
		expect(validateServerName("")).toBe(EMPTY_MESSAGE);
		for (const name of [" ", "has space", "a/b", "a\\b", "a\nb", "a\0b", "/abs"]) {
			expect(validateServerName(name)).toBe(charsetMessage(name));
		}
	});

	it("rejects '.' and '..' path tokens", () => {
		expect(validateServerName(".")).toBeDefined();
		expect(validateServerName("..")).toBeDefined();
		expect(String(validateServerName("."))).toMatch(/path segment|\.|\.\./i);
	});

	it("rejects path traversal variants on the charset rule, before the path-token rule", () => {
		// Every traversal spelling carries a separator, so the charset rule refuses
		// it first and the path-token rule below only ever sees pure-dot names.
		for (const name of ["../x", "..\\x", "a/../b", "a/b/c", "./x"]) {
			expect(validateServerName(name)).toBe(charsetMessage(name));
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
