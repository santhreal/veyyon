import { describe, expect, it } from "bun:test";
import { codePointLength } from "@veyyon/utils";

/**
 * `codePointLength` is the single owner of Unicode code-point counting. It
 * exists because `String.prototype.length` counts UTF-16 code units, so an
 * astral character (an emoji, a rare CJK ideograph) counts as two even though a
 * person and specs like JSON Schema `minLength`/`maxLength` count it as one.
 * These pin the code-point contract against the `.length` regression.
 */
describe("codePointLength counts Unicode code points", () => {
	it("counts a two-unit astral character as one", () => {
		// "😀" is a single code point but two UTF-16 units; `.length` returns 2.
		expect("😀".length).toBe(2);
		expect(codePointLength("😀")).toBe(1);
		expect(codePointLength("😀😀😀")).toBe(3);
	});

	it("matches .length for pure BMP text", () => {
		expect(codePointLength("")).toBe(0);
		expect(codePointLength("hello")).toBe(5);
		expect(codePointLength("café")).toBe(4);
	});

	it("counts a mix of astral and BMP characters", () => {
		// "a😀b" is 3 code points but 4 UTF-16 units.
		expect("a😀b".length).toBe(4);
		expect(codePointLength("a😀b")).toBe(3);
		// A rare CJK ideograph outside the BMP is one code point, two units.
		expect(codePointLength("𠀀")).toBe(1);
	});
});
