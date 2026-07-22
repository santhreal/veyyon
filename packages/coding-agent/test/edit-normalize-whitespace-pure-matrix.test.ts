/**
 * Edit normalize pure whitespace helpers: count/get leading ws, minIndent
 * over non-empty lines, detectIndentChar first non-empty indent char.
 */
import { describe, expect, it } from "bun:test";
import {
	countLeadingWhitespace,
	detectIndentChar,
	getLeadingWhitespace,
	minIndent,
} from "@veyyon/coding-agent/edit/normalize";

describe("countLeadingWhitespace pure matrix", () => {
	const cases: Array<[string, number]> = [
		["", 0],
		["abc", 0],
		[" abc", 1],
		["  abc", 2],
		["\tabc", 1],
		["\t\tabc", 2],
		["  \tabc", 3],
		[" \t x", 3],
		["\n", 0],
		["   ", 3],
	];
	for (const [line, n] of cases) {
		it(`${JSON.stringify(line)} → ${n}`, () => {
			expect(countLeadingWhitespace(line)).toBe(n);
			expect(getLeadingWhitespace(line)).toBe(line.slice(0, n));
		});
	}
});

describe("minIndent pure matrix", () => {
	it("ignores empty lines", () => {
		expect(minIndent("  a\n\n    b\n\t")).toBe(2);
		expect(minIndent("\n\n")).toBe(0);
		expect(minIndent("")).toBe(0);
	});

	it("min across mixed indents", () => {
		expect(minIndent("    a\n  b\n      c")).toBe(2);
		expect(minIndent("\tx\n\t\ty")).toBe(1);
	});

	it("single non-empty line", () => {
		expect(minIndent("    only")).toBe(4);
	});
});

describe("detectIndentChar pure matrix", () => {
	it("returns first non-empty leading char", () => {
		expect(detectIndentChar("\tx\n  y")).toBe("\t");
		expect(detectIndentChar("  x\n\ty")).toBe(" ");
		expect(detectIndentChar("no-indent")).toBe(" ");
		expect(detectIndentChar("")).toBe(" ");
		expect(detectIndentChar("\n\n  z")).toBe(" ");
	});
});
