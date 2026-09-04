/**
 * At each position of a 4-line file, expand that line to k=1..4 replacement lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each position of 4-line file", () => {
	const base = ["a", "b", "c", "d"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 4; pos++) {
		for (let k = 1; k <= 4; k++) {
			it(`pos=${pos} k=${k}`, () => {
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const h = formatReplaceHeader(pos, pos);
				const { text: out } = applyEdits(text, parsePatch(`${h}\n${body}`).edits);
				const mid = Array.from({ length: k }, (_, i) => `E${i}`);
				const want = [...base.slice(0, pos - 1), ...mid, ...base.slice(pos)];
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
