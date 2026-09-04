/**
 * Multi-hunk: expand then delete expanded region using original anchors only (single applyEdits).
 * Sequential applyEdits for second step after first result.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential expand then del", () => {
	it("expand line 2 then delete the expanded block via new parse", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 2.=2:\n+B1\n+B2\n+B3").edits).text;
		expect(t1).toBe("a\nB1\nB2\nB3\nc");
		const t2 = applyEdits(t1, parsePatch("DEL 2.=4").edits).text;
		expect(t2).toBe("a\nc");
	});

	it("INS.HEAD then DEL original first line", () => {
		const t0 = "a\nb";
		const t1 = applyEdits(t0, parsePatch("INS.HEAD:\n+H").edits).text;
		expect(t1).toBe("H\na\nb");
		// now DEL 2 is 'a'
		const t2 = applyEdits(t1, parsePatch("DEL 2").edits).text;
		expect(t2).toBe("H\nb");
	});
});
