/**
 * validateServerName accept/reject matrix.
 */
import { describe, expect, it } from "bun:test";
import { validateServerName } from "../src/mcp/config-writer";

describe("validateServerName matrix", () => {
	const ok = ["a", "github", "a-b", "a_b", "a.b", "ns:svc", "cloudflare:cloudflare-api", "A1", "x.y.z", "tool_1"];
	for (const name of ok) {
		it(`accept ${JSON.stringify(name)}`, () => {
			expect(validateServerName(name)).toBeUndefined();
		});
	}

	const bad: Array<[string, RegExp]> = [
		["", /empty/i],
		["a".repeat(101), /too long/i],
		["has space", /can only contain/i],
		["has/slash", /can only contain/i],
		["has\\back", /can only contain/i],
		[".", /path segment/i],
		["..", /path segment/i],
		["a b", /can only contain/i],
		["@scope", /can only contain/i],
	];
	for (const [name, re] of bad) {
		it(`reject ${JSON.stringify(name)}`, () => {
			const err = validateServerName(name);
			expect(err).toBeDefined();
			expect(err!).toMatch(re);
		});
	}
});
