/**
 * SWAP expand first and last lines of N-line files for k new lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP expand first/last", () => {
	for (const n of [2, 4, 6]) {
		for (const k of [2, 3]) {
			it(`n=${n} expand first to k=${k}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const { text } = applyEdits(base.join("\n"), parsePatch(`SWAP 1.=1:\n${body}`).edits);
				const mid = Array.from({ length: k }, (_, i) => `E${i}`);
				expect(text).toBe([...mid, ...base.slice(1)].join("\n"));
			});
			it(`n=${n} expand last to k=${k}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const { text } = applyEdits(base.join("\n"), parsePatch(`SWAP ${n}.=${n}:\n${body}`).edits);
				const mid = Array.from({ length: k }, (_, i) => `E${i}`);
				expect(text).toBe([...base.slice(0, -1), ...mid].join("\n"));
			});
		}
	}
});
