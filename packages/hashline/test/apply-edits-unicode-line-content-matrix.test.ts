/**
 * applyEdits with unicode line bodies: SWAP/DEL/INS preserve surrounding
 * lines and treat unicode as opaque string content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const UNICODES = ["☃", "日本語", "é", "🚀", "a\u0301", "零"];

describe("applyEdits unicode content matrix", () => {
	for (const u of UNICODES) {
		it(`SWAP mid with ${JSON.stringify(u)}`, () => {
			const base = `a\n${u}\nc`;
			const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+X").edits);
			expect(text).toBe("a\nX\nc");
		});

		it(`DEL unicode line ${JSON.stringify(u)}`, () => {
			const base = `a\n${u}\nc`;
			const { text } = applyEdits(base, parsePatch("DEL 2").edits);
			expect(text).toBe("a\nc");
		});

		it(`INS body ${JSON.stringify(u)}`, () => {
			const base = "a\nb";
			const { text } = applyEdits(base, parsePatch(`INS.POST 1:\n+${u}`).edits);
			expect(text).toBe(`a\n${u}\nb`);
		});
	}

	it("multi-line unicode file full replace", () => {
		const base = UNICODES.join("\n");
		const body = UNICODES.map(u => `+${u}${u}`).join("\n");
		const { text } = applyEdits(base, parsePatch(`SWAP 1.=${UNICODES.length}:\n${body}`).edits);
		expect(text).toBe(UNICODES.map(u => `${u}${u}`).join("\n"));
	});
});
