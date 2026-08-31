/**
 * stripNewLinePrefixes / stripHashlinePrefixes mixed content adversarial cases.
 */
import { describe, expect, it } from "bun:test";
import { stripHashlinePrefixes, stripNewLinePrefixes, stripOneLeadingHashlinePrefix } from "../src/prefixes";

describe("prefix strip mixed content", () => {
	it("strict leaves content starting with digits: if not all lines prefixed", () => {
		const lines = ["1:ok", "2notprefixed"];
		expect(stripHashlinePrefixes(lines)).toEqual(lines);
	});

	it("opportunistic strips when all numbered", () => {
		expect(stripNewLinePrefixes(["10:a", "11:b", "12:c"])).toEqual(["a", "b", "c"]);
	});

	it("one-shot strip does not recurse into 12:34 content", () => {
		expect(stripOneLeadingHashlinePrefix("9:12:34:rest")).toBe("12:34:rest");
	});

	it("diff-plus majority strips leading plus", () => {
		expect(stripNewLinePrefixes(["+a", "+b", "+c", "d"])).toEqual(["a", "b", "c", "d"]);
	});

	it("half not enough for plus strip", () => {
		// 1 of 3 is plus
		expect(stripNewLinePrefixes(["+a", "b", "c"])).toEqual(["+a", "b", "c"]);
	});

	it("empty lines preserved under full hash strip", () => {
		const out = stripHashlinePrefixes(["1:a", "", "2:b"]);
		// empty lines don't count as content; if all non-empty are prefixed, strip
		expect(out).toEqual(["a", "", "b"]);
	});
});
