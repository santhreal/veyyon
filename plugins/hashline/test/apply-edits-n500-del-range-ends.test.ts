/**
 * n=500 file: DEL first 1, last 1, mid range — exact remaining counts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits n=500 DEL range ends", () => {
	const n = 500;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("DEL first", () => {
		const { text } = applyEdits(base, parsePatch("DEL 1").edits);
		expect(text.split("\n")).toHaveLength(n - 1);
		expect(text.split("\n")[0]).toBe("L2");
	});

	it("DEL last", () => {
		const { text } = applyEdits(base, parsePatch(`DEL ${n}`).edits);
		expect(text.split("\n")).toHaveLength(n - 1);
		expect(text.split("\n")[n - 2]).toBe(`L${n - 1}`);
	});

	it("DEL mid 10 lines", () => {
		const { text } = applyEdits(base, parsePatch("DEL 100.=109").edits);
		expect(text.split("\n")).toHaveLength(n - 10);
		expect(text.split("\n")[98]).toBe("L99");
		expect(text.split("\n")[99]).toBe("L110");
	});
});
