/**
 * applyEdits on CRLF text: normalize-aware consumers split on \n only after
 * normalizeToLF — document that raw applyEdits sees \r in line content unless
 * pre-normalized.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	normalizeToLF,
	parsePatch,
	restoreLineEndings,
	detectLineEnding,
} from "@veyyon/hashline";

describe("applyEdits CRLF via normalize path", () => {
	it("normalize → apply → restore roundtrip", () => {
		const crlf = "a\r\nb\r\nc\r\n";
		expect(detectLineEnding(crlf)).toBe("\r\n");
		const lf = normalizeToLF(crlf);
		const { text } = applyEdits(lf, parsePatch("SWAP 2.=2:\n+B").edits);
		expect(text).toBe("a\nB\nc\n");
		const back = restoreLineEndings(text, "\r\n");
		expect(back).toBe("a\r\nB\r\nc\r\n");
	});

	it("raw CRLF without normalize leaves \\r on lines", () => {
		const crlf = "a\r\nb\r\nc";
		// split("\n") yields "a\r", "b\r", "c"
		const { text } = applyEdits(crlf, parsePatch("DEL 2").edits);
		// line 2 is "b\r"
		expect(text.includes("b")).toBe(false);
		expect(text.startsWith("a")).toBe(true);
	});
});
