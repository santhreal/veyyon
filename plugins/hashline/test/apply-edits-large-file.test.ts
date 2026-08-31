import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits on larger synthetic files (hundreds of lines).
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits large file", () => {
	it("SWAP middle line of 500-line file", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `L${i + 1}`);
		const src = text(lines);
		const out = apply(src, "SWAP 250.=250:\n+MID");
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toHaveLength(500);
		expect(result[249]).toBe("MID");
		expect(result[0]).toBe("L1");
		expect(result[499]).toBe("L500");
	});

	it("DEL first 10 lines of 100-line file", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
		const src = text(lines);
		const out = apply(src, "DEL 1.=10");
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toHaveLength(90);
		expect(result[0]).toBe("L11");
	});

	it("INS.HEAD on 200-line file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
		const src = text(lines);
		const out = apply(src, "INS.HEAD:\n+HEAD");
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toHaveLength(201);
		expect(result[0]).toBe("HEAD");
	});
});
