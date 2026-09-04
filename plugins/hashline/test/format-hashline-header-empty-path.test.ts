import { describe, expect, it } from "bun:test";
import { formatHashlineHeader } from "@veyyon/hashline";

/**
 * formatHashlineHeader with edge path strings.
 */

describe("formatHashlineHeader edge paths", () => {
	it("empty path still formats brackets and hash", () => {
		const h = formatHashlineHeader("", "abcd");
		expect(h).toBe("[#abcd]");
	});

	it("path with spaces is embedded verbatim", () => {
		const h = formatHashlineHeader("my file.ts", "1234");
		expect(h).toBe("[my file.ts#1234]");
	});

	it("path with # is embedded (caller responsibility)", () => {
		const h = formatHashlineHeader("a#b.ts", "ffff");
		expect(h).toBe("[a#b.ts#ffff]");
	});
});
