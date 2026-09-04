/**
 * INS.PRE / INS.POST stacking against the same and adjacent anchors.
 * All anchors address the original file in one multi-hunk patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE/POST stack matrix", () => {
	const base = "a\nb\nc\nd\ne";

	it("INS.POST same anchor stacks in hunk order", () => {
		const { text } = applyEdits(base, parsePatch("INS.POST 2:\n+x\nINS.POST 2:\n+y").edits);
		// Both after original line 2 (b); order is first then second insert
		expect(text).toBe("a\nb\nx\ny\nc\nd\ne");
	});

	it("INS.PRE same anchor stacks before original", () => {
		const { text } = applyEdits(base, parsePatch("INS.PRE 3:\n+p\nINS.PRE 3:\n+q").edits);
		expect(text).toBe("a\nb\np\nq\nc\nd\ne");
	});

	it("INS.PRE and INS.POST around same line", () => {
		const { text } = applyEdits(base, parsePatch("INS.PRE 3:\n+before\nINS.POST 3:\n+after").edits);
		expect(text).toBe("a\nb\nbefore\nc\nafter\nd\ne");
	});

	for (const line of [1, 2, 3, 4, 5]) {
		it(`INS.POST ${line} single row`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.POST ${line}:\n+X`).edits);
			const lines = text.split("\n");
			expect(lines[line]).toBe("X");
			expect(lines.filter(l => l === "X")).toHaveLength(1);
			expect(lines.length).toBe(6);
		});

		it(`INS.PRE ${line} single row`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.PRE ${line}:\n+X`).edits);
			const lines = text.split("\n");
			expect(lines[line - 1]).toBe("X");
			expect(lines[line]).toBe(base.split("\n")[line - 1]);
			expect(lines.length).toBe(6);
		});
	}

	it("INS.PRE 1 is equivalent to insert at head of non-empty", () => {
		const { text: pre } = applyEdits(base, parsePatch("INS.PRE 1:\n+H").edits);
		const { text: head } = applyEdits(base, parsePatch("INS.HEAD:\n+H").edits);
		expect(pre).toBe(head);
		expect(pre).toBe("H\na\nb\nc\nd\ne");
	});

	it("INS.POST last is not the same as INS.TAIL when no trailing nl", () => {
		const { text: post } = applyEdits(base, parsePatch("INS.POST 5:\n+T").edits);
		const { text: tail } = applyEdits(base, parsePatch("INS.TAIL:\n+T").edits);
		expect(post).toBe("a\nb\nc\nd\ne\nT");
		expect(tail).toBe("a\nb\nc\nd\ne\nT");
		expect(post).toBe(tail);
	});
});
