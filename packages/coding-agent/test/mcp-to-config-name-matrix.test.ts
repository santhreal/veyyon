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
		// The empty-result fallback, from every shape that reaches it: a key the
		// settings file can hold is never the empty string.
		["@@@", "mcp-server"],
		["///", "mcp-server"],
		["   ", "mcp-server"],
		// Dots survive the charset filter, so this one does NOT reach the fallback.
		["...", "..."],
	];

	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
			expect(toConfigName(input)).toBe(want);
		});
	}
});
