/**
 * Applying empty edits and identity SWAPs twice is stable on n=30.
 * Why: re-apply of no-op patches must not drift text or firstChangedLine.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 double apply identity ops n30", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("empty edits twice", () => {
		const r1 = applyEdits(base, []);
		const r2 = applyEdits(r1.text, []);
		expect(r1.text).toBe(base);
		expect(r2.text).toBe(base);
	});

	it("identity SWAP all twice", () => {
		const hunks = lines.map((l, i) => `SWAP ${i + 1}.=${i + 1}:\n+${l}`).join("\n");
		const edits = parsePatch(hunks).edits;
		const r1 = applyEdits(base, edits);
		const r2 = applyEdits(r1.text, edits);
		expect(r1.text).toBe(base);
		expect(r2.text).toBe(base);
	});

	for (let line = 1; line <= n; line++) {
		it(`identity SWAP ${line} twice`, () => {
			const body = lines[line - 1];
			const edits = parsePatch(`SWAP ${line}.=${line}:\n+${body}`).edits;
			const r1 = applyEdits(base, edits);
			const r2 = applyEdits(r1.text, edits);
			expect(r1.text).toBe(base);
			expect(r2.text).toBe(base);
		});
	}
});
