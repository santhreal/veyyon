/**
 * After each single-line op on n=30, hash format holds and identity rebuild works.
 * Why: hash must remain valid 4-hex across every mutation class.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 hash after each op n30", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const h0 = computeFileHash(base);

	for (let line = 1; line <= n; line++) {
		it(`DEL ${line} changes hash then rebuild`, () => {
			const del = applyEdits(base, parsePatch(`DEL ${line}`).edits).text;
			expect(computeFileHash(del)).toMatch(/^[0-9A-F]{4}$/);
			expect(computeFileHash(del)).not.toBe(h0);
		});

		it(`SWAP ${line} changes hash`, () => {
			const sw = applyEdits(base, parsePatch(`SWAP ${line}.=${line}:\n+Z`).edits).text;
			expect(computeFileHash(sw)).not.toBe(h0);
			expect(sw.split("\n")[line - 1]).toBe("Z");
		});
	}

	it("full clear + rebuild restores hash", () => {
		const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
		expect(empty).toBe("");
		const body = lines.map(l => `+${l}`).join("\n");
		const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${body}`).edits).text;
		expect(back).toBe(base);
		expect(computeFileHash(back)).toBe(h0);
	});
});
