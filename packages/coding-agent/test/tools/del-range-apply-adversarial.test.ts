import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * DEL range apply for many start/end pairs on a fixed 10-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(Array.from({ length: 10 }, (_, i) => `L${i + 1}`));

describe("DEL range apply adversarial", () => {
	it("DEL N.=N removes exactly that line for N=1..10", () => {
		for (let n = 1; n <= 10; n++) {
			const out = applyEdits(SRC, parsePatch(`DEL ${n}.=${n}`).edits).text;
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines).not.toContain(`L${n}`);
			expect(lines).toHaveLength(9);
		}
	});

	it("DEL 1.=10 empties the file content", () => {
		const out = applyEdits(SRC, parsePatch("DEL 1.=10").edits).text;
		expect(out === "" || out === "\n").toBe(true);
	});

	it("DEL 3.=5 removes the middle block", () => {
		const out = applyEdits(SRC, parsePatch("DEL 3.=5").edits).text;
		expect(out).toBe(text(["L1", "L2", "L6", "L7", "L8", "L9", "L10"]));
	});
});
