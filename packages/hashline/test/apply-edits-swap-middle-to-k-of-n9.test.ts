/**
 * SWAP middle line (5) of 9-line file to k=1..6 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP middle of 9 to k", () => {
	const base = Array.from({ length: 9 }, (_, i) => `L${i + 1}`);
	const text = base.join("\n");
	for (const k of [1, 2, 3, 4, 5, 6]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+M${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 5.=5:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `M${i}`);
			expect(out).toBe([...base.slice(0, 4), ...mid, ...base.slice(5)].join("\n"));
		});
	}
});
