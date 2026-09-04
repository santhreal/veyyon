import { describe, expect, it } from "bun:test";
import { formatNumberedLines } from "@veyyon/hashline";

/**
 * formatNumberedLines edge cases: empty, trailing newline, single line.
 */

describe("formatNumberedLines edges", () => {
	it("single line without trailing newline", () => {
		const out = formatNumberedLines("only", 1);
		expect(out).toContain("1:only");
	});

	it("single line with trailing newline", () => {
		const out = formatNumberedLines("only\n", 1);
		expect(out).toContain("1:only");
	});

	it("startLine 100 offsets correctly for two lines", () => {
		const out = formatNumberedLines("a\nb\n", 100);
		expect(out).toContain("100:a");
		expect(out).toContain("101:b");
	});

	it("does not invent content for empty string", () => {
		const out = formatNumberedLines("", 1);
		expect(out.includes("invented")).toBe(false);
	});
});
