/**
 * validateServerName: empty/long/charset/dot-path tokens fail; alnum+._:- ok.
 * Why: path-segment names like . and .. must never pass as server ids.
 */
import { describe, expect, it } from "bun:test";
import { validateServerName } from "@veyyon/coding-agent/mcp/config-writer";

describe("validateServerName pure matrix", () => {
	const valid = ["a", "github", "my-server", "my_server", "a.b", "cloudflare:cloudflare-api", "s1", "A1-_.", "x:y:z"];

	for (const name of valid) {
		it(`valid: ${JSON.stringify(name)}`, () => {
			expect(validateServerName(name)).toBeUndefined();
		});
	}

	it("empty names the fix", () => {
		expect(validateServerName("")).toBe(
			"Server name cannot be empty. Fix: give the server a short id you will type in `/mcp` commands, for example `filesystem`.",
		);
	});

	it("too long reports the actual length and the limit", () => {
		expect(validateServerName("a".repeat(101))).toBe(
			"Server name is too long: 101 characters, and the maximum is 100. Fix: shorten it to a short id you will type in `/mcp` commands, for example `filesystem`.",
		);
	});

	it("exactly 100 ok", () => {
		expect(validateServerName("a".repeat(100))).toBeUndefined();
	});

	const invalidCharset = ["a b", "a/b", "a@b", "a#b", "a\\b", "a$b", "a%b"];
	for (const name of invalidCharset) {
		it(`charset reject: ${JSON.stringify(name)}`, () => {
			const err = validateServerName(name);
			expect(err).toBeDefined();
			expect(err!).toMatch(/letters|numbers|dash|underscore|dot|colon/i);
			expect(err!).toContain("Fix: replace the other characters");
		});
	}

	const pathSegs = [".", "..", "...", ".:", ":.", "..:..", ".:."];
	for (const name of pathSegs) {
		it(`path segment reject: ${JSON.stringify(name)}`, () => {
			const err = validateServerName(name);
			expect(err).toBeDefined();
			expect(err!).toMatch(/path segment|\.|cannot be empty|letters/i);
			expect(err!).toMatch(/Fix: give the server a real id|Fix: replace the other characters/);
		});
	}
});
