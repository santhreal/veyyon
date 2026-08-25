/**
 * hashlineParseText is the payload normalizer that runs before the tokenizer
 * when a hunk body is a string (the edit tool's common paste path). It is not
 * splitHashlineLines. That helper, used to address a file, treats CR LF as one
 * ending and leaves a lone CR as content. This function does:
 *
 *   trimmed.replaceAll("\\r", "").split("\\n")
 *
 * then opportunistic prefix stripping.
 *
 * THE DEFECT. A lone CR in a payload line is content (hashline-contract.md:
 * "A lone CR anywhere else is content"). Replacing every CR with nothing
 * concatenates the two sides. Pasting ca<CR>fe as a body row therefore writes
 * cafe, and a Mac-classic CR-only paste becomes a single line. Inverse cannot
 * restore the bytes that were read.
 *
 * Prefix stripping is already covered for mixed numbered/unnumbered lines.
 * This file only pins: CR is not a character this function may delete, and a
 * read-truncation notice is dropped only when the rest of the body is a
 * numbered hashline paste.
 */
import { describe, expect, it } from "bun:test";
import { hashlineParseText, stripNewLinePrefixes } from "@veyyon/hashline";

describe("hashlineParseText keeps a lone CR as content", () => {
	it("does not glue caCR+fe into cafe when the body is a numbered paste", () => {
		expect(hashlineParseText("1:ca\rfe\n2:b")).toEqual(["ca\rfe", "b"]);
	});

	it("keeps CR LF as a line ending, not as a CR that must be deleted from the line", () => {
		expect(hashlineParseText("1:a\r\n2:b\r\n")).toEqual(["a", "b"]);
	});

	it("does not delete a CR that is the entire payload of a SWAP body", () => {
		expect(hashlineParseText("+\r")).toEqual(["\r"]);
	});
});

describe("hashlineParseText still drops a read truncation notice from a numbered paste", () => {
	it("removes the Showing-lines footer and strips the N: prefixes around it", () => {
		expect(
			stripNewLinePrefixes(["1:a", "[Showing lines 1-2 of 9. Use :L3 to continue]", "2:b"]),
		).toEqual(["a", "b"]);
	});

	it("null and undefined become an empty payload, not the string 'null'", () => {
		expect(hashlineParseText(null)).toEqual([]);
		expect(hashlineParseText(undefined)).toEqual([]);
	});
});
