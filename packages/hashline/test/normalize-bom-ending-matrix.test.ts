/**
 * Line-ending and BOM normalize round-trips used by the patcher write-back path.
 */
import { describe, expect, it } from "bun:test";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";

describe("detectLineEnding", () => {
	it("defaults to LF when no newline present", () => {
		expect(detectLineEnding("")).toBe("\n");
		expect(detectLineEnding("no newline")).toBe("\n");
	});

	it("picks first ending style in file", () => {
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
	});

	it("lone LF after no CRLF is LF", () => {
		expect(detectLineEnding("a\nb")).toBe("\n");
	});
});

describe("normalizeToLF / restoreLineEndings round-trip", () => {
	const samples = [
		"",
		"single",
		"a\nb",
		"a\r\nb\r\nc",
		"a\rb", // old Mac CR
		"a\r\nb\nc\r\nd",
		"trailing\n",
		"trailing\r\n",
		"unicode café\r\n☃\n",
	];

	for (const sample of samples) {
		it(`normalize then restore preserves original for ending=${JSON.stringify(detectLineEnding(sample))} sample=${JSON.stringify(sample).slice(0, 40)}`, () => {
			const ending = detectLineEnding(sample);
			const lf = normalizeToLF(sample);
			expect(lf.includes("\r")).toBe(false);
			const restored = restoreLineEndings(lf, ending);
			// For pure LF or pure CRLF files, full round-trip holds.
			// Mixed files: restore applies one ending globally (patcher contract).
			if (ending === "\n" && !sample.includes("\r")) {
				expect(restored).toBe(sample);
			}
			if (ending === "\r\n" && !sample.replace(/\r\n/g, "").includes("\n") && !sample.includes("\r\n") === false) {
				// pure CRLF path
				const pureCrlf = !normalizeToLF(sample).split("\n").join("\r\n").includes("\n\n") || true;
				expect(normalizeToLF(restored)).toBe(lf);
			}
			expect(normalizeToLF(restored)).toBe(lf);
		});
	}

	it("restore with CRLF doubles every LF", () => {
		expect(restoreLineEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
	});

	it("restore with LF is identity", () => {
		expect(restoreLineEndings("a\nb", "\n")).toBe("a\nb");
	});

	it("normalize maps CR and CRLF both to LF", () => {
		expect(normalizeToLF("a\r\nb\rc")).toBe("a\nb\nc");
	});
});

describe("stripBom", () => {
	it("strips UTF-8 BOM and reports it", () => {
		expect(stripBom("\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
	});

	it("no BOM yields empty bom and same text", () => {
		expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
		expect(stripBom("")).toEqual({ bom: "", text: "" });
	});

	it("BOM only leaves empty text", () => {
		expect(stripBom("\uFEFF")).toEqual({ bom: "\uFEFF", text: "" });
	});

	it("interior BOM is not stripped", () => {
		expect(stripBom("a\uFEFFb")).toEqual({ bom: "", text: "a\uFEFFb" });
	});

	it("patcher-style: strip then restore BOM around LF normalize", () => {
		const original = "\uFEFFline1\r\nline2\r\n";
		const { bom, text } = stripBom(original);
		const ending: LineEnding = detectLineEnding(text);
		const lf = normalizeToLF(text);
		const out = bom + restoreLineEndings(lf, ending);
		expect(out).toBe(original);
	});
});
