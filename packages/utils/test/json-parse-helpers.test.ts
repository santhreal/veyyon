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

describe("character constants", () => {
	it("QUOTE is 0x22 (double quote)", () => {
		expect(QUOTE).toBe(0x22);
	});

	it("BACKSLASH is 0x5c", () => {
		expect(BACKSLASH).toBe(0x5c);
	});

	it("U is 0x75 (letter u)", () => {
		expect(U).toBe(0x75);
	});

	it("SQUOTE is 0x27 (single quote)", () => {
		expect(SQUOTE).toBe(0x27);
	});
});

describe("VALID_ESCAPE_CHAR", () => {
	it("marks valid JSON escape characters", () => {
		expect(VALID_ESCAPE_CHAR[0x22]).toBe(1); // "
		expect(VALID_ESCAPE_CHAR[0x5c]).toBe(1); // \
		expect(VALID_ESCAPE_CHAR[0x2f]).toBe(1); // /
		expect(VALID_ESCAPE_CHAR[0x62]).toBe(1); // b
		expect(VALID_ESCAPE_CHAR[0x66]).toBe(1); // f
		expect(VALID_ESCAPE_CHAR[0x6e]).toBe(1); // n
		expect(VALID_ESCAPE_CHAR[0x72]).toBe(1); // r
		expect(VALID_ESCAPE_CHAR[0x74]).toBe(1); // t
		expect(VALID_ESCAPE_CHAR[0x75]).toBe(1); // u
	});

	it("does not mark invalid escape characters", () => {
		expect(VALID_ESCAPE_CHAR[0x61]).toBe(0); // a
		expect(VALID_ESCAPE_CHAR[0x71]).toBe(0); // q
		expect(VALID_ESCAPE_CHAR[0x30]).toBe(0); // 0
	});
});

describe("CONTROL_ESCAPES", () => {
	it("has 32 entries", () => {
		expect(CONTROL_ESCAPES.length).toBe(32);
	});

	it("maps newline to \\n", () => {
		expect(CONTROL_ESCAPES[0x0a]).toBe("\\n");
	});

	it(" maps carriage return to \\r", () => {
		expect(CONTROL_ESCAPES[0x0d]).toBe("\\r");
	});

	it("maps tab to \\t", () => {
		expect(CONTROL_ESCAPES[0x09]).toBe("\\t");
	});

	it("maps backspace to \\b", () => {
		expect(CONTROL_ESCAPES[0x08]).toBe("\\b");
	});

	it("maps form feed to \\f", () => {
		expect(CONTROL_ESCAPES[0x0c]).toBe("\\f");
	});

	it("maps other control chars to \\uXXXX", () => {
		expect(CONTROL_ESCAPES[0x00]).toBe("\\u0000");
		expect(CONTROL_ESCAPES[0x01]).toBe("\\u0001");
		expect(CONTROL_ESCAPES[0x1f]).toBe("\\u001f");
	});
});

describe("HEX4_RE", () => {
	it("matches 4 hex digits", () => {
		expect(HEX4_RE.test("1234")).toBe(true);
		expect(HEX4_RE.test("abcd")).toBe(true);
		expect(HEX4_RE.test("ABCD")).toBe(true);
		expect(HEX4_RE.test("aBcD")).toBe(true);
	});

	it("rejects non-hex chars", () => {
		expect(HEX4_RE.test("12g4")).toBe(false);
		expect(HEX4_RE.test("xyzw")).toBe(false);
	});

	it("rejects wrong length", () => {
		expect(HEX4_RE.test("123")).toBe(false);
		expect(HEX4_RE.test("12345")).toBe(false);
		expect(HEX4_RE.test("")).toBe(false);
	});
});

describe("isHexDigit", () => {
	it("accepts digits 0-9", () => {
		for (let i = 0x30; i <= 0x39; i++) {
			expect(isHexDigit(i)).toBe(true);
		}
	});

	it("accepts lowercase a-f", () => {
		for (let i = 0x61; i <= 0x66; i++) {
			expect(isHexDigit(i)).toBe(true);
		}
	});

	it("accepts uppercase A-F", () => {
		for (let i = 0x41; i <= 0x46; i++) {
			expect(isHexDigit(i)).toBe(true);
		}
	});

	it("rejects non-hex characters", () => {
		expect(isHexDigit(0x67)).toBe(false); // g
		expect(isHexDigit(0x47)).toBe(false); // G
		expect(isHexDigit(0x20)).toBe(false); // space
		expect(isHexDigit(0x2f)).toBe(false); // /
	});
});

describe("isWhitespace", () => {
	it("accepts space (0x20)", () => {
		expect(isWhitespace(0x20)).toBe(true);
	});

	it("accepts tab (0x09)", () => {
		expect(isWhitespace(0x09)).toBe(true);
	});

	it("accepts newline (0x0a)", () => {
		expect(isWhitespace(0x0a)).toBe(true);
	});

	it("accepts carriage return (0x0d)", () => {
		expect(isWhitespace(0x0d)).toBe(true);
	});

	it("rejects non-whitespace", () => {
		expect(isWhitespace(0x41)).toBe(false); // A
		expect(isWhitespace(0x30)).toBe(false); // 0
		expect(isWhitespace(0x00)).toBe(false); // null
	});
});

describe("isIdentChar", () => {
	it("accepts lowercase letters", () => {
		for (let i = 0x61; i <= 0x7a; i++) {
			expect(isIdentChar(i)).toBe(true);
		}
	});

	it("accepts uppercase letters", () => {
		for (let i = 0x41; i <= 0x5a; i++) {
			expect(isIdentChar(i)).toBe(true);
		}
	});

	it("accepts digits", () => {
		for (let i = 0x30; i <= 0x39; i++) {
			expect(isIdentChar(i)).toBe(true);
		}
	});

	it("accepts underscore (0x5f)", () => {
		expect(isIdentChar(0x5f)).toBe(true);
	});

	it("accepts dollar sign (0x24)", () => {
		expect(isIdentChar(0x24)).toBe(true);
	});

	it("rejects hyphen", () => {
		expect(isIdentChar(0x2d)).toBe(false);
	});

	it("rejects space", () => {
		expect(isIdentChar(0x20)).toBe(false);
	});
});

describe("KEYWORDS", () => {
	it("includes JSON keywords", () => {
		const map = new Map(KEYWORDS);
		expect(map.get("true")).toBe(true);
		expect(map.get("false")).toBe(false);
		expect(map.get("null")).toBe(null);
	});

	it("includes Python keywords", () => {
		const map = new Map(KEYWORDS);
		expect(map.get("True")).toBe(true);
		expect(map.get("False")).toBe(false);
		expect(map.get("None")).toBe(null);
	});
});

describe("NON_RECOVERABLE_BAREWORDS", () => {
	it("marks NaN", () => {
		expect(NON_RECOVERABLE_BAREWORDS.NaN).toBe(true);
		expect(NON_RECOVERABLE_BAREWORDS.nan).toBe(true);
	});

	it("marks Infinity", () => {
		expect(NON_RECOVERABLE_BAREWORDS.Infinity).toBe(true);
		expect(NON_RECOVERABLE_BAREWORDS.infinity).toBe(true);
	});

	it("marks undefined", () => {
		expect(NON_RECOVERABLE_BAREWORDS.undefined).toBe(true);
	});
});

describe("INCOMPLETE symbol", () => {
	it("is a unique symbol", () => {
		expect(typeof INCOMPLETE).toBe("symbol");
		expect(INCOMPLETE).not.toBe(Symbol("incomplete"));
	});
});

describe("repairJson", () => {
	it("returns input unchanged when no repairs needed", () => {
		const json = '{"key": "value", "num": 42, "bool": true}';
		expect(repairJson(json)).toBe(json);
	});

	it("returns input unchanged for simple valid JSON", () => {
		const json = "[1, 2, 3]";
		expect(repairJson(json)).toBe(json);
	});

	it("leaves valid escaped quote at end of string as-is", () => {
		// \" is a valid JSON escape; repairJson does not alter it
		const json = '{"key": "value\\"}';
		const repaired = repairJson(json);
		expect(repaired).toBe(json);
	});

	it("escapes invalid escape sequences", () => {
		// \x is not a valid JSON escape
		const json = '{"key": "hello\\xworld"}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ key: "hello\\xworld" });
	});

	it("escapes control characters in strings", () => {
		const json = '{"key": "hello\u0001world"}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ key: "hello\u0001world" });
	});

	it("escapes newline in string", () => {
		const json = '{"key": "line1\nline2"}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ key: "line1\nline2" });
	});

	it("escapes tab in string", () => {
		const json = '{"key": "a\tb"}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ key: "a\tb" });
	});

	it("preserves valid \\uXXXX escapes", () => {
		const json = '{"key": "\\u0041"}';
		const repaired = repairJson(json);
		expect(repaired).toBe(json);
		expect(JSON.parse(repaired)).toEqual({ key: "A" });
	});

	it("preserves valid escape sequences", () => {
		const json = '{"key": "hello\\nworld\\ttab"}';
		const repaired = repairJson(json);
		expect(repaired).toBe(json);
	});

	it("handles empty string value", () => {
		const json = '{"key": ""}';
		expect(repairJson(json)).toBe(json);
	});

	it("handles multiple strings with issues", () => {
		const json = '{"a": "hello\nworld", "b": "foo\tbar"}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ a: "hello\nworld", b: "foo\tbar" });
	});

	it("handles backslash before quote (valid escape, left as-is)", () => {
		// \" is a valid JSON escape, repairJson leaves it alone
		// The string {"key": "test\"} has an escaped quote, making it unterminated
		// repairJson only fixes invalid escapes, not structural issues
		const json = '{"key": "test\\"}';
		const repaired = repairJson(json);
		expect(repaired).toBe(json);
	});

	it("handles lone backslash at end of input", () => {
		const json = '{"key": "value\\';
		const repaired = repairJson(json);
		// Should escape the trailing backslash
		expect(repaired).toContain("\\\\");
	});

	it("handles incomplete \\u escape", () => {
		// \u followed by less than 4 hex digits
		const json = '{"key": "test\\u12"}';
		const repaired = repairJson(json);
		// The incomplete \u should get double-escaped
		expect(repaired).toContain("\\\\u12");
	});

	it("handles string with no issues outside strings", () => {
		// Control chars outside strings should not be touched
		const json = '\n{"key": "value"}\n';
		expect(repairJson(json)).toBe(json);
	});

	it("handles nested objects with string issues", () => {
		const json = '{"outer": {"inner": "hello\nworld"}}';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual({ outer: { inner: "hello\nworld" } });
	});

	it("handles arrays with string issues", () => {
		const json = '["hello\nworld", "foo\tbar"]';
		const repaired = repairJson(json);
		expect(JSON.parse(repaired)).toEqual(["hello\nworld", "foo\tbar"]);
	});
});
