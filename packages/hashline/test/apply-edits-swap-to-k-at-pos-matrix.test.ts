/**
 * Expand position p of 3-line file to k lines for all p,k in small range.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand pos×k on 3-line", () => {
	const base = ["a", "b", "c"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 3; pos++) {
		for (let k = 1; k <= 5; k++) {
			it(`pos=${pos} k=${k}`, () => {
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const { text: out } = applyEdits(
					text,
					parsePatch(`SWAP ${pos}.=${pos}:\n${body}`).edits,
				);
				const mid = Array.from({ length: k }, (_, i) => `E${i}`);
				const want = [...base.slice(0, pos - 1), ...mid, ...base.slice(pos)];
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
