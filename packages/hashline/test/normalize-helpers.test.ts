import { describe, expect, it } from "bun:test";
import { detectLineEnding, hasUtf8Bom, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";

describe("detectLineEnding", () => {
	it("returns LF for LF-only content", () => {
		expect(detectLineEnding("a\nb\nc")).toBe("\n");
	});

	it("returns CRLF when CRLF comes first", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
	});

	it("returns LF when LF comes first", () => {
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
	});

	it("returns LF for no line endings", () => {
		expect(detectLineEnding("single line")).toBe("\n");
	});

	it("returns LF for empty string", () => {
		expect(detectLineEnding("")).toBe("\n");
	});

	it("returns CRLF for CRLF-only content", () => {
		expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n");
	});
});

describe("normalizeToLF", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeToLF("a\r\nb\r\nc")).toBe("a\nb\nc");
	});

	it("converts lone CR to LF", () => {
		expect(normalizeToLF("a\rb\rc")).toBe("a\nb\nc");
	});

	it("preserves LF", () => {
		expect(normalizeToLF("a\nb\nc")).toBe("a\nb\nc");
	});

	it("handles mixed line endings", () => {
		expect(normalizeToLF("a\r\nb\nc\rd")).toBe("a\nb\nc\nd");
	});

	it("handles empty string", () => {
		expect(normalizeToLF("")).toBe("");
	});

	it("handles no line endings", () => {
		expect(normalizeToLF("plain text")).toBe("plain text");
	});
});

describe("restoreLineEndings", () => {
	it("restores CRLF", () => {
		expect(restoreLineEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
	});

	it("preserves LF", () => {
		expect(restoreLineEndings("a\nb\nc", "\n")).toBe("a\nb\nc");
	});

	it("handles empty string", () => {
		expect(restoreLineEndings("", "\r\n")).toBe("");
	});

	it("handles no newlines", () => {
		expect(restoreLineEndings("plain", "\r\n")).toBe("plain");
	});
});

describe("stripBom", () => {
	it("strips BOM from start of content", () => {
		const result = stripBom("\uFEFFhello");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("hello");
	});

	it("returns unchanged when no BOM", () => {
		const result = stripBom("hello");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello");
	});

	it("handles empty string", () => {
		const result = stripBom("");
		expect(result.bom).toBe("");
		expect(result.text).toBe("");
	});

	it("does not strip BOM from middle", () => {
		const result = stripBom("hello\uFEFFworld");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello\uFEFFworld");
	});
});

describe("hasUtf8Bom", () => {
	it("returns true for UTF-8 BOM bytes", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe(true);
	});

	it("returns true for content with BOM prefix", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x65]))).toBe(true);
	});

	it("returns false for undefined", () => {
		expect(hasUtf8Bom(undefined)).toBe(false);
	});

	it("returns false for empty array", () => {
		expect(hasUtf8Bom(new Uint8Array(0))).toBe(false);
	});

	it("returns false for non-BOM bytes", () => {
		expect(hasUtf8Bom(new Uint8Array([0x68, 0x65, 0x6c]))).toBe(false);
	});

	it("returns false for too-short array", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb]))).toBe(false);
	});

	it("returns false for partial BOM match", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0x00]))).toBe(false);
	});
});
