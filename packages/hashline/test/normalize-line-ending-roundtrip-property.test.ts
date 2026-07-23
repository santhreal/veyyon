/**
 * detectLineEnding / normalizeToLF / restoreLineEndings round-trip:
 * LF stays LF; CRLF files normalize then restore byte-identical for pure \r\n content.
 */
import { describe, expect, it } from "bun:test";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "@veyyon/hashline";

describe("normalize line ending roundtrip property", () => {
	it("detect prefers first ending", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
		expect(detectLineEnding("no newline")).toBe("\n");
		expect(detectLineEnding("")).toBe("\n");
		expect(detectLineEnding("\n")).toBe("\n");
		expect(detectLineEnding("\r\n")).toBe("\r\n");
	});

	it("normalizeToLF collapses CRLF and bare CR", () => {
		expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
		expect(normalizeToLF("a\nb")).toBe("a\nb");
		expect(normalizeToLF("")).toBe("");
	});

	for (const body of ["a\nb\nc", "single", "a\n", "\n\n", "line1\nline2\nline3"]) {
		it(`LF round-trip identity: ${JSON.stringify(body)}`, () => {
			const ending = detectLineEnding(body);
			expect(ending).toBe("\n");
			const norm = normalizeToLF(body);
			expect(restoreLineEndings(norm, "\n")).toBe(body);
		});
	}

	for (const lf of ["a\nb", "a\nb\nc\n", "x\n\ny"]) {
		it(`CRLF restore of LF body: ${JSON.stringify(lf)}`, () => {
			const crlf = restoreLineEndings(lf, "\r\n");
			expect(crlf.includes("\r\n")).toBe(true);
			expect(normalizeToLF(crlf)).toBe(lf);
			expect(detectLineEnding(crlf)).toBe("\r\n");
		});
	}

	it("stripBom exact", () => {
		expect(stripBom("\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
		expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
		expect(stripBom("")).toEqual({ bom: "", text: "" });
		expect(stripBom("\uFEFF")).toEqual({ bom: "\uFEFF", text: "" });
	});

	it("BOM then CRLF pipeline", () => {
		const raw = "\uFEFFa\r\nb\r\n";
		const { bom, text } = stripBom(raw);
		expect(bom).toBe("\uFEFF");
		expect(detectLineEnding(text)).toBe("\r\n");
		const lf = normalizeToLF(text);
		expect(lf).toBe("a\nb\n");
		const back = bom + restoreLineEndings(lf, "\r\n");
		expect(back).toBe(raw);
	});
});
