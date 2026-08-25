/**
 * Truncation-notice regex near-misses must count as content.
 * stream-prefixes.test.ts already pins "drops notices while stripping",
 * hashline number prefixes, ++ not a diff, and CR on the stream arm.
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
	});

	it("does not drop `[Showing lines 1-20 of 400]` with no Use :N instruction — that is content", () => {
		const lines = ["[Showing lines 1-20 of 400]", "1:alpha", "2:beta"];
		expect(stripNewLinePrefixes(lines)).toEqual(lines);
		expect(stripHashlinePrefixes(lines)).toEqual(lines);
	});

	it("does not treat a numbered line whose text looks like a notice as a notice", () => {
		const lines = ["1:[Showing lines 1-20 of 400. Use :21 to continue]"];
		expect(stripNewLinePrefixes(lines)).toEqual(["[Showing lines 1-20 of 400. Use :21 to continue]"]);
	});
});

describe(">>> nested chevrons are not a prefix", () => {
	it("does not treat `>>> >>> 1:` as a prefix — the digits are not adjacent to the chevrons", () => {
		expect(stripOneLeadingHashlinePrefix(">>> >>> 1:body")).toBe(">>> >>> 1:body");
		expect(stripNewLinePrefixes([">>> >>> 1:body"])).toEqual([">>> >>> 1:body"]);
	});

	it("one-shot strip does not eat `12:34` content after the first prefix", () => {
		expect(stripOneLeadingHashlinePrefix("12:34:still")).toBe("34:still");
	});
});

describe("a hashline header is not a content line for the unanimous-prefix check", () => {
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
});
