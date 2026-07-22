/**
 * n=1000 file: INS.HEAD and INS.TAIL sandwich without touching middle.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits n=1000 INS HEAD TAIL sandwich", () => {
	it("HEAD and TAIL in one patch", () => {
		const n = 1000;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const { text } = applyEdits(
			base,
			parsePatch("INS.HEAD:\n+HEAD\nINS.TAIL:\n+TAIL").edits,
		);
		const out = text.split("\n");
		expect(out).toHaveLength(n + 2);
		expect(out[0]).toBe("HEAD");
		expect(out[out.length - 1]).toBe("TAIL");
		expect(out.slice(1, -1)).toEqual(lines);
	});
});
