import { describe, expect, it } from "bun:test";
import { xmlNodeText } from "@veyyon/coding-agent/markit/converters/xml-text";

/**
 * xmlNodeText is the one owner of "get the text out of a fast-xml-parser node"
 * for the xlsx, pptx, and epub converters. It exists because each converter had
 * grown its own copy and two of them dropped a legitimate numeric zero. These
 * pin the two coercions that the hand-rolled copies got wrong:
 *   - fast-xml-parser number-parses tag text by default, so "0"/"1984"/"true"
 *     arrive as a number or boolean and must be stringified, not dropped;
 *   - a `#text` of the number 0 (a "0" cell/run that also carries an attribute
 *     such as xml:space="preserve") is real and must be read with a null check,
 *     never `node["#text"] || ""`, which turns the text "0" into "".
 */
describe("xmlNodeText", () => {
	it("returns a bare string unchanged, including the empty string", () => {
		expect(xmlNodeText("hello")).toBe("hello");
		expect(xmlNodeText("")).toBe("");
		expect(xmlNodeText("  spaced  ")).toBe("  spaced  ");
	});

	it("stringifies number-parsed tag text, including a bare zero", () => {
		expect(xmlNodeText(1984)).toBe("1984");
		expect(xmlNodeText(0)).toBe("0");
		expect(xmlNodeText(3.5)).toBe("3.5");
		expect(xmlNodeText(-2)).toBe("-2");
	});

	it("stringifies a boolean tag value", () => {
		expect(xmlNodeText(true)).toBe("true");
		expect(xmlNodeText(false)).toBe("false");
	});

	it("reads the #text of an attribute-node and keeps a numeric zero", () => {
		// REGRESSION: `node["#text"] || ""` discarded a `#text` of the number 0,
		// turning a "0" cell/run carrying an attribute into "". A null check keeps it.
		expect(xmlNodeText({ "#text": "kept" })).toBe("kept");
		expect(xmlNodeText({ "#text": 0 })).toBe("0");
		expect(xmlNodeText({ "#text": 2020 })).toBe("2020");
		expect(xmlNodeText({ "#text": false })).toBe("false");
	});

	it("returns an empty string for a nullish or text-less node", () => {
		expect(xmlNodeText(null)).toBe("");
		expect(xmlNodeText(undefined)).toBe("");
		expect(xmlNodeText({})).toBe("");
		expect(xmlNodeText({ "#text": null })).toBe("");
		expect(xmlNodeText({ "#text": undefined })).toBe("");
	});
});
