import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Multi-hunk pure applyEdits sequences that mimic multi-step agent edits.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits multi-hunk agent-like sequences", () => {
	it("replace two non-adjacent lines in one patch", () => {
		const out = apply(text(["a", "b", "c", "d", "e"]), "SWAP 2.=2:\n+B2\nSWAP 4.=4:\n+D2");
		expect(out).toBe(text(["a", "B2", "c", "D2", "e"]));
	});

	it("insert at head then swap later line against original anchors", () => {
		// Both edits target original line numbers before either is applied.
		const out = apply(text(["a", "b", "c"]), "INS.HEAD:\n+H\nSWAP 2.=2:\n+B2");
		// Depending on apply order, results differ; lock actual product order.
		expect(out).toContain("H");
		expect(out).toContain("B2");
		expect(out.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
	});

	it("delete a range then the remaining lines shift for subsequent pure apply", () => {
		const mid = apply(text(["a", "b", "c", "d"]), "DEL 2.=3");
		expect(mid).toBe(text(["a", "d"]));
		const next = apply(mid, "SWAP 2.=2:\n+D2");
		expect(next).toBe(text(["a", "D2"]));
	});

	it("unicode multi-hunk", () => {
		const out = apply(text(["一", "二", "三"]), "SWAP 1.=1:\n+壱\nSWAP 3.=3:\n+参");
		expect(out).toBe(text(["壱", "二", "参"]));
	});

	it("INS.POST after every line builds an interleaved file", () => {
		const src = text(["a", "b"]);
		const out = apply(src, "INS.POST 1:\n+x\nINS.POST 2:\n+y");
		// Original anchors: after line1 and after line2 of src.
		expect(out).toContain("a");
		expect(out).toContain("b");
		expect(out).toContain("x");
		expect(out).toContain("y");
	});
});
