/**
 * Every formatInsertHeader cursor form round-trips through parsePatch + applyEdits.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("formatInsertHeader apply matrix", () => {
	it("before_anchor inserts before the line", () => {
		const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: 2 } });
		const { text } = applyEdits("a\nb\nc", parsePatch(`${h}\n+X`).edits);
		expect(text).toBe("a\nX\nb\nc");
	});

	it("after_anchor inserts after the line", () => {
		const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: 2 } });
		const { text } = applyEdits("a\nb\nc", parsePatch(`${h}\n+X`).edits);
		expect(text).toBe("a\nb\nX\nc");
	});

	it("bof inserts at head", () => {
		const h = formatInsertHeader({ kind: "bof" });
		const { text } = applyEdits("body", parsePatch(`${h}\n+H`).edits);
		expect(text).toBe("H\nbody");
	});

	it("eof inserts at tail", () => {
		const h = formatInsertHeader({ kind: "eof" });
		const { text } = applyEdits("body", parsePatch(`${h}\n+T`).edits);
		expect(text).toBe("body\nT");
	});

	it("multi-row insert after middle", () => {
		const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: 1 } });
		const { text } = applyEdits("a\nz", parsePatch(`${h}\n+1\n+2\n+3`).edits);
		expect(text).toBe("a\n1\n2\n3\nz");
	});
});
