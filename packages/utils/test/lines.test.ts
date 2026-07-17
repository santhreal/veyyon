import { describe, expect, it } from "bun:test";
import { collapseWhitespace, countNonEmptyLines } from "../src/lines";

describe("collapseWhitespace", () => {
	it("collapses every whitespace run (spaces, tabs, CR/LF) to one space and trims", () => {
		expect(collapseWhitespace("  a\t\tb\r\nc  \n d  ")).toBe("a b c d");
		expect(collapseWhitespace("already flat")).toBe("already flat");
		expect(collapseWhitespace(" \n\t ")).toBe("");
		expect(collapseWhitespace("")).toBe("");
	});

	it("maps null and undefined to empty string", () => {
		expect(collapseWhitespace(null)).toBe("");
		expect(collapseWhitespace(undefined)).toBe("");
	});
});

describe("countNonEmptyLines", () => {
	it("counts only lines with non-whitespace content", () => {
		expect(countNonEmptyLines("a\n\n  \nb\r\nc")).toBe(3);
		expect(countNonEmptyLines("")).toBe(0);
		expect(countNonEmptyLines("   \n\t")).toBe(0);
	});
});
