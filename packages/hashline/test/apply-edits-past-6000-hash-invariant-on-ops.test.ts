/**
 * computeFileHash: identity ops keep hash; mutating ops change hash; rebuild restores.
 * Why: file hash is the mismatch/recovery key — silent hash stability bugs break apply.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 hash invariant on ops", () => {
	const bases = [
		"",
		"a",
		"a\nb",
		Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n"),
		"café\n🚀",
	];

	for (const [bi, base] of bases.entries()) {
		it(`base#${bi} identity SWAP preserves hash when body matches`, () => {
			if (base === "") return;
			const lines = base.split("\n");
			const hunks = lines
				.map((line, i) => `SWAP ${i + 1}.=${i + 1}:\n+${line}`)
				.join("\n");
			const { text } = applyEdits(base, parsePatch(hunks).edits);
			expect(text).toBe(base);
			expect(computeFileHash(text)).toBe(computeFileHash(base));
		});

		it(`base#${bi} HEAD insert changes hash`, () => {
			const h0 = computeFileHash(base);
			const { text } = applyEdits(base, parsePatch("INS.HEAD:\n+NEW").edits);
			expect(computeFileHash(text)).not.toBe(h0);
			expect(text.startsWith("NEW")).toBe(true);
		});
	}

	it("DEL then rebuild restores hash", () => {
		const base = "A\nB\nC\nD";
		const h0 = computeFileHash(base);
		const empty = applyEdits(base, parsePatch("DEL 1.=4").edits).text;
		expect(empty).toBe("");
		const back = applyEdits(empty, parsePatch("INS.HEAD:\n+A\n+B\n+C\n+D").edits).text;
		expect(computeFileHash(back)).toBe(h0);
	});

	it("hash is 4 uppercase hex", () => {
		for (const s of ["", "x", "a\nb\nc", "日本語"]) {
			const h = computeFileHash(s);
			expect(h).toMatch(/^[0-9A-F]{4}$/);
		}
	});
});
