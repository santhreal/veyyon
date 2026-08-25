/**
 * collectLinePrefixStats skips truncation notices when counting content
 * lines, then stripNewLinePrefixes / stripHashlinePrefixes drop those
 * notices if a strip scheme fired. A notice that is almost the regex but
 * not quite MUST count as content: otherwise a file whose only "content"
 * is a truncated banner would strip (or fail to strip) based on a line
 * the model is supposed to see.
 *
 * The regex is:
 *   ^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+
 *
 * Near-misses this file names:
 * - missing the trailing `Use :N` instruction
 * - `Use :L` without a digit
 * - `Showing lines` without the `of` total
 * - `more lines in` without a file token
 * - a hashline body that merely contains the notice as text after `12:`
 * - `>>>` / `>>` steering prefixes on numbered lines
 * - `+++` is not a diff-plus (DIFF_PLUS_RE is `[+](?![+])`)
 * - a header line is not a content line for the "every line prefixed" check
 *
 * stripOneLeadingHashlinePrefix must not loop into `12:34` content.
 * Nested `>>> >>> 1:` is two prefixes for the looping stripper and one
 * for the one-shot stripper.
 */
import { describe, expect, it } from "bun:test";
import {
	hashlineParseText,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	stripOneLeadingHashlinePrefix,
} from "@veyyon/hashline";

describe("a truncation notice is dropped only when it matches the full regex", () => {
	it("drops `[Showing lines 1-20 of 400. Use :21 to continue]` while stripping numbered content", () => {
		const lines = ["[Showing lines 1-20 of 400. Use :21 to continue]", "1:alpha", "2:beta"];
		expect(stripNewLinePrefixes(lines)).toEqual(["alpha", "beta"]);
		expect(stripHashlinePrefixes(lines)).toEqual(["alpha", "beta"]);
	});

	it("drops `[3 more lines in file. Use :L40]` the same way", () => {
		const lines = ["[3 more lines in file. Use :L40]", "10:keep"];
		expect(stripNewLinePrefixes(lines)).toEqual(["keep"]);
	});

	it("does not drop `[Showing lines 1-20 of 400]` with no Use :N instruction — that is content", () => {
		const lines = ["[Showing lines 1-20 of 400]", "1:alpha", "2:beta"];
		// The almost-notice counts as a non-prefixed content line, so opportunistic
		// hash-strip must NOT fire (not every content line is numbered).
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
		expect(stripHashlinePrefixes(lines)).toEqual(lines);
	});

	it("does not drop `[Showing lines 1-20. Use :21]` — missing `of N`", () => {
		const lines = ["[Showing lines 1-20. Use :21]", "1:alpha"];
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
	});

	it("does not drop `[3 more lines. Use :L40]` — missing `in file`", () => {
		const lines = ["[3 more lines. Use :L40]", "1:alpha"];
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
	});

	it("does not drop `[3 more lines in file. Use :L]` — no digit after L", () => {
		const lines = ["[3 more lines in file. Use :L]", "1:alpha"];
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
	});

	it("does not treat a numbered line whose text looks like a notice as a notice", () => {
		const lines = ["1:[Showing lines 1-20 of 400. Use :21 to continue]"];
		expect(stripNewLinePrefixes(lines)).toEqual(["[Showing lines 1-20 of 400. Use :21 to continue]"]);
	});
});

describe(">>> / >> steering prefixes and one-shot vs looping strip", () => {
	it("strips `>>> 12:` as a hashline prefix", () => {
		expect(stripOneLeadingHashlinePrefix(">>> 12:body")).toBe("body");
		expect(stripNewLinePrefixes([">>> 1:a", ">>> 2:b"])).toEqual(["a", "b"]);
	});

	it("strips `>> 12:` as a hashline prefix (`>>` is in the regex, `>` is not)", () => {
		expect(stripOneLeadingHashlinePrefix(">> 12:body")).toBe("body");
		expect(stripOneLeadingHashlinePrefix("> 12:body")).toBe("> 12:body");
	});

	it("does not treat `>>> >>> 1:` as a prefix — the digits are not adjacent to the chevrons", () => {
		// HL_PREFIX_RE is (?:>>>|>>)? then optional [+*-] then digits:. A second
		// `>>>` between the first chevrons and the number fails the digit arm,
		// so neither the one-shot nor the looping stripper may eat this line.
		expect(stripOneLeadingHashlinePrefix(">>> >>> 1:body")).toBe(">>> >>> 1:body");
		expect(stripNewLinePrefixes([">>> >>> 1:body"])).toEqual([">>> >>> 1:body"]);
	});

	it("one-shot strip does not eat `12:34` content after the first prefix", () => {
		expect(stripOneLeadingHashlinePrefix("12:34:still")).toBe("34:still");
	});
});

describe("+++ is not a diff-plus; ++ is not either", () => {
	it("leaves a hunk header +++ alone", () => {
		expect(stripNewLinePrefixes(["+++ b/foo", "+added"])).toEqual(["+++ b/foo", "added"]);
	});

	it("does not strip when fewer than half the non-empty lines are a single plus", () => {
		expect(stripNewLinePrefixes(["+one", "plain", "plain"])).toEqual(["+one", "plain", "plain"]);
	});
});

describe("a hashline header is not a content line for the unanimous-prefix check", () => {
	it("still strips numbered content when a 4-hex [path#hash] header is present, and drops the header", () => {
		const header = "[src/foo.ts#ABCD]";
		const lines = [header, "1:alpha", "2:beta"];
		expect(stripHashlinePrefixes(lines)).toEqual(["alpha", "beta"]);
		expect(stripNewLinePrefixes(lines)).toEqual(["alpha", "beta"]);
	});

	it("does not treat a 3-hex or 5-hex bracket line as a header, so mixed content is left alone", () => {
		const shortHex = ["[src/foo.ts#ABC]", "1:alpha", "2:beta"];
		const longHex = ["[src/foo.ts#ABCDE]", "1:alpha", "2:beta"];
		expect(stripHashlinePrefixes(shortHex)).toEqual(shortHex);
		expect(stripHashlinePrefixes(longHex)).toEqual(longHex);
	});
});

describe("hashlineParseText string form vs array form", () => {
	it("does not strip CR from an array payload (only the string arm replaceAlls CR)", () => {
		expect(hashlineParseText(["ca\rfe"])).toEqual(["ca\rfe"]);
	});

	it("does not glue caCR+fe in an unnumbered string payload either", () => {
		expect(hashlineParseText("ca\rfe")).toEqual(["ca\rfe"]);
	});

	it("drops a single trailing newline on the string arm, not an internal blank line", () => {
		expect(hashlineParseText("a\n\nb\n")).toEqual(["a", "", "b"]);
	});
});
