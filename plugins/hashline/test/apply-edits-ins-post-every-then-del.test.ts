/**
 * Sequential: INS.POST after each line then DEL the inserted markers by new anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential INS.POST then cleanup", () => {
	it("insert X after line 1 then delete X", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("INS.POST 1:\n+X").edits).text;
		expect(t1).toBe("a\nX\nb\nc");
		const t2 = applyEdits(t1, parsePatch("DEL 2").edits).text;
		expect(t2).toBe("a\nb\nc");
	});

	it("insert at each position of 3-line file sequentially", () => {
		let text = "a\nb\nc";
		// after each insert, file grows; insert at end each time via INS.TAIL
		for (const mark of ["1", "2", "3"]) {
			text = applyEdits(text, parsePatch(`INS.TAIL:\n+${mark}`).edits).text;
		}
		expect(text).toBe("a\nb\nc\n1\n2\n3");
	});

	it("PRE 1 stack three times", () => {
		let text = "body";
		for (const mark of ["A", "B", "C"]) {
			text = applyEdits(text, parsePatch(`INS.PRE 1:\n+${mark}`).edits).text;
		}
		// each PRE 1 inserts before current first line
		expect(text).toBe("C\nB\nA\nbody");
	});
});
