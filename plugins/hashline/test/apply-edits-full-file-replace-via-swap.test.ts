/**
 * SWAP 1.=n replaces entire n-line file with arbitrary body length.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits full file replace via SWAP", () => {
	for (const n of [1, 3, 5, 10]) {
		for (const bodyLen of [0, 1, 3, n, n + 2]) {
			if (bodyLen === 0) {
				it(`n=${n} DEL 1.=${n} clears`, () => {
					const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
					const { text } = applyEdits(base, parsePatch(n === 1 ? "DEL 1" : `DEL 1.=${n}`).edits);
					expect(text).toBe("");
				});
				continue;
			}
			it(`n=${n} SWAP full bodyLen=${bodyLen}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
				const body = Array.from({ length: bodyLen }, (_, i) => `B${i}`);
				const rows = body.map(l => `+${l}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`SWAP 1.=${n}:\n${rows}`).edits);
				expect(text).toBe(body.join("\n"));
			});
		}
	}
});
