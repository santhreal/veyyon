/**
 * parseTag decoration matrix: bullets, stars, arrows, whitespace.
 */
import { describe, expect, it } from "bun:test";
import { parseTag } from "../src/mismatch";

describe("parseTag decoration matrix", () => {
	const cases: Array<[string, number]> = [
		["1", 1],
		["42", 42],
		["  99  ", 99],
		["*7", 7],
		["*7:body", 7],
		[">3", 3],
		[">> 8", 8],
		[">>>12:x", 12],
		["+4", 4],
		["+4:payload", 4],
		["-5:diff", 5],
		["* 6", 6],
	];
	for (const [input, line] of cases) {
		it(`${JSON.stringify(input)} -> ${line}`, () => {
			expect(parseTag(input)).toEqual({ line });
		});
	}

	it("rejects pure non-numeric", () => {
		for (const bad of ["abc", "*", ">", "line 3", "0x10"]) {
			expect(() => parseTag(bad)).toThrow();
		}
	});
});
