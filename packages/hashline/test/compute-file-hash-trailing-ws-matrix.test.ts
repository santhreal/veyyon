/**
 * Trailing whitespace normalization: spaces/tabs/CR at EOL do not change hash.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash trailing whitespace", () => {
	const bases = ["x", "x\ny", "line1\nline2\nline3"];
	for (const base of bases) {
		it(`spaces on ${JSON.stringify(base).slice(0, 20)}`, () => {
			const withSpaces = base
				.split("\n")
				.map(l => (l.length ? l + "  " : l))
				.join("\n");
			expect(computeFileHash(withSpaces)).toBe(computeFileHash(base));
		});
		it(`tabs on ${JSON.stringify(base).slice(0, 20)}`, () => {
			const withTabs = base
				.split("\n")
				.map(l => (l.length ? l + "\t" : l))
				.join("\n");
			expect(computeFileHash(withTabs)).toBe(computeFileHash(base));
		});
	}

	it("CRLF trailing CR normalized", () => {
		expect(computeFileHash("a\r\nb\r\n")).toBe(computeFileHash("a\nb\n"));
	});
});
