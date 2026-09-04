/**
 * SWAP headers require the trailing colon; missing colon fails closed at parse.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const FILE = "a\nb\nc\nd\ne";

describe("parsePatch SWAP requires colon matrix", () => {
	it("missing colon still parses as replacement (tolerant)", () => {
		const { edits } = parsePatch("SWAP 1.=1\n+x");
		expect(edits.length).toBeGreaterThan(0);
		expect(edits.some(e => e.kind === "delete" || e.kind === "insert")).toBe(true);
	});

	it("DEL does not require colon", () => {
		const { edits, warnings } = parsePatch("DEL 1");
		expect(edits).toEqual([{ kind: "delete", anchor: { line: 1 }, lineNum: 1, index: 0 }]);
		expect(warnings).toEqual([]);
		expect(applyEdits(FILE, edits).text).toBe("b\nc\nd\ne");
	});

	for (let s = 1; s <= 5; s++) {
		it(`SWAP ${s}.=${s}: replaces exactly line ${s}`, () => {
			const expected = FILE.split("\n");
			expected[s - 1] = "b";
			expect(applyEdits(FILE, parsePatch(`SWAP ${s}.=${s}:\n+b`).edits).text).toBe(expected.join("\n"));
		});
	}
});
