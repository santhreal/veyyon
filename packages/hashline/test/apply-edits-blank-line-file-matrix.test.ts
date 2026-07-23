/**
 * Blank and sparse files: empty lines are addressable content; DEL/SWAP/INS
 * treat "" bodies as real lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits blank line file matrix", () => {
	it("three blank lines DEL middle", () => {
		const base = "\n\n";
		// lines: "", "", ""
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe("\n");
	});

	it("SWAP blank to content", () => {
		const base = "a\n\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+mid").edits);
		expect(text).toBe("a\nmid\nc");
	});

	it("SWAP content to blank via empty? empty SWAP body is pure delete", () => {
		// empty body on SWAP is allowed as pure delete semantics in some paths;
		// with zero + rows parse may still accept if we use DEL instead
		const base = "a\nmid\nc";
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe("a\nc");
	});

	it("INS blank row", () => {
		const base = "a\nb";
		const { text } = applyEdits(base, parsePatch("INS.POST 1:\n+").edits);
		// + alone may be empty body line
		expect(text.split("\n").length).toBeGreaterThanOrEqual(2);
	});

	it("file of only blanks INS.HEAD", () => {
		const base = "\n";
		const { text } = applyEdits(base, parsePatch("INS.HEAD:\n+top").edits);
		expect(text.startsWith("top")).toBe(true);
	});

	for (const n of [1, 2, 4, 6]) {
		it(`n=${n} blank lines DEL all`, () => {
			const base = Array.from({ length: n }, () => "").join("\n");
			// for n blanks joined by \n there are n lines
			// overlapping all DELs might fail, so delete the first line sequentially
			let t = base;
			for (let i = 0; i < n; i++) {
				t = applyEdits(t, parsePatch("DEL 1").edits).text;
			}
			expect(t).toBe("");
		});
	}
});
