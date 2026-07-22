/**
 * Bodies that look like JSON/code/headers stay opaque through SWAP/INS/DEL.
 * Why: content must never be re-parsed as ops when living in payload rows.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const opaque = [
	'{"a":1}',
	"DEL 1",
	"SWAP 1.=1:",
	"INS.HEAD:",
	"+not-an-op",
	"function f() { return 1; }",
	"// comment",
	"# hashline",
	"[path/to/file.ts#ABCD]",
	"  leading spaces",
];

describe("applyEdits past 6000 json and code body opaque", () => {
	it("identity multi-SWAP of opaque file", () => {
		const base = opaque.join("\n");
		const hunks = opaque
			.map((line, i) => `SWAP ${i + 1}.=${i + 1}:\n+${line}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text).toBe(base);
	});

	it("HEAD inserts keyword-like rows as content", () => {
		const rows = opaque.map((l) => `+${l}`).join("\n");
		const { text } = applyEdits("Z", parsePatch(`INS.HEAD:\n${rows}`).edits);
		expect(text.split("\n")).toEqual([...opaque, "Z"]);
	});

	for (const [i, line] of opaque.entries()) {
		it(`SWAP sole line to opaque #${i}`, () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${line}`).edits);
			expect(text).toBe(line);
		});
	}

	it("DEL removes keyword-looking line without treating as op", () => {
		const base = "keep\nDEL 1\nkeep2";
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe("keep\nkeep2");
	});
});
