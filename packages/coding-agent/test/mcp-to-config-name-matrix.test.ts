/**
 * toConfigName normalizes Smithery/registry qualified names into settings keys:
 * lower, @ strip, / → -, non [a-z0-9_.-] → -, collapse dashes, empty → mcp-server.
 */
import { describe, expect, it } from "bun:test";
import { toConfigName } from "@veyyon/coding-agent/mcp/smithery-registry";

describe("toConfigName matrix", () => {
	const cases: Array<[string, string]> = [
		["Hello World!!", "hello-world"],
		["FOO", "foo"],
		["foo_bar", "foo_bar"],
		["  spaced  ", "spaced"],
		["a--b", "a-b"],
		["123start", "123start"],
		["@scope/pkg", "scope-pkg"],
		["a/b/c", "a-b-c"],
		["mcp.server", "mcp.server"],
		["CamelCase", "camelcase"],
		["", "mcp-server"],
		["!!!", "mcp-server"],
		["---", "mcp-server"],
		["___", "___"],
		["my.package-name_v2", "my.package-name_v2"],
		["@org/name@1.0", "org-name-1.0"],
	];

	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
			expect(toConfigName(input)).toBe(want);
		});
	}

	it("never returns empty string", () => {
		for (const input of ["", "@@@", "///", "   ", "..."]) {
			const out = toConfigName(input);
			expect(out.length).toBeGreaterThan(0);
		}
	});
});
