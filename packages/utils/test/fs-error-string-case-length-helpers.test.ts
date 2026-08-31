import { describe, expect, it } from "bun:test";
import {
	enoentError,
	type FsError,
	hasFsCode,
	isEacces,
	isEexist,
	isEisdir,
	isEnoent,
	isEnotdir,
	isFsError,
	isMissingPath,
} from "../src/fs-error";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";
import { codePointLength, isWellFormedUtf16, utf8ByteLength } from "../src/string-length";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";

describe("isFsError", () => {
	it("returns true for Error with string code", () => {
		const err = new Error("fail") as FsError;
		err.code = "ENOENT";
		expect(isFsError(err)).toBe(true);
	});

	it("returns false for Error without code", () => {
		expect(isFsError(new Error("fail"))).toBe(false);
	});

	it("returns false for non-Error", () => {
		expect(isFsError("string")).toBe(false);
		expect(isFsError({ code: "ENOENT" })).toBe(false);
		expect(isFsError(null)).toBe(false);
		expect(isFsError(undefined)).toBe(false);
	});

	it("returns false for Error with non-string code", () => {
		const err = new Error("fail") as Error & { code: unknown };
		err.code = 42;
		expect(isFsError(err)).toBe(false);
	});
});

describe("isEnoent", () => {
	it("returns true for ENOENT error", () => {
		const err = new Error("not found") as FsError;
		err.code = "ENOENT";
		expect(isEnoent(err)).toBe(true);
	});

	it("returns false for other error codes", () => {
		const err = new Error("denied") as FsError;
		err.code = "EACCES";
		expect(isEnoent(err)).toBe(false);
	});

	it("returns false for non-fs error", () => {
		expect(isEnoent(new Error("fail"))).toBe(false);
	});
});

describe("enoentError", () => {
	it("creates an ENOENT error with path", () => {
		const err = enoentError("/some/path");
		expect(err.code).toBe("ENOENT");
		expect(err.errno).toBe(-2);
		expect(err.syscall).toBe("open");
		expect(err.path).toBe("/some/path");
		expect(err.message).toContain("ENOENT");
		expect(err.message).toContain("/some/path");
	});

	it("is detected by isEnoent", () => {
		expect(isEnoent(enoentError("/test"))).toBe(true);
	});

	it("is detected by isFsError", () => {
		expect(isFsError(enoentError("/test"))).toBe(true);
	});
});

describe("isEacces", () => {
	it("returns true for EACCES error", () => {
		const err = new Error("denied") as FsError;
		err.code = "EACCES";
		expect(isEacces(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		const err = new Error("not found") as FsError;
		err.code = "ENOENT";
		expect(isEacces(err)).toBe(false);
	});
});

describe("isEisdir", () => {
	it("returns true for EISDIR error", () => {
		const err = new Error("is a directory") as FsError;
		err.code = "EISDIR";
		expect(isEisdir(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		expect(isEisdir(enoentError("/test"))).toBe(false);
	});
});

describe("isEnotdir", () => {
	it("returns true for ENOTDIR error", () => {
		const err = new Error("not a directory") as FsError;
		err.code = "ENOTDIR";
		expect(isEnotdir(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		expect(isEnotdir(enoentError("/test"))).toBe(false);
	});
});

describe("isMissingPath", () => {
	it("returns true for ENOENT", () => {
		expect(isMissingPath(enoentError("/test"))).toBe(true);
	});

	it("returns true for ENOTDIR", () => {
		const err = new Error("not a dir") as FsError;
		err.code = "ENOTDIR";
		expect(isMissingPath(err)).toBe(true);
	});

	it("returns false for EACCES", () => {
		const err = new Error("denied") as FsError;
		err.code = "EACCES";
		expect(isMissingPath(err)).toBe(false);
	});
});

describe("isEexist", () => {
	it("returns true for EEXIST error", () => {
		const err = new Error("already exists") as FsError;
		err.code = "EEXIST";
		expect(isEexist(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		expect(isEexist(enoentError("/test"))).toBe(false);
	});
});

describe("hasFsCode", () => {
	it("returns true when code matches", () => {
		const err = new Error("custom") as FsError;
		err.code = "CUSTOM_CODE";
		expect(hasFsCode(err, "CUSTOM_CODE")).toBe(true);
	});

	it("returns false when code does not match", () => {
		const err = new Error("custom") as FsError;
		err.code = "OTHER_CODE";
		expect(hasFsCode(err, "CUSTOM_CODE")).toBe(false);
	});

	it("returns false for non-fs error", () => {
		expect(hasFsCode(new Error("fail"), "ENOENT")).toBe(false);
	});
});

describe("kebabToCamel", () => {
	it("converts simple kebab-case to camelCase", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
	});

	it("converts multi-word kebab-case", () => {
		expect(kebabToCamel("my-cool-setting")).toBe("myCoolSetting");
	});

	it("returns unchanged when no hyphens", () => {
		expect(kebabToCamel("simple")).toBe("simple");
	});

	it("does not lift numeric segments", () => {
		expect(kebabToCamel("utf-8")).toBe("utf-8");
	});

	it("does not lift already-uppercase segments", () => {
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});

	it("handles empty string", () => {
		expect(kebabToCamel("")).toBe("");
	});

	it("handles single hyphen", () => {
		expect(kebabToCamel("-")).toBe("-");
	});

	it("handles trailing hyphen", () => {
		expect(kebabToCamel("key-")).toBe("key-");
	});

	it("handles leading hyphen (converts lowercase after it)", () => {
		expect(kebabToCamel("-key")).toBe("Key");
	});

	it("converts only lowercase letters after hyphen", () => {
		expect(kebabToCamel("a-b-c")).toBe("aBC");
	});

	it("handles mixed case with hyphens", () => {
		expect(kebabToCamel("foo-Bar")).toBe("foo-Bar");
	});
});

describe("titleCaseWords", () => {
	it("capitalizes each word", () => {
		expect(titleCaseWords("hello world")).toBe("Hello World");
	});

	it("handles single word", () => {
		expect(titleCaseWords("hello")).toBe("Hello");
	});

	it("handles empty string", () => {
		expect(titleCaseWords("")).toBe("");
	});

	it("handles multiple spaces", () => {
		expect(titleCaseWords("hello   world")).toBe("Hello World");
	});

	it("handles leading/trailing whitespace", () => {
		expect(titleCaseWords("  hello  ")).toBe("Hello");
	});

	it("preserves acronyms after first letter", () => {
		expect(titleCaseWords("foo bar")).toBe("Foo Bar");
	});

	it("handles tabs and newlines", () => {
		expect(titleCaseWords("hello\tworld\nfoo")).toBe("Hello World Foo");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes first letter of sentence", () => {
		expect(titleCaseSentence("hello world")).toBe("Hello world");
	});

	it("handles empty string", () => {
		expect(titleCaseSentence("")).toBe("");
	});

	it("handles whitespace-only string", () => {
		expect(titleCaseSentence("   ")).toBe("");
	});

	it("trims leading whitespace", () => {
		expect(titleCaseSentence("  hello")).toBe("Hello");
	});

	it("trims trailing whitespace", () => {
		expect(titleCaseSentence("hello  ")).toBe("Hello");
	});

	it("preserves rest of sentence casing", () => {
		expect(titleCaseSentence("hello World")).toBe("Hello World");
	});

	it("handles single character", () => {
		expect(titleCaseSentence("a")).toBe("A");
	});

	it("handles already capitalized", () => {
		expect(titleCaseSentence("Hello")).toBe("Hello");
	});
});

describe("codePointLength", () => {
	it("counts ASCII characters", () => {
		expect(codePointLength("hello")).toBe(5);
	});

	it("counts empty string as 0", () => {
		expect(codePointLength("")).toBe(0);
	});

	it("counts multi-byte characters as single code points", () => {
		expect(codePointLength("héllo")).toBe(5);
	});

	it("counts emoji as single code point", () => {
		expect(codePointLength("a😀b")).toBe(3);
	});

	it("counts surrogate pairs as single code point", () => {
		expect(codePointLength("a𝕏b")).toBe(3);
	});

	it("counts CJK characters", () => {
		expect(codePointLength("你好")).toBe(2);
	});
});

describe("utf8ByteLength", () => {
	it("counts ASCII as 1 byte each", () => {
		expect(utf8ByteLength("hello")).toBe(5);
	});

	it("counts empty string as 0", () => {
		expect(utf8ByteLength("")).toBe(0);
	});

	it("counts Latin-1 characters as 2 bytes", () => {
		expect(utf8ByteLength("é")).toBe(2);
	});

	it("counts CJK characters as 3 bytes", () => {
		expect(utf8ByteLength("你")).toBe(3);
	});

	it("counts emoji as 4 bytes", () => {
		expect(utf8ByteLength("😀")).toBe(4);
	});

	it("handles mixed content", () => {
		// 'a' (1) + 'é' (2) + '你' (3) + '😀' (4) = 10
		expect(utf8ByteLength("aé你😀")).toBe(10);
	});

	it("respects start parameter", () => {
		expect(utf8ByteLength("hello", 1)).toBe(4);
	});

	it("respects end parameter", () => {
		expect(utf8ByteLength("hello", 0, 3)).toBe(3);
	});

	it("handles lone high surrogate as 3 bytes", () => {
		// A lone high surrogate (no low surrogate following) is 3 bytes
		expect(utf8ByteLength("\uD800")).toBe(3);
	});

	it("handles lone low surrogate as 3 bytes", () => {
		expect(utf8ByteLength("\uDC00")).toBe(3);
	});
});

describe("isWellFormedUtf16", () => {
	it("returns true for ASCII", () => {
		expect(isWellFormedUtf16("hello")).toBe(true);
	});

	it("returns true for empty string", () => {
		expect(isWellFormedUtf16("")).toBe(true);
	});

	it("returns true for valid surrogate pair", () => {
		expect(isWellFormedUtf16("a𝕏b")).toBe(true);
	});

	it("returns true for emoji", () => {
		expect(isWellFormedUtf16("😀")).toBe(true);
	});

	it("returns false for lone high surrogate", () => {
		expect(isWellFormedUtf16("\uD800")).toBe(false);
	});

	it("returns false for lone high surrogate at end", () => {
		expect(isWellFormedUtf16("abc\uD800")).toBe(false);
	});

	it("returns false for high surrogate followed by non-low", () => {
		expect(isWellFormedUtf16("\uD800a")).toBe(false);
	});

	it("returns false for lone low surrogate", () => {
		expect(isWellFormedUtf16("\uDC00")).toBe(false);
	});

	it("returns false for lone low surrogate in middle", () => {
		expect(isWellFormedUtf16("ab\uDC00cd")).toBe(false);
	});

	it("returns true for multiple valid surrogate pairs", () => {
		expect(isWellFormedUtf16("😀👍")).toBe(true);
	});
});

describe("firstNonEmpty", () => {
	it("returns first non-empty trimmed value", () => {
		expect(firstNonEmpty("", "  ", "hello", "world")).toBe("hello");
	});

	it("returns null when all values are empty", () => {
		expect(firstNonEmpty("", "  ", undefined, null)).toBeNull();
	});

	it("returns null for no arguments", () => {
		expect(firstNonEmpty()).toBeNull();
	});

	it("handles undefined and null", () => {
		expect(firstNonEmpty(undefined, null, "value")).toBe("value");
	});

	it("trims the returned value", () => {
		expect(firstNonEmpty("  hello  ")).toBe("hello");
	});

	it("returns first non-empty when multiple non-empty", () => {
		expect(firstNonEmpty("", "first", "second")).toBe("first");
	});

	it("handles whitespace-only as empty", () => {
		expect(firstNonEmpty("   ", "\t\n", "found")).toBe("found");
	});
});

describe("nonEmptyTrimmed", () => {
	it("filters out empty and whitespace-only values", () => {
		expect(nonEmptyTrimmed(["hello", "", "  ", "world"])).toEqual(["hello", "world"]);
	});

	it("trims each value", () => {
		expect(nonEmptyTrimmed(["  hello  ", "  world  "])).toEqual(["hello", "world"]);
	});

	it("handles undefined and null in array", () => {
		expect(nonEmptyTrimmed([undefined, null, "value"])).toEqual(["value"]);
	});

	it("returns empty array for all empty input", () => {
		expect(nonEmptyTrimmed(["", "  ", undefined])).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
	});

	it("preserves order", () => {
		expect(nonEmptyTrimmed(["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});

	it("handles iterable (Set)", () => {
		expect(nonEmptyTrimmed(new Set(["a", "", "b"]))).toEqual(["a", "b"]);
	});
});
