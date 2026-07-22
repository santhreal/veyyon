/**
 * parsePatch edits count and kind shape for single-op patches.
 * Why: SWAP lowers to insert+delete; DEL/INS stay one edit each.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 parsePatch edits count matrix", () => {
	for (let line = 1; line <= 100; line++) {
		it(`DEL ${line} one delete`, () => {
			const { edits, warnings } = parsePatch(`DEL ${line}`);
			expect(edits).toHaveLength(1);
			expect(edits[0]!.kind).toBe("delete");
			expect(Array.isArray(warnings)).toBe(true);
		});

		it(`SWAP ${line} lowers to insert then delete`, () => {
			const { edits } = parsePatch(`SWAP ${line}.=${line}:\n+x`);
			expect(edits).toHaveLength(2);
			expect(edits[0]!.kind).toBe("insert");
			expect(edits[1]!.kind).toBe("delete");
		});

		it(`INS.POST ${line} one insert`, () => {
			const { edits } = parsePatch(`INS.POST ${line}:\n+x`);
			expect(edits).toHaveLength(1);
			expect(edits[0]!.kind).toBe("insert");
		});
	}

	it("multi 10 DELs", () => {
		const hunks = Array.from({ length: 10 }, (_, i) => `DEL ${i + 1}`).join("\n");
		expect(parsePatch(hunks).edits).toHaveLength(10);
	});

	it("empty patch zero edits", () => {
		expect(parsePatch("").edits).toHaveLength(0);
	});

	it("SWAP range 3..=5 with one body row: 1 insert + 3 deletes", () => {
		const { edits } = parsePatch("SWAP 3.=5:\n+only");
		expect(edits.filter((e) => e.kind === "insert")).toHaveLength(1);
		expect(edits.filter((e) => e.kind === "delete")).toHaveLength(3);
	});
});
