/**
 * Multi-hunk applyEdits: anchors are against original file; order independence for disjoint ops.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multi-hunk disjoint", () => {
	it("DEL first and last lines of 5-line file", () => {
		const text = "1\n2\n3\n4\n5";
		const { text: out } = applyEdits(text, parsePatch("DEL 1\nDEL 5").edits);
		expect(out).toBe("2\n3\n4");
	});

	it("SWAP two non-adjacent lines", () => {
		const text = "a\nb\nc\nd";
		const { text: out } = applyEdits(text, parsePatch("SWAP 1.=1:\n+A\nSWAP 3.=3:\n+C").edits);
		expect(out).toBe("A\nb\nC\nd");
	});

	it("DEL range then INS.HEAD on original anchors", () => {
		const text = "a\nb\nc\nd";
		const { text: out } = applyEdits(text, parsePatch("DEL 2.=3\nINS.HEAD:\n+H").edits);
		expect(out).toBe("H\na\nd");
	});

	it("INS.POST middle and SWAP later line", () => {
		const text = "a\nb\nc";
		const { text: out } = applyEdits(text, parsePatch("INS.POST 1:\n+X\nSWAP 3.=3:\n+C").edits);
		// anchors original: insert after line1, replace line3
		expect(out.split("\n")).toContain("a");
		expect(out.split("\n")).toContain("X");
		expect(out.split("\n")).toContain("C");
		expect(out.split("\n")).not.toContain("c");
	});

	it("three sequential single-line swaps on disjoint lines", () => {
		const text = "L1\nL2\nL3\nL4\nL5";
		const { text: out } = applyEdits(text, parsePatch("SWAP 1.=1:\n+A\nSWAP 3.=3:\n+C\nSWAP 5.=5:\n+E").edits);
		expect(out).toBe("A\nL2\nC\nL4\nE");
	});

	it("INS.TAIL multi lines then DEL first", () => {
		const text = "only";
		const { text: out } = applyEdits(text, parsePatch("INS.TAIL:\n+T1\n+T2\nDEL 1").edits);
		expect(out).toBe("T1\nT2");
	});
});
