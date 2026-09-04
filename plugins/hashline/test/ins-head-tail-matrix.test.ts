import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.HEAD / INS.TAIL multi-line body matrix.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.HEAD / INS.TAIL multi-line matrix", () => {
	it("INS.HEAD with k lines prepends k lines for k=1..5", () => {
		const src = text(["body"]);
		for (let k = 1; k <= 5; k++) {
			const body = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
			const out = apply(src, `INS.HEAD:\n${body}`);
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines).toHaveLength(1 + k);
			expect(lines[lines.length - 1]).toBe("body");
			for (let i = 0; i < k; i++) {
				expect(lines[i]).toBe(`H${i}`);
			}
		}
	});

	it("INS.TAIL with k lines appends k lines for k=1..5", () => {
		const src = text(["body"]);
		for (let k = 1; k <= 5; k++) {
			const body = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
			const out = apply(src, `INS.TAIL:\n${body}`);
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines[0]).toBe("body");
			expect(lines).toHaveLength(1 + k);
			for (let i = 0; i < k; i++) {
				expect(lines[1 + i]).toBe(`T${i}`);
			}
		}
	});

	it("HEAD then TAIL on empty-ish file", () => {
		const src = text(["mid"]);
		const out = apply(src, "INS.HEAD:\n+H\nINS.TAIL:\n+T");
		expect(out).toContain("H");
		expect(out).toContain("mid");
		expect(out).toContain("T");
	});
});
