import { describe, expect, it } from "bun:test";
import { convertLeadingTabsToSpaces, normalizeForFuzzy, normalizeUnicode } from "../../src/edit/normalize";

/**
 * The edit tool folds smart/Unicode punctuation to ASCII so an agent's search
 * text matches a file line regardless of quote/dash style. Two functions do this:
 *   - normalizeUnicode: trims, folds dash/quote/space/zero-width/≠/½ code points,
 *     then NFC-normalizes;
 *   - normalizeForFuzzy: trims, folds quotes/dashes, collapses runs of spaces/tabs
 *     to one space (used by the fuzzy/partial passes in patch.ts and replace.ts).
 *
 * This suite exists because normalizeForFuzzy previously used a hand-listed
 * character class that OMITTED the two most common smart double quotes (U+201C “,
 * U+201D ”), the two most common smart single quotes (U+2018 ‘, U+2019 ’), and the
 * horizontal-bar dash (U+2015 ―) while including only rarer variants. A straight-
 * quote search therefore failed to fuzzy-match a curly-quote file line. The bug is
 * locked out by (a) direct assertions that the common curly quotes fold, and (b) a
 * PARITY test that a curly line and its straight-quote twin normalize identically.
 */

describe("normalizeForFuzzy quote and dash folding", () => {
	it("folds the common smart double quotes U+201C/U+201D to a straight quote", () => {
		expect(normalizeForFuzzy("say “hi”")).toBe('say "hi"');
	});

	it("folds the common smart single quotes U+2018/U+2019 to a straight apostrophe", () => {
		expect(normalizeForFuzzy("it’s ‘x’")).toBe("it's 'x'");
	});

	it("folds the low-9/reversed-9 quote variants and guillemets", () => {
		expect(normalizeForFuzzy("„a‟ «b»")).toBe('"a" "b"');
		expect(normalizeForFuzzy("‚c‛ `d´")).toBe("'c' 'd'");
	});

	it("folds the full dash range including U+2015 and the minus sign U+2212", () => {
		expect(normalizeForFuzzy("a‐b‑c‒d–e—f―g−h")).toBe("a-b-c-d-e-f-g-h");
	});

	it("collapses runs of spaces and tabs to a single space after trimming", () => {
		expect(normalizeForFuzzy("  a\t\t b   c  ")).toBe("a b c");
	});

	it("returns an empty string for a whitespace-only line", () => {
		expect(normalizeForFuzzy("   \t ")).toBe("");
	});

	it("normalizes a curly-quote line identically to its straight-quote twin (match parity)", () => {
		// This is the regression: the fuzzy pass compares these two forms, so they
		// MUST collapse to the same string for the edit to locate its target.
		const curly = normalizeForFuzzy("const s = “hello”; // it’s fine");
		const straight = normalizeForFuzzy('const s = "hello"; // it\'s fine');
		expect(curly).toBe(straight);
		expect(curly).toBe('const s = "hello"; // it\'s fine');
	});

	it("agrees with normalizeUnicode on folding the common curly quotes", () => {
		// The two functions share the same intent for quotes; a divergence here is
		// exactly the class of bug this suite guards.
		const input = "“a” ‘b’";
		expect(normalizeForFuzzy(input)).toBe("\"a\" 'b'");
		expect(normalizeUnicode(input)).toBe("\"a\" 'b'");
	});
});

/**
 * These lock the whitespace/invisible-character arm of the normalizer-parity
 * contract. normalizeUnicode folds non-breaking and other exotic spaces to a
 * regular space and strips zero-width characters, but normalizeForFuzzy used to
 * collapse only ASCII space and tab. A file line indented or spaced with a
 * non-breaking space (U+00A0, common in text pasted from rich editors or some
 * generated code) therefore failed to fuzzy-match its plain-ASCII twin even
 * though the exact-Unicode pass treated them as equal, so the edit tool could not
 * locate an otherwise-identical target. normalizeForFuzzy now strips the same
 * zero-width set and collapses the same exotic-space set. The parity tests assert
 * a spaced/invisible line and its plain twin normalize to the SAME string, since
 * that identity is exactly what the fuzzy pass compares.
 */
describe("normalizeForFuzzy whitespace and invisible-character folding", () => {
	it("folds an internal non-breaking space to a single regular space", () => {
		// U+00A0 between the tokens; trim() only handles leading/trailing, so the
		// internal one is the regression surface.
		expect(normalizeForFuzzy("a b")).toBe("a b");
	});

	it("folds en/em/thin/hair and narrow/math/ideographic spaces to a single space", () => {
		// U+2002 en, U+2003 em, U+2009 thin, U+200A hair.
		expect(normalizeForFuzzy("a b c d e")).toBe("a b c d e");
		// U+202F narrow no-break, U+205F medium math, U+3000 ideographic.
		expect(normalizeForFuzzy("a b c　d")).toBe("a b c d");
	});

	it("collapses a mixed run of ASCII and exotic spaces to one space", () => {
		expect(normalizeForFuzzy("a  \t  b")).toBe("a b");
	});

	it("strips zero-width characters so they cannot split a token", () => {
		// U+200B zero-width space, U+200D zero-width joiner, U+FEFF BOM: each
		// disappears entirely, matching normalizeUnicode's zero-width stripping.
		expect(normalizeForFuzzy("foo​bar‍baz﻿")).toBe("foobarbaz");
	});

	it("normalizes a non-breaking-space line identically to its plain twin (match parity)", () => {
		// This is the regression: the fuzzy pass compares these two forms, so a
		// non-breaking space must collapse to the same single space the ASCII line has.
		const exotic = normalizeForFuzzy("const x = 1;");
		const plain = normalizeForFuzzy("const x = 1;");
		expect(exotic).toBe(plain);
		expect(exotic).toBe("const x = 1;");
	});

	it("agrees with normalizeUnicode on folding an internal ideographic space", () => {
		// The shared intent the parity contract guards, now for whitespace as well
		// as quotes: both fold U+3000 to a regular space.
		const input = "a　b";
		expect(normalizeForFuzzy(input)).toBe("a b");
		expect(normalizeUnicode(input)).toBe("a b");
	});
});

describe("normalizeUnicode", () => {
	it("folds dashes, quotes, non-breaking spaces, ≠, ½, and strips zero-width characters", () => {
		expect(normalizeUnicode("a—b")).toBe("a-b");
		expect(normalizeUnicode("“x” ‘y’")).toBe("\"x\" 'y'");
		expect(normalizeUnicode("a b　c")).toBe("a b c");
		expect(normalizeUnicode("a≠b")).toBe("a!=b");
		expect(normalizeUnicode("½ cup")).toBe("1/2 cup");
		expect(normalizeUnicode("a​b﻿c")).toBe("abc");
	});

	it("trims and applies NFC composition", () => {
		// "cafe" + combining acute -> composed "café"; length collapses from 5 to 4.
		const decomposed = "  café  ";
		const result = normalizeUnicode(decomposed);
		expect(result).toBe("café");
		expect(result.length).toBe(4);
	});
});

describe("convertLeadingTabsToSpaces", () => {
	it("converts leading tabs to spacesPerTab spaces each", () => {
		expect(convertLeadingTabsToSpaces("\t\tcode", 4)).toBe("        code");
	});

	it("leaves a line whose indentation mixes tabs and spaces untouched", () => {
		expect(convertLeadingTabsToSpaces(" \tcode", 4)).toBe(" \tcode");
	});

	it("returns the text unchanged when spacesPerTab is zero or negative", () => {
		expect(convertLeadingTabsToSpaces("\tcode", 0)).toBe("\tcode");
		expect(convertLeadingTabsToSpaces("\tcode", -2)).toBe("\tcode");
	});

	it("leaves blank (whitespace-only) lines alone while converting real ones", () => {
		expect(convertLeadingTabsToSpaces("\t\n\tx", 2)).toBe("\t\n  x");
	});
});
