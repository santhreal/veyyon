import { describe, expect, it } from "bun:test";
import { applyEdits, normalizeToLF, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits on CRLF sources after normalizeToLF (product apply path shape).
 */

describe("applyEdits CRLF-normalized sources", () => {
	it("CRLF source normalized to LF then SWAP works", () => {
		const crlf = "a\r\nb\r\nc\r\n";
		const lf = normalizeToLF(crlf);
		expect(lf).toBe("a\nb\nc\n");
		const out = applyEdits(lf, parsePatch("SWAP 2.=2:\n+B2").edits).text;
		expect(out).toBe("a\nB2\nc\n");
	});

	it("mixed endings normalize then DEL", () => {
		const mixed = "a\r\nb\nc\r\n";
		const lf = normalizeToLF(mixed);
		const out = applyEdits(lf, parsePatch("DEL 2.=2").edits).text;
		expect(out).toBe("a\nc\n");
	});
});
