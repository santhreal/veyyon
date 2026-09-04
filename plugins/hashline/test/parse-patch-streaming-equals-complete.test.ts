/**
 * parsePatchStreaming on complete input matches parsePatch edit kinds and texts.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch, parsePatchStreaming } from "../src/parser";

describe("parsePatchStreaming equals parsePatch for complete inputs", () => {
	const diffs = [
		"DEL 1",
		"SWAP 1.=1:\n+X",
		"INS.HEAD:\n+H",
		"INS.TAIL:\n+T",
		"INS.POST 2:\n+a\n+b",
		"DEL 1.=3",
		"SWAP 2.=4:\n+A\n+B",
		"INS.PRE 1:\n+P",
	];
	for (const diff of diffs) {
		it(JSON.stringify(diff).slice(0, 40), () => {
			const a = parsePatch(diff);
			const b = parsePatchStreaming(diff);
			expect(b.edits.map(e => e.kind)).toEqual(a.edits.map(e => e.kind));
			const aTexts = a.edits.filter(e => e.kind === "insert").map(e => (e.kind === "insert" ? e.text : ""));
			const bTexts = b.edits.filter(e => e.kind === "insert").map(e => (e.kind === "insert" ? e.text : ""));
			expect(bTexts).toEqual(aTexts);
		});
	}
});
