/**
 * formatNumberedLines startLine offset matrix.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";

describe("formatNumberedLines startLine offsets", () => {
	for (const start of [1, 5, 10, 100]) {
		it(`start=${start}`, () => {
			const text = "a\nb\nc";
			const out = formatNumberedLines(text, start);
			expect(out).toBe(
				[
					formatNumberedLine(start, "a"),
					formatNumberedLine(start + 1, "b"),
					formatNumberedLine(start + 2, "c"),
				].join("\n"),
			);
		});
	}

	it("trailing newline adds phantom empty numbered line", () => {
		expect(formatNumberedLines("x\n", 1)).toBe("1:x\n2:");
		expect(formatNumberedLines("x\ny\n", 7)).toBe("7:x\n8:y\n9:");
	});
});
