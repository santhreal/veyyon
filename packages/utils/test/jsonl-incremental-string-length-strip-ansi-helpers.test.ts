import { describe, expect, it } from "bun:test";
import { parseJsonlIncremental } from "../src/jsonl-incremental";
import { codePointLength, isWellFormedUtf16, utf8ByteLength } from "../src/string-length";
import { AnsiStripper } from "../src/strip-ansi";

describe("codePointLength", () => {
	it("returns length for ASCII string", () => {
		expect(codePointLength("hello")).toBe(5);
	});

	it("returns length for empty string", () => {
		expect(codePointLength("")).toBe(0);
	});

	it("counts code points not UTF-16 units for emoji", () => {
		expect(codePointLength("😀")).toBe(1);
	});

	it("counts mixed ASCII and emoji", () => {
		expect(codePointLength("a😀b")).toBe(3);
	});

	it("counts multi-byte characters", () => {
		expect(codePointLength("café")).toBe(4);
	});

	it("counts CJK characters", () => {
		expect(codePointLength("日本語")).toBe(3);
	});
});

describe("utf8ByteLength", () => {
	it("returns byte length for ASCII", () => {
		expect(utf8ByteLength("hello")).toBe(5);
	});

	it("returns byte length for empty string", () => {
		expect(utf8ByteLength("")).toBe(0);
	});

	it("counts 2 bytes for Latin-1 supplement", () => {
		expect(utf8ByteLength("é")).toBe(2);
	});

	it("counts 3 bytes for CJK characters", () => {
		expect(utf8ByteLength("日")).toBe(3);
	});

	it("counts 4 bytes for emoji", () => {
		expect(utf8ByteLength("😀")).toBe(4);
	});

	it("handles mixed content", () => {
		expect(utf8ByteLength("aé日😀")).toBe(1 + 2 + 3 + 4);
	});

	it("respects start parameter", () => {
		expect(utf8ByteLength("abc", 1)).toBe(2);
	});

	it("respects end parameter", () => {
		expect(utf8ByteLength("abc", 0, 2)).toBe(2);
	});

	it("handles lone high surrogate", () => {
		expect(utf8ByteLength("\uD800")).toBe(3);
	});

	it("handles lone low surrogate", () => {
		expect(utf8ByteLength("\uDC00")).toBe(3);
	});

	it("handles surrogate pair at end with no low surrogate", () => {
		const str = "abc\uD800";
		expect(utf8ByteLength(str)).toBe(3 + 3);
	});
});

describe("isWellFormedUtf16", () => {
	it("returns true for ASCII", () => {
		expect(isWellFormedUtf16("hello")).toBe(true);
	});

	it("returns true for empty string", () => {
		expect(isWellFormedUtf16("")).toBe(true);
	});

	it("returns true for valid emoji", () => {
		expect(isWellFormedUtf16("😀")).toBe(true);
	});

	it("returns false for lone high surrogate", () => {
		expect(isWellFormedUtf16("\uD800")).toBe(false);
	});

	it("returns false for lone low surrogate", () => {
		expect(isWellFormedUtf16("\uDC00")).toBe(false);
	});

	it("returns false for high surrogate at end", () => {
		expect(isWellFormedUtf16("abc\uD800")).toBe(false);
	});

	it("returns false for high surrogate followed by non-low", () => {
		expect(isWellFormedUtf16("\uD800\uD800")).toBe(false);
	});

	it("returns true for mixed valid content", () => {
		expect(isWellFormedUtf16("café😀日本")).toBe(true);
	});
});

describe("parseJsonlIncremental", () => {
	it("parses complete lines", () => {
		const result = parseJsonlIncremental('{"a":1}\n{"b":2}\n', "");
		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.carry).toBe("");
	});

	it("carries incomplete last line", () => {
		const result = parseJsonlIncremental('{"a":1}\n{"b":', "");
		expect(result.items).toEqual([{ a: 1 }]);
		expect(result.carry).toBe('{"b":');
	});

	it("appends to previous carry", () => {
		const result = parseJsonlIncremental("2}\n", '{"b":');
		expect(result.items).toEqual([{ b: 2 }]);
		expect(result.carry).toBe("");
	});

	it("skips invalid JSON lines", () => {
		const skips: { offset: number; snippet: string }[] = [];
		const result = parseJsonlIncremental('{"a":1}\nbroken\n{"c":3}\n', "", { onSkip: s => skips.push(s) });
		expect(result.items).toEqual([{ a: 1 }, { c: 3 }]);
		expect(skips).toHaveLength(1);
		expect(skips[0].snippet).toBe("broken");
	});

	it("handles empty input", () => {
		const result = parseJsonlIncremental("", "");
		expect(result.items).toEqual([]);
		expect(result.carry).toBe("");
	});

	it("handles only carry", () => {
		const result = parseJsonlIncremental("", '{"partial":');
		expect(result.items).toEqual([]);
		expect(result.carry).toBe('{"partial":');
	});

	it("skips empty lines", () => {
		const result = parseJsonlIncremental('{"a":1}\n\n{"b":2}\n', "");
		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips whitespace-only lines", () => {
		const result = parseJsonlIncremental('{"a":1}\n   \n{"b":2}\n', "");
		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("trims whitespace around JSON", () => {
		const result = parseJsonlIncremental('  {"a":1}  \n', "");
		expect(result.items).toEqual([{ a: 1 }]);
	});

	it("tracks offset correctly", () => {
		const skips: { offset: number; snippet: string }[] = [];
		parseJsonlIncremental('{"a":1}\nbroken\n', "", { onSkip: s => skips.push(s) });
		expect(skips[0].offset).toBe(8); // after first line + newline
	});

	it("truncates snippet to 200 chars", () => {
		const longLine = "x".repeat(300);
		const skips: { offset: number; snippet: string }[] = [];
		parseJsonlIncremental(`${longLine}\n`, "", { onSkip: s => skips.push(s) });
		expect(skips[0].snippet.length).toBe(200);
	});

	it("handles single line without newline", () => {
		const result = parseJsonlIncremental('{"a":1}', "");
		expect(result.items).toEqual([]);
		expect(result.carry).toBe('{"a":1}');
	});
});

describe("AnsiStripper", () => {
	it("strips ANSI escape sequences", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("passes through plain text", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("hello world")).toBe("hello world");
	});

	it("handles split escape sequences across chunks", () => {
		const stripper = new AnsiStripper();
		const part1 = stripper.push("\x1b[3");
		const part2 = stripper.push("1mred\x1b[0m");
		expect(part1).toBe("");
		expect(part2).toBe("red");
	});

	it("reports pending content as string", () => {
		const stripper = new AnsiStripper();
		stripper.push("\x1b[3");
		expect(typeof stripper.pending).toBe("string");
	});

	it("reports held bytes", () => {
		const stripper = new AnsiStripper();
		stripper.push("\x1b[3");
		expect(stripper.held).toBeGreaterThan(0);
	});

	it("handles empty input", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("")).toBe("");
	});

	it("handles multiple sequences in one chunk", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("\x1b[31mred\x1b[0m\x1b[32mgreen\x1b[0m")).toBe("redgreen");
	});

	it("handles C1 introducer conversion", () => {
		const stripper = new AnsiStripper();
		// C1 control codes (0x80-0x9F) should be converted to ESC + counterpart
		const result = stripper.push("text\x9b31mred\x9b0m");
		expect(result).toContain("text");
		expect(result).toContain("red");
	});
});
