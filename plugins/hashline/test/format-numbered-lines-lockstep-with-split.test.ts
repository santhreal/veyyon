/**
 * formatNumberedLines lockstep with split("\n"): trailing newline produces a
 * phantom empty numbered line at the end.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";

describe("formatNumberedLines lockstep with split", () => {
	const samples = ["a", "a\nb", "a\nb\n", "a\n\nb", "", "\n", "x\ny\nz\n"];
	for (const text of samples) {
		it(JSON.stringify(text), () => {
			const lines = text.split("\n");
			const formatted = formatNumberedLines(text);
			const expected = lines.map((l, i) => formatNumberedLine(i + 1, l)).join("\n");
			expect(formatted).toBe(expected);
			expect(formatted.split("\n")).toHaveLength(lines.length);
		});
	}

	it("startLine offset", () => {
		expect(formatNumberedLines("a\nb", 10)).toBe("10:a\n11:b");
	});
});
