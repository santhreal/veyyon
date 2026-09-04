import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Line-count properties after SWAP/DEL/INS.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function lineCount(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits line-count property", () => {
	it("single-line SWAP preserves line count", () => {
		for (let n = 1; n <= 20; n++) {
			const src = text(Array.from({ length: n }, (_, i) => `L${i}`));
			for (let k = 1; k <= n; k++) {
				const out = apply(src, `SWAP ${k}.=${k}:\n+X`);
				expect(lineCount(out)).toBe(n);
			}
		}
	});

	it("DEL N.=N reduces line count by 1", () => {
		for (let n = 1; n <= 15; n++) {
			const src = text(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = apply(src, "DEL 1.=1");
			expect(lineCount(out)).toBe(n - 1);
		}
	});

	it("INS.TAIL with one line increases count by 1", () => {
		for (let n = 0; n <= 10; n++) {
			const src = n === 0 ? "" : text(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = apply(src || "\n", "INS.TAIL:\n+X");
			// empty edge may differ; for n>=1 exact
			if (n >= 1) {
				expect(lineCount(out)).toBe(n + 1);
			}
		}
	});
});
