/**
 * Unicode bodies through DEL/SWAP/INS: exact codepoint preservation.
 * Why: opaque body content must not be re-encoded or split on multi-byte chars.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 unicode body grid", () => {
	const samples = [
		"café",
		"日本語",
		"🚀✨",
		"Здравствуй",
		"مرحبا",
		"한글",
		"Ångström",
		"naïve",
		"🙂‍↔️",
		"a\u0301", // combining acute
	];

	it("file of unicode lines survives identity SWAP", () => {
		const base = samples.join("\n");
		const hunks = samples.map((s, i) => `SWAP ${i + 1}.=${i + 1}:\n+${s}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text).toBe(base);
	});

	it("DEL each unicode line leaves the others exact", () => {
		const base = samples.join("\n");
		for (let i = 1; i <= samples.length; i++) {
			const { text } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			const expected = samples.filter((_, j) => j + 1 !== i);
			expect(text === "" ? [] : text.split("\n")).toEqual(expected);
		}
	});

	it("INS.HEAD unicode rows prefix exact", () => {
		const base = "plain";
		const rows = samples.map(s => `+${s}`).join("\n");
		const { text } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
		expect(text.split("\n")).toEqual([...samples, "plain"]);
	});

	it("SWAP first line to each unicode sample", () => {
		const base = "old\nkeep";
		for (const s of samples) {
			const { text } = applyEdits(base, parsePatch(`SWAP 1.=1:\n+${s}`).edits);
			expect(text).toBe(`${s}\nkeep`);
		}
	});
});
