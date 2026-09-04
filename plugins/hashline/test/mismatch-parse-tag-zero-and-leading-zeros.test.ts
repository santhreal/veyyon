/**
 * parseTag: 0 rejects; leading zeros parse as integer (01→1, 007→7).
 */
import { describe, expect, it } from "bun:test";
import { parseTag } from "@veyyon/hashline";

describe("parseTag zero and leading zeros", () => {
	for (const ref of ["0", "00", " 0 ", "*0"]) {
		it(`rejects ${JSON.stringify(ref)}`, () => {
			expect(() => parseTag(ref)).toThrow(/>= 1|Invalid/);
		});
	}

	it("leading zeros become integer value", () => {
		expect(parseTag("01").line).toBe(1);
		expect(parseTag("007").line).toBe(7);
		expect(parseTag("010").line).toBe(10);
	});

	for (const ref of ["1", "10", "100", "9999"]) {
		it(`accepts ${JSON.stringify(ref)}`, () => {
			expect(parseTag(ref).line).toBe(Number(ref));
		});
	}
});
