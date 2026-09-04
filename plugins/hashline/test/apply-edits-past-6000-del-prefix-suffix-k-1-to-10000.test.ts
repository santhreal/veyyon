/**
 * DEL prefix and suffix k=1..10000 on n=10000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { sweepAnchors } from "./support/anchor-sweep";

describe("applyEdits past 6000 DEL prefix suffix k 1 to 10000", () => {
	const n = 10000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (const k of sweepAnchors(n)) {
		it(`prefix ${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		});

		it(`suffix ${k}`, () => {
			const start = n - k + 1;
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${n}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		});
	}
});
