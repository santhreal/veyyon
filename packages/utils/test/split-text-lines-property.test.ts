import { describe, expect, it } from "bun:test";
import { splitTextLines } from "@veyyon/utils/lines";

/**
 * splitTextLines property: trailing newline rule and interior blanks.
 */

describe("splitTextLines property-style", () => {
	it("for N lines joined with \\n without trailing newline, length is N", () => {
		for (let n = 1; n <= 50; n++) {
			const lines = Array.from({ length: n }, (_, i) => `L${i}`);
			expect(splitTextLines(lines.join("\n"))).toEqual(lines);
		}
	});

	it("for N lines with trailing newline, length is still N", () => {
		for (let n = 1; n <= 50; n++) {
			const lines = Array.from({ length: n }, (_, i) => `L${i}`);
			expect(splitTextLines(`${lines.join("\n")}\n`)).toEqual(lines);
		}
	});

	it("interior blank lines are preserved under both trailing styles", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
		expect(splitTextLines("a\n\nb\n")).toEqual(["a", "", "b"]);
		expect(splitTextLines("a\n\n\nb")).toEqual(["a", "", "", "b"]);
	});

	it("round-trip join with \\n for non-empty results without trailing empty", () => {
		const samples = ["a\nb", "a\nb\n", "only", "a\n\nb\n", "x\ny\nz"];
		for (const s of samples) {
			const parts = splitTextLines(s);
			if (parts.length === 0) {
				expect(s === "" || s === "\n").toBe(true);
				continue;
			}
			const rejoined = parts.join("\n");
			// Rejoin equals input without a single trailing newline difference.
			expect(rejoined === s || `${rejoined}\n` === s).toBe(true);
		}
	});
});
