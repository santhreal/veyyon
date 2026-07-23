/**
 * formatMatchLine: match vs context markers; hashline vs plain separators for lines 1..50.
 * Why: grep/ast-grep alignment depends on * vs space and : vs | never swapping.
 */
import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "../src/tools/match-line-format";

describe("formatMatchLine marker grid 1 to 50", () => {
	for (let n = 1; n <= 50; n++) {
		it(`line ${n} match hashline`, () => {
			expect(formatMatchLine(n, "body", true, { useHashLines: true })).toBe(`*${n}:body`);
		});

		it(`line ${n} context hashline`, () => {
			expect(formatMatchLine(n, "body", false, { useHashLines: true })).toBe(` ${n}:body`);
		});

		it(`line ${n} match plain`, () => {
			expect(formatMatchLine(n, "body", true, { useHashLines: false })).toBe(`*${n}|body`);
		});

		it(`line ${n} context plain`, () => {
			expect(formatMatchLine(n, "body", false, { useHashLines: false })).toBe(` ${n}|body`);
		});
	}

	it("empty body still has separator", () => {
		expect(formatMatchLine(1, "", true, { useHashLines: true })).toBe("*1:");
		expect(formatMatchLine(1, "", false, { useHashLines: false })).toBe(" 1|");
	});

	it("body with pipe and colon preserved", () => {
		expect(formatMatchLine(2, "a|b:c", true, { useHashLines: true })).toBe("*2:a|b:c");
		expect(formatMatchLine(2, "a|b:c", true, { useHashLines: false })).toBe("*2|a|b:c");
	});

	it("no zero-padding on large line numbers", () => {
		expect(formatMatchLine(1000, "x", true, { useHashLines: true })).toBe("*1000:x");
		expect(formatMatchLine(1000, "x", false, { useHashLines: false })).toBe(" 1000|x");
	});
});
