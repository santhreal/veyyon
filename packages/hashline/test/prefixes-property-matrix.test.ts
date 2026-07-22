/**
 * Prefix strip helpers: opportunistic vs strict, headers, truncation notices.
 */
import { describe, expect, it } from "bun:test";
import {
	hashlineParseText,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	stripOneLeadingHashlinePrefix,
} from "../src/prefixes";
import { HL_FILE_HASH_LENGTH } from "../src/format";

const tag = "A".repeat(HL_FILE_HASH_LENGTH);
const header = `[src/foo.ts#${tag}]`;

describe("stripOneLeadingHashlinePrefix matrix", () => {
	const cases: Array<[string, string]> = [
		["1:a", "a"],
		["  12:body", "body"],
		[">>>1:x", "x"],
		[">> 3:y", "y"],
		["*5:z", "z"],
		["+9:w", "w"],
		["-2:m", "m"],
		["1:2:3", "2:3"],
		["plain", "plain"],
		["", ""],
		[">>> +7:hi", "hi"],
	];
	for (const [input, want] of cases) {
		it(`strips once: ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
			expect(stripOneLeadingHashlinePrefix(input)).toBe(want);
		});
	}
});

describe("stripHashlinePrefixes strict", () => {
	it("strips only when every content line is hashline-prefixed", () => {
		expect(stripHashlinePrefixes(["1:a", "2:b", "3:c"])).toEqual(["a", "b", "c"]);
	});

	it("leaves mixed lines unchanged", () => {
		const lines = ["1:a", "plain", "3:c"];
		expect(stripHashlinePrefixes(lines)).toEqual(lines);
	});

	it("drops headers and truncation notices while stripping", () => {
		const lines = [
			header,
			"1:first",
			"2:second",
			"[Showing lines 1-2 of 99. Use :L3 to continue]",
		];
		expect(stripHashlinePrefixes(lines)).toEqual(["first", "second"]);
	});

	it("empty and all-empty content stays empty-ish", () => {
		expect(stripHashlinePrefixes([])).toEqual([]);
		expect(stripHashlinePrefixes(["", ""])).toEqual(["", ""]);
	});

	it("header-only input is unchanged: no content lines means strict strip is a no-op", () => {
		// contentLineCount === 0 → early return of the original lines (headers alone
		// are not a hashline-prefixed content body).
		expect(stripHashlinePrefixes([header])).toEqual([header]);
	});
});

describe("stripNewLinePrefixes opportunistic", () => {
	it("strips full hashline-numbered content", () => {
		expect(stripNewLinePrefixes(["1:a", "2:b"])).toEqual(["a", "b"]);
	});

	it("strips leading + when at least half of non-empty lines are diff-plus", () => {
		expect(stripNewLinePrefixes(["+a", "+b", "c"])).toEqual(["a", "b", "c"]);
		expect(stripNewLinePrefixes(["+a", "b", "c"])).toEqual(["+a", "b", "c"]);
	});

	it("strips +N: form when present", () => {
		const out = stripNewLinePrefixes(["+1:alpha", "+2:beta"]);
		expect(out).toEqual(["alpha", "beta"]);
	});

	it("returns untouched when no scheme recognized", () => {
		const lines = ["alpha", "beta"];
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
	});

	it("filters truncation notices under hash strip", () => {
		const out = stripNewLinePrefixes([
			"1:a",
			"2:b",
			"[2 more lines in file. Use :L3 to continue]",
		]);
		expect(out).toEqual(["a", "b"]);
	});
});

describe("hashlineParseText", () => {
	it("null/undefined yield []", () => {
		expect(hashlineParseText(null)).toEqual([]);
		expect(hashlineParseText(undefined)).toEqual([]);
	});

	it("splits multiline string and strips trailing newline before split", () => {
		expect(hashlineParseText("1:a\n2:b\n")).toEqual(["a", "b"]);
	});

	it("strips CR from string form", () => {
		expect(hashlineParseText("1:a\r\n2:b")).toEqual(["a", "b"]);
	});

	it("array form still runs stripNewLinePrefixes", () => {
		expect(hashlineParseText(["1:x", "2:y"])).toEqual(["x", "y"]);
	});
});
