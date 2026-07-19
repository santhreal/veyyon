import { describe, expect, it } from "bun:test";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";

// normalize.ts canonicalizes text to LF before the patcher applies edits and
// restores the original line-ending shape on write-back. A wrong detection or
// restore silently rewrites every line ending in a file, so these assert the
// exact bytes for each ending style, mixed inputs, the lone-CR default, BOM
// round-tripping, and the detect -> normalize -> restore contract.

describe("detectLineEnding", () => {
	it("returns LF for LF-only content", () => {
		expect(detectLineEnding("a\nb\nc")).toBe("\n");
	});

	it("returns CRLF for CRLF-only content", () => {
		expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n");
	});

	it("returns LF when there is no line ending at all", () => {
		expect(detectLineEnding("single line, no newline")).toBe("\n");
		expect(detectLineEnding("")).toBe("\n");
	});

	it("treats a lone CR (old-Mac) as LF because no \\n is present", () => {
		expect(detectLineEnding("a\rb\rc")).toBe("\n");
	});

	it("picks the style of the FIRST ending when the file is mixed", () => {
		// CRLF appears before the first bare LF -> CRLF wins.
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		// A bare LF appears before any CRLF -> LF wins.
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
	});

	it("reports CRLF when the very first character pair is CRLF", () => {
		expect(detectLineEnding("\r\nrest")).toBe("\r\n");
	});
});

describe("normalizeToLF", () => {
	it("rewrites CRLF to LF", () => {
		expect(normalizeToLF("a\r\nb\r\nc")).toBe("a\nb\nc");
	});

	it("rewrites a lone CR to LF", () => {
		expect(normalizeToLF("a\rb\rc")).toBe("a\nb\nc");
	});

	it("leaves already-LF text unchanged", () => {
		expect(normalizeToLF("a\nb\nc")).toBe("a\nb\nc");
	});

	it("handles a mix of CRLF, lone CR, and LF in one pass", () => {
		expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});
});

describe("restoreLineEndings", () => {
	it("re-encodes LF text as CRLF", () => {
		expect(restoreLineEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
	});

	it("leaves LF text unchanged when the target ending is LF", () => {
		expect(restoreLineEndings("a\nb\nc", "\n")).toBe("a\nb\nc");
	});

	it("is a no-op on text with no line endings", () => {
		expect(restoreLineEndings("no newlines", "\r\n")).toBe("no newlines");
	});
});

describe("detect -> normalize -> restore round trip", () => {
	it("reconstructs CRLF content exactly", () => {
		const original = "line one\r\nline two\r\nline three";
		const ending = detectLineEnding(original);
		const restored = restoreLineEndings(normalizeToLF(original), ending);
		expect(restored).toBe(original);
	});

	it("reconstructs LF content exactly", () => {
		const original = "line one\nline two\n";
		const ending = detectLineEnding(original);
		const restored = restoreLineEndings(normalizeToLF(original), ending);
		expect(restored).toBe(original);
	});
});

describe("stripBom", () => {
	// Use the explicit \uFEFF escape so an editor that silently drops the
	// invisible BOM character cannot quietly weaken these assertions.
	it("removes a leading UTF-8 BOM and reports it", () => {
		const { bom, text } = stripBom("\uFEFFhello");
		expect(bom).toBe("\uFEFF");
		expect(text).toBe("hello");
	});

	it("reports an empty BOM and unchanged text when none is present", () => {
		const { bom, text } = stripBom("hello");
		expect(bom).toBe("");
		expect(text).toBe("hello");
	});

	it("only strips a BOM at the very start, not one mid-string", () => {
		const { bom, text } = stripBom("a\uFEFFb");
		expect(bom).toBe("");
		expect(text).toBe("a\uFEFFb");
	});

	it("round-trips: bom + text reconstructs the original", () => {
		const original = "\uFEFFcontent\nmore";
		const { bom, text } = stripBom(original);
		expect(bom + text).toBe(original);
	});
});
