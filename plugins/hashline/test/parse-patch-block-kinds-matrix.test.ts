/**
 * Block ops parse to kind block with expected modes.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch block kinds", () => {
	it("SWAP.BLK", () => {
		const { edits } = parsePatch("SWAP.BLK 5:\n+x\n+y");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.kind).toBe("block");
		if (edits[0]?.kind === "block") {
			expect(edits[0].anchor.line).toBe(5);
			expect(edits[0].payloads).toEqual(["x", "y"]);
		}
	});

	it("DEL.BLK", () => {
		const { edits } = parsePatch("DEL.BLK 3");
		expect(edits[0]?.kind).toBe("block");
		if (edits[0]?.kind === "block") {
			expect(edits[0].anchor.line).toBe(3);
			expect(edits[0].payloads).toEqual([]);
		}
	});

	it("INS.BLK.POST", () => {
		const { edits } = parsePatch("INS.BLK.POST 7:\n+z");
		expect(edits[0]?.kind).toBe("block");
		if (edits[0]?.kind === "block") {
			expect(edits[0].anchor.line).toBe(7);
			expect(edits[0].mode).toBe("insert_after");
			expect(edits[0].payloads).toEqual(["z"]);
		}
	});
});
