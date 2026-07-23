/**
 * parseTag decorations + validateLineRef bounds: adversarial refs, zero line,
 * out-of-range, decoration noise.
 */
import { describe, expect, it } from "bun:test";
import { parseTag, validateLineRef } from "@veyyon/hashline";

describe("parseTag adversarial matrix", () => {
	const ok: Array<[string, number]> = [
		["1", 1],
		["42", 42],
		[" 7 ", 7],
		["> 12", 12],
		["*9:foo", 9],
		["-1", 1],
		["+3:bar", 3],
		["   >   100  ", 100],
		["* 5", 5],
	];
	for (const [ref, line] of ok) {
		it(`ok ${JSON.stringify(ref)} → ${line}`, () => {
			expect(parseTag(ref)).toEqual({ line });
		});
	}

	const bad = ["", "0", "00", "abc", "line 1", "1.5", "1a", "++", ">", "  "];
	for (const ref of bad) {
		it(`throws ${JSON.stringify(ref)}`, () => {
			expect(() => parseTag(ref)).toThrow(/Invalid line reference|Line number must be >= 1/);
		});
	}
});

describe("validateLineRef bounds matrix", () => {
	const file = ["a", "b", "c"];

	for (const line of [1, 2, 3]) {
		it(`accepts line ${line} of 3`, () => {
			expect(() => validateLineRef({ line }, file)).not.toThrow();
		});
	}

	for (const line of [0, -1, 4, 100]) {
		it(`rejects line ${line}`, () => {
			expect(() => validateLineRef({ line }, file)).toThrow(`Line ${line} does not exist (file has 3 lines)`);
		});
	}

	it("empty file rejects line 1", () => {
		expect(() => validateLineRef({ line: 1 }, [])).toThrow("Line 1 does not exist (file has 0 lines)");
	});
});
