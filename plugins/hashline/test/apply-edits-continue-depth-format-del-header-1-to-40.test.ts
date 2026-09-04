/**
 * formatDeleteHeader(i) → parse → apply DEL line i for i=1..40 on n=40.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth format DEL header 1 to 40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`formatDeleteHeader(${i})`, () => {
			const h = formatDeleteHeader(i);
			const { text } = applyEdits(base, parsePatch(h).edits);
			expect(text.split("\n")).toHaveLength(n - 1);
			expect(text.split("\n")).not.toContain(`L${i}`);
		});
	}
});
