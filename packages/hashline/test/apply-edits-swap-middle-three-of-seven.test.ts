/**
 * SWAP middle three of seven-line file to one/two/three body lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP middle three of seven", () => {
	const text = "1\n2\n3\n4\n5\n6\n7";
	for (const k of [1, 2, 3, 4]) {
		it(`body k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+M${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 3.=5:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `M${i}`);
			expect(out).toBe(["1", "2", ...mid, "6", "7"].join("\n"));
		});
	}
});
