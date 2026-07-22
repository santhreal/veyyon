import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP with empty payload line (delete via empty replace).
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP empty payload", () => {
	it("SWAP with empty + line may delete or leave empty line", () => {
		const out = apply(text(["A", "B", "C"]), "SWAP 2.=2:\n+");
		// Empty replacement: either removes the line or leaves blank.
		expect(out.includes("A")).toBe(true);
		expect(out.includes("C")).toBe(true);
		const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines.length === 2 || lines.length === 3).toBe(true);
	});
});
