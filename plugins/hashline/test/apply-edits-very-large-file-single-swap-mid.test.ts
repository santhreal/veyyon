/**
 * n=200 file: SWAP mid line leaves prefix/suffix identity.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits very large file single SWAP mid", () => {
	it("n=200 SWAP mid", () => {
		const n = 200;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const mid = 100;
		const { text } = applyEdits(base, parsePatch(`SWAP ${mid}.=${mid}:\n+MID`).edits);
		const out = text.split("\n");
		expect(out).toHaveLength(n);
		expect(out[mid - 1]).toBe("MID");
		expect(out.slice(0, mid - 1)).toEqual(lines.slice(0, mid - 1));
		expect(out.slice(mid)).toEqual(lines.slice(mid));
	});

	it("n=200 DEL first 50", () => {
		const n = 200;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const { text } = applyEdits(base, parsePatch("DEL 1.=50").edits);
		expect(text.split("\n")).toEqual(lines.slice(50));
	});
});
