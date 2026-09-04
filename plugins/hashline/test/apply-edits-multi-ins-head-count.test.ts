/**
 * INS.HEAD with k body rows for k=1..10 produces exact prefix length.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD count matrix", () => {
	for (let k = 1; k <= 10; k++) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
			const { text } = applyEdits("TAIL", parsePatch(`INS.HEAD:\n${body}`).edits);
			const lines = text.split("\n");
			expect(lines).toHaveLength(k + 1);
			expect(lines[lines.length - 1]).toBe("TAIL");
			for (let i = 0; i < k; i++) expect(lines[i]).toBe(`H${i}`);
		});
	}
});

describe("applyEdits INS.TAIL count matrix", () => {
	for (let k = 1; k <= 10; k++) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
			const { text } = applyEdits("HEAD", parsePatch(`INS.TAIL:\n${body}`).edits);
			const lines = text.split("\n");
			expect(lines).toHaveLength(k + 1);
			expect(lines[0]).toBe("HEAD");
			for (let i = 0; i < k; i++) expect(lines[i + 1]).toBe(`T${i}`);
		});
	}
});
