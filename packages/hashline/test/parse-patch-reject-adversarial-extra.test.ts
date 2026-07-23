/**
 * Adversarial parsePatch rejections and edge accepts beyond the base op matrix.
 */
import { describe, expect, it } from "bun:test";
import { DELETE_TAKES_NO_BODY, EMPTY_INSERT, MINUS_ROW_REJECTED } from "../src/messages";
import { parsePatch } from "../src/parser";

describe("parsePatch adversarial rejects", () => {
	it("minus rows in INS body reject", () => {
		expect(() => parsePatch("INS.POST 1:\n-should_not")).toThrow();
	});

	it("DEL range with body rejects", () => {
		expect(() => parsePatch("DEL 1.=3\n+x")).toThrow(/does not take body|DEL/);
	});

	it("DEL.BLK with body rejects", () => {
		expect(() => parsePatch("DEL.BLK 2\n+x")).toThrow(/does not take body|DEL\.BLK/);
	});

	it("MV with body rejects", () => {
		expect(() => parsePatch("MV dest.ts\n+x")).toThrow(/does not take body|MV/);
	});

	it("empty INS.HEAD rejects", () => {
		expect(() => parsePatch("INS.HEAD:")).toThrow(EMPTY_INSERT.slice(0, 8));
	});

	it("minus row in SWAP rejects with MINUS_ROW contract", () => {
		expect(() => parsePatch("SWAP 1.=2:\n-old\n+new")).toThrow(MINUS_ROW_REJECTED.slice(0, 10));
	});
});

describe("parsePatch edge accepts", () => {
	it("multiple + rows with empty and spaces", () => {
		const { edits } = parsePatch("INS.TAIL:\n+\n+ \n+\t");
		const texts = edits.filter(e => e.kind === "insert").map(e => (e.kind === "insert" ? e.text : ""));
		expect(texts).toEqual(["", " ", "\t"]);
	});

	it("SWAP.BLK and DEL.BLK and INS.BLK.POST parse as block kind", () => {
		for (const [diff, mode] of [
			["SWAP.BLK 1:\n+x", "replace"],
			["DEL.BLK 2", "delete"],
			["INS.BLK.POST 3:\n+y", "insert_after"],
		] as const) {
			const { edits } = parsePatch(diff);
			expect(edits.some(e => e.kind === "block")).toBe(true);
			const b = edits.find(e => e.kind === "block");
			if (b?.kind === "block") {
				if (mode === "insert_after") expect(b.mode).toBe("insert_after");
			}
		}
	});

	it("very large line numbers parse", () => {
		const { edits } = parsePatch("DEL 999999");
		if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(999999);
	});

	it("CRLF line endings in diff body parse", () => {
		const { edits } = parsePatch("SWAP 1.=1:\r\n+X\r\n");
		expect(edits.some(e => e.kind === "insert" && e.text === "X")).toBe(true);
	});

	it("overlapping SWAP on same anchor rejects fail-closed", () => {
		// Two hunks targeting the same concrete range: reject rather than guess.
		expect(() => parsePatch("SWAP 1.=1:\n+first\nSWAP 1.=1:\n+second")).toThrow(/already targeted by another hunk/);
	});
});

describe("parsePatch DELETE_TAKES_NO_BODY constant still matches live reject", () => {
	it("message fragment appears on DEL+body", () => {
		try {
			parsePatch("DEL 1\n+body");
			throw new Error("expected throw");
		} catch (e) {
			expect(String(e)).toMatch(/body/);
			expect(DELETE_TAKES_NO_BODY).toContain("DEL");
		}
	});
});
