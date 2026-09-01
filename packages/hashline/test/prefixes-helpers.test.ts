import { describe, expect, it } from "bun:test";
import {
	hashlineParseText,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	stripOneLeadingHashlinePrefix,
} from "../src/prefixes";

describe("stripOneLeadingHashlinePrefix", () => {
	it("strips simple numbered prefix", () => {
		expect(stripOneLeadingHashlinePrefix("5:hello")).toBe("hello");
	});
	it("strips prefix with >>> marker", () => {
		expect(stripOneLeadingHashlinePrefix(">>> 5:hello")).toBe("hello");
	});
	it("strips prefix with >> marker", () => {
		expect(stripOneLeadingHashlinePrefix(">> 5:hello")).toBe("hello");
	});
	it("strips prefix with + marker", () => {
		expect(stripOneLeadingHashlinePrefix("+5:hello")).toBe("hello");
	});
	it("strips prefix with - marker", () => {
		expect(stripOneLeadingHashlinePrefix("-5:hello")).toBe("hello");
	});
	it("strips prefix with * marker", () => {
		expect(stripOneLeadingHashlinePrefix("*5:hello")).toBe("hello");
	});
	it("does not strip non-prefixed line", () => {
		expect(stripOneLeadingHashlinePrefix("hello")).toBe("hello");
	});
	it("does not strip line without colon after number", () => {
		expect(stripOneLeadingHashlinePrefix("5 hello")).toBe("5 hello");
	});
	it("handles empty line", () => {
		expect(stripOneLeadingHashlinePrefix("")).toBe("");
	});
});

describe("stripHashlinePrefixes", () => {
	it("strips hashline prefixes from all content lines", () => {
		const lines = ["1:hello", "2:world", "3:foo"];
		expect(stripHashlinePrefixes(lines)).toEqual(["hello", "world", "foo"]);
	});
	it("returns lines unchanged when no prefixes", () => {
		const lines = ["hello", "world"];
		expect(stripHashlinePrefixes(lines)).toBe(lines);
	});
	it("returns empty array unchanged", () => {
		expect(stripHashlinePrefixes([])).toEqual([]);
	});
	it("filters out header lines", () => {
		const lines = ["[file.ts#1A2B]", "1:hello", "2:world"];
		const result = stripHashlinePrefixes(lines);
		expect(result).not.toContain("[file.ts#1A2B]");
		expect(result).toContain("hello");
	});
	it("filters out read truncation notices", () => {
		const lines = ["[Showing lines 1-10 of 20. Use :L11 to show more]", "1:hello"];
		const result = stripHashlinePrefixes(lines);
		expect(result).not.toContain("[Showing lines 1-10 of 20. Use :L11 to show more]");
	});
	it("returns lines unchanged when not all content lines have prefixes", () => {
		const lines = ["1:hello", "world"];
		expect(stripHashlinePrefixes(lines)).toBe(lines);
	});
});

describe("stripNewLinePrefixes", () => {
	it("strips hashline prefixes when all content lines have them", () => {
		const lines = ["1:hello", "2:world"];
		expect(stripNewLinePrefixes(lines)).toEqual(["hello", "world"]);
	});
	it("strips diff plus prefixes when majority are diff plus", () => {
		const lines = ["+hello", "+world", "+foo"];
		expect(stripNewLinePrefixes(lines)).toEqual(["hello", "world", "foo"]);
	});
	it("returns lines unchanged when no prefixes detected", () => {
		const lines = ["hello", "world"];
		expect(stripNewLinePrefixes(lines)).toBe(lines);
	});
	it("handles empty array", () => {
		expect(stripNewLinePrefixes([])).toEqual([]);
	});
	it("handles all empty lines", () => {
		const lines = ["", "", ""];
		expect(stripNewLinePrefixes(lines)).toBe(lines);
	});
});

describe("hashlineParseText", () => {
	it("returns empty array for null", () => {
		expect(hashlineParseText(null)).toEqual([]);
	});
	it("returns empty array for undefined", () => {
		expect(hashlineParseText(undefined)).toEqual([]);
	});
	it("parses string into lines", () => {
		expect(hashlineParseText("hello\nworld")).toEqual(["hello", "world"]);
	});
	it("strips trailing newline before splitting", () => {
		expect(hashlineParseText("hello\nworld\n")).toEqual(["hello", "world"]);
	});
	it("strips carriage returns", () => {
		expect(hashlineParseText("hello\r\nworld\r\n")).toEqual(["hello", "world"]);
	});
	it("parses string array", () => {
		expect(hashlineParseText(["hello", "world"])).toEqual(["hello", "world"]);
	});
	it("strips hashline prefixes from string", () => {
		expect(hashlineParseText("1:hello\n2:world")).toEqual(["hello", "world"]);
	});
	it("handles single line string", () => {
		expect(hashlineParseText("hello")).toEqual(["hello"]);
	});
	it("handles empty string", () => {
		expect(hashlineParseText("")).toEqual([""]);
	});
	it("handles string with only newline", () => {
		expect(hashlineParseText("\n")).toEqual([""]);
	});
});
