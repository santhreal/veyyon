import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	detectLineEnding,
	formatDeleteHeader,
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	formatReplaceHeader,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "@veyyon/hashline";

/**
 * Hashline format + line-ending normalize contracts: exact strings and hashes.
 * LineEnding is the literal "\n" | "\r\n", not named tokens.
 */

describe("formatHashlineHeader and numbered lines", () => {
	it("builds [path#hash] with exact delimiters", () => {
		expect(formatHashlineHeader("src/a.ts", "ab12")).toBe("[src/a.ts#ab12]");
	});

	it("formatNumberedLine uses LINE:content shape", () => {
		expect(formatNumberedLine(3, "hello")).toBe("3:hello");
	});

	it("formatNumberedLines numbers from startLine", () => {
		const out = formatNumberedLines("a\nb\n", 10);
		expect(out).toContain("10:a");
		expect(out).toContain("11:b");
	});

	it("formatReplaceHeader and formatDeleteHeader use SWAP/DEL keywords", () => {
		expect(formatReplaceHeader(2, 4)).toMatch(/SWAP/);
		expect(formatReplaceHeader(2, 4)).toContain("2");
		expect(formatReplaceHeader(2, 4)).toContain("4");
		expect(formatDeleteHeader(5, 7)).toMatch(/DEL/);
		expect(formatDeleteHeader(5, 7)).toContain("5");
	});
});

describe("computeFileHash", () => {
	it("is stable and 4 hex chars for normal text", () => {
		const h = computeFileHash("hello\n");
		expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
		expect(computeFileHash("hello\n")).toBe(h);
	});

	it("changes when any character changes", () => {
		expect(computeFileHash("a\n")).not.toBe(computeFileHash("b\n"));
	});

	it("empty string has a stable hash", () => {
		const h = computeFileHash("");
		expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
		expect(computeFileHash("")).toBe(h);
	});

	it("unicode content produces a deterministic hash", () => {
		const body = "日本語\n🙂\n";
		expect(computeFileHash(body)).toBe(computeFileHash(body));
		expect(computeFileHash(body)).not.toBe(computeFileHash("日本語\n"));
	});
});

describe("line ending normalize", () => {
	it("detectLineEnding returns literal \\n or \\r\\n", () => {
		expect(detectLineEnding("a\nb\n")).toBe("\n");
		expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
		// No newlines → default LF.
		expect(detectLineEnding("none")).toBe("\n");
	});

	it("normalizeToLF converts CRLF and lone CR to LF", () => {
		expect(normalizeToLF("a\r\nb\r\n")).toBe("a\nb\n");
		expect(normalizeToLF("a\rb\r")).toBe("a\nb\n");
		expect(normalizeToLF("a\nb\n")).toBe("a\nb\n");
	});

	it("restoreLineEndings re-encodes LF text with \\r\\n when requested", () => {
		const lf = "a\nb\n";
		expect(restoreLineEndings(lf, "\r\n")).toBe("a\r\nb\r\n");
		expect(restoreLineEndings(lf, "\n")).toBe(lf);
	});

	it("detect then restore round-trips CRLF source through LF work form", () => {
		const original = "a\r\nb\r\n";
		const ending = detectLineEnding(original);
		expect(ending).toBe("\r\n");
		const lf = normalizeToLF(original);
		expect(lf).toBe("a\nb\n");
		expect(restoreLineEndings(lf, ending)).toBe(original);
	});

	it("stripBom removes a leading UTF-8 BOM when present", () => {
		const result = stripBom("\uFEFFhello");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("hello");
	});

	it("stripBom leaves BOM-free text unchanged", () => {
		const result = stripBom("plain");
		expect(result.bom).toBe("");
		expect(result.text).toBe("plain");
	});
});
