import { describe, expect, it } from "bun:test";
import { truncateApproxTokens } from "@veyyon/coding-agent/mnemopi/config";

/**
 * truncateApproxTokens caps a string to an approximate token budget using the 4-chars-per-token
 * heuristic, appending an ellipsis when it cuts. It had no direct test. The boundary behaviour is what
 * a regression would quietly get wrong:
 *   - the budget maps to `tokenLimit * 4` characters; text at or under that length is returned verbatim
 *     (no ellipsis on content that already fits);
 *   - when it must cut, it keeps `maxChars - 1` characters (leaving room for the one-char ellipsis) and
 *     trims trailing whitespace before the ellipsis so a cut never lands as "word   …";
 *   - a zero or negative budget clamps maxChars to 0: empty text stays empty, any non-empty text becomes
 *     just the ellipsis (never a crash or a negative slice).
 */
describe("truncateApproxTokens", () => {
	it("returns text shorter than the budget unchanged", () => {
		// limit 2 -> 8 chars allowed; "hello" is 5.
		expect(truncateApproxTokens("hello", 2)).toBe("hello");
	});

	it("returns text exactly at the budget unchanged (no ellipsis)", () => {
		// limit 1 -> 4 chars allowed; "abcd" is exactly 4.
		expect(truncateApproxTokens("abcd", 1)).toBe("abcd");
	});

	it("cuts to maxChars-1 and appends an ellipsis when over budget", () => {
		// limit 1 -> 4 chars; "abcdef" (6) -> slice(0,3)="abc" + ellipsis.
		expect(truncateApproxTokens("abcdef", 1)).toBe("abc…");
	});

	it("trims trailing whitespace exposed by the cut before adding the ellipsis", () => {
		// limit 1 -> slice(0,3) of "a  bcd" is "a  " -> trimEnd "a" + ellipsis.
		expect(truncateApproxTokens("a  bcd", 1)).toBe("a…");
	});

	it("clamps a zero budget: empty stays empty, non-empty becomes just the ellipsis", () => {
		expect(truncateApproxTokens("", 0)).toBe("");
		expect(truncateApproxTokens("x", 0)).toBe("…");
	});

	it("treats a negative budget as zero without crashing", () => {
		expect(truncateApproxTokens("xyz", -5)).toBe("…");
	});
});
