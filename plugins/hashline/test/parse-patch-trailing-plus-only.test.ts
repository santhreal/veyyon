import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP with a lone + empty body line.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("parsePatch trailing plus only", () => {
	it("SWAP with lone + produces edits without throw", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+");
		expect(edits.length).toBeGreaterThan(0);
		const out = applyEdits(text(["X"]), edits).text;
		expect(typeof out).toBe("string");
	});
});
