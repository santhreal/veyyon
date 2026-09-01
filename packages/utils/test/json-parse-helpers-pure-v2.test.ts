import { describe, expect, it } from "bun:test";
import {
	BACKSLASH,
	CONTROL_ESCAPES,
	HEX4_RE,
	INCOMPLETE,
	isHexDigit,
	isIdentChar,
	isWhitespace,
	KEYWORDS,
	NON_RECOVERABLE_BAREWORDS,
	QUOTE,
	repairJson,
	SQUOTE,
	U,
	VALID_ESCAPE_CHAR,
} from "../src/json-parse-helpers";

describe("constants", () => {
	it("QUOTE is 0x22", () => {
		expect(QUOTE).toBe(0x22);
	});
	it("BACKSLASH is 0x5c", () => {
		expect(BACKSLASH).toBe(0x5c);
	});
	it("U is 0x75", () => {
		expect(U).toBe(0x75);
	});
	it("SQUOTE is 0x27", () => {
		expect(SQUOTE).toBe(0x27);
	});
	it("INCOMPLETE is a symbol", () => {
		expect(typeof INCOMPLETE).toBe("symbol");
	});
});

describe("VALID_ESCAPE_CHAR", () => {
	it("marks quote as valid", () => {
		expect(VALID_ESCAPE_CHAR[QUOTE]).toBe(1);
	});
	it("marks backslash as valid", () => {
		expect(VALID_ESCAPE_CHAR[BACKSLASH]).toBe(1);
	});
	it("marks b as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x62]).toBe(1);
	});
	it("marks f as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x66]).toBe(1);
	});
	it("marks n as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x6e]).toBe(1);
	});
	it("marks r as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x72]).toBe(1);
	});
	it("marks t as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x74]).toBe(1);
	});
	it("marks u as valid", () => {
		expect(VALID_ESCAPE_CHAR[U]).toBe(1);
	});
	it("does not mark x as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x78]).toBe(0);
	});
	it("does not mark a as valid", () => {
		expect(VALID_ESCAPE_CHAR[0x61]).toBe(0);
	});
});

describe("CONTROL_ESCAPES", () => {
	it("has 32 entries", () => {
		expect(CONTROL_ESCAPES.length).toBe(32);
	});
	it("escapes newline as \\n", () => {
		expect(CONTROL_ESCAPES[0x0a]).toBe("\\n");
	});
	it("escapes carriage return as \\r", () => {
		expect(CONTROL_ESCAPES[0x0d]).toBe("\\r");
	});
	it("escapes tab as \\t", () => {
		expect(CONTROL_ESCAPES[0x09]).toBe("\\t");
	});
	it("escapes backspace as \\b", () => {
		expect(CONTROL_ESCAPES[0x08]).toBe("\\b");
	});
	it("escapes form feed as \\f", () => {
		expect(CONTROL_ESCAPES[0x0c]).toBe("\\f");
	});
	it("escapes null as \\u0000", () => {
		expect(CONTROL_ESCAPES[0x00]).toBe("\\u0000");
	});
});

describe("HEX4_RE", () => {
	it("matches 4 hex digits", () => {
		expect(HEX4_RE.test("1a2b")).toBe(true);
	});
	it("matches uppercase hex", () => {
		expect(HEX4_RE.test("1A2B")).toBe(true);
	});
	it("rejects 3 digits", () => {
		expect(HEX4_RE.test("1a2")).toBe(false);
	});
	it("rejects 5 digits", () => {
		expect(HEX4_RE.test("1a2bc")).toBe(false);
	});
	it("rejects non-hex", () => {
		expect(HEX4_RE.test("1g2b")).toBe(false);
	});
});

describe("isHexDigit", () => {
	it("returns true for 0-9", () => {
		expect(isHexDigit(0x30)).toBe(true);
		expect(isHexDigit(0x39)).toBe(true);
	});
	it("returns true for a-f", () => {
		expect(isHexDigit(0x61)).toBe(true);
		expect(isHexDigit(0x66)).toBe(true);
	});
	it("returns true for A-F", () => {
		expect(isHexDigit(0x41)).toBe(true);
		expect(isHexDigit(0x46)).toBe(true);
	});
	it("returns false for g", () => {
		expect(isHexDigit(0x67)).toBe(false);
	});
	it("returns false for special chars", () => {
		expect(isHexDigit(0x2f)).toBe(false);
	});
});

describe("isWhitespace", () => {
	it("returns true for space", () => {
		expect(isWhitespace(0x20)).toBe(true);
	});
	it("returns true for tab", () => {
		expect(isWhitespace(0x09)).toBe(true);
	});
	it("returns true for newline", () => {
		expect(isWhitespace(0x0a)).toBe(true);
	});
	it("returns true for carriage return", () => {
		expect(isWhitespace(0x0d)).toBe(true);
	});
	it("returns false for letter", () => {
		expect(isWhitespace(0x61)).toBe(false);
	});
});

describe("isIdentChar", () => {
	it("returns true for lowercase letters", () => {
		expect(isIdentChar(0x61)).toBe(true);
		expect(isIdentChar(0x7a)).toBe(true);
	});
	it("returns true for uppercase letters", () => {
		expect(isIdentChar(0x41)).toBe(true);
		expect(isIdentChar(0x5a)).toBe(true);
	});
	it("returns true for digits", () => {
		expect(isIdentChar(0x30)).toBe(true);
		expect(isIdentChar(0x39)).toBe(true);
	});
	it("returns true for underscore", () => {
		expect(isIdentChar(0x5f)).toBe(true);
	});
	it("returns true for dollar sign", () => {
		expect(isIdentChar(0x24)).toBe(true);
	});
	it("returns false for hyphen", () => {
		expect(isIdentChar(0x2d)).toBe(false);
	});
	it("returns false for dot", () => {
		expect(isIdentChar(0x2e)).toBe(false);
	});
});

describe("KEYWORDS", () => {
	it("has 6 entries", () => {
		expect(KEYWORDS.length).toBe(6);
	});
	it("maps true to true", () => {
		expect(KEYWORDS.find(([k]) => k === "true")?.[1]).toBe(true);
	});
	it("maps false to false", () => {
		expect(KEYWORDS.find(([k]) => k === "false")?.[1]).toBe(false);
	});
	it("maps null to null", () => {
		expect(KEYWORDS.find(([k]) => k === "null")?.[1]).toBe(null);
	});
	it("maps True to true (Python style)", () => {
		expect(KEYWORDS.find(([k]) => k === "True")?.[1]).toBe(true);
	});
	it("maps False to false (Python style)", () => {
		expect(KEYWORDS.find(([k]) => k === "False")?.[1]).toBe(false);
	});
	it("maps None to null (Python style)", () => {
		expect(KEYWORDS.find(([k]) => k === "None")?.[1]).toBe(null);
	});
});

describe("NON_RECOVERABLE_BAREWORDS", () => {
	it("marks NaN as non-recoverable", () => {
		expect(NON_RECOVERABLE_BAREWORDS.NaN).toBe(true);
	});
	it("marks Infinity as non-recoverable", () => {
		expect(NON_RECOVERABLE_BAREWORDS.Infinity).toBe(true);
	});
	it("marks undefined as non-recoverable", () => {
		expect(NON_RECOVERABLE_BAREWORDS.undefined).toBe(true);
	});
	it("does not mark true as non-recoverable", () => {
		expect(NON_RECOVERABLE_BAREWORDS.true).toBeUndefined();
	});
});

describe("repairJson", () => {
	it("returns valid JSON unchanged", () => {
		expect(repairJson('{"key":"value"}')).toBe('{"key":"value"}');
	});
	it("returns non-string-containing JSON unchanged", () => {
		expect(repairJson('{"num":42}')).toBe('{"num":42}');
	});
	it("escapes lone backslash at end", () => {
		const result = repairJson('{"key":"foo\\');
		expect(result).toContain("\\\\");
	});
	it("preserves valid escape sequences", () => {
		expect(repairJson('{"key":"a\\nb"}')).toBe('{"key":"a\\nb"}');
	});
	it("preserves unicode escape sequences", () => {
		expect(repairJson('{"key":"\\u0041"}')).toBe('{"key":"\\u0041"}');
	});
	it("escapes control characters in strings", () => {
		const result = repairJson('{"key":"a\nb"}');
		expect(result).toContain("\\n");
	});
	it("handles empty string", () => {
		expect(repairJson("")).toBe("");
	});
	it("handles empty object", () => {
		expect(repairJson("{}")).toBe("{}");
	});
});
