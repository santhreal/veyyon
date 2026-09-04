/**
 * Sequential INS.HEAD then DEL all original lines leaving only head inserts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits HEAD then strip original", () => {
	it("HEAD then DEL remaining body lines", () => {
		const t1 = applyEdits("a\nb", parsePatch("INS.HEAD:\n+H1\n+H2").edits).text;
		expect(t1).toBe("H1\nH2\na\nb");
		const t2 = applyEdits(t1, parsePatch("DEL 3\nDEL 4").edits).text;
		expect(t2).toBe("H1\nH2");
	});
});
