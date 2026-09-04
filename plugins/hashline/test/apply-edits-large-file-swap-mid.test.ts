/**
 * SWAP mid-line of a 200-line file preserves prefix and suffix counts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits large file mid SWAP", () => {
	const n = 200;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	it("SWAP line 100 to X", () => {
		const { text: out } = applyEdits(text, parsePatch("SWAP 100.=100:\n+X").edits);
		const lines = out.split("\n");
		expect(lines).toHaveLength(n);
		expect(lines[0]).toBe("L1");
		expect(lines[98]).toBe("L99");
		expect(lines[99]).toBe("X");
		expect(lines[100]).toBe("L101");
		expect(lines[n - 1]).toBe(`L${n}`);
	});

	it("DEL line 1 and last on large file", () => {
		const { text: out } = applyEdits(text, parsePatch(`DEL 1\nDEL ${n}`).edits);
		const lines = out.split("\n");
		expect(lines).toHaveLength(n - 2);
		expect(lines[0]).toBe("L2");
		expect(lines[lines.length - 1]).toBe(`L${n - 1}`);
	});

	it("INS.HEAD and INS.TAIL on large file", () => {
		const { text: out } = applyEdits(text, parsePatch("INS.HEAD:\n+H\nINS.TAIL:\n+T").edits);
		const lines = out.split("\n");
		expect(lines[0]).toBe("H");
		expect(lines[lines.length - 1]).toBe("T");
		expect(lines).toHaveLength(n + 2);
	});
});
