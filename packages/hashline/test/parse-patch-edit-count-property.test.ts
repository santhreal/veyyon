import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

/**
 * parsePatch edit counts: SWAP expands to insert+delete pair.
 */

describe("parsePatch edit count property", () => {
	it("each SWAP expands to 2 edits (insert+delete)", () => {
		for (let n = 1; n <= 10; n++) {
			const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+X${i}`).join("\n");
			const { edits } = parsePatch(hunks);
			expect(edits.length).toBe(n * 2);
		}
	});

	it("each DEL is a single delete edit", () => {
		for (let n = 1; n <= 8; n++) {
			const hunks = Array.from({ length: n }, (_, i) => `DEL ${i + 1}.=${i + 1}`).join("\n");
			const { edits } = parsePatch(hunks);
			expect(edits.length).toBe(n);
		}
	});

	it("INS alone is a single insert edit", () => {
		expect(parsePatch("INS.HEAD:\n+H").edits.length).toBe(1);
		expect(parsePatch("INS.TAIL:\n+T").edits.length).toBe(1);
	});

	it("mixed INS+SWAP+INS counts as 1+2+1 edits", () => {
		const { edits } = parsePatch("INS.HEAD:\n+H\nSWAP 1.=1:\n+A\nINS.TAIL:\n+T");
		expect(edits.length).toBe(4);
	});
});
