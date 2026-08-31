/**
 * Two disjoint SWAPs in one parse on a 6-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits double disjoint SWAP", () => {
	const text = "1\n2\n3\n4\n5\n6";

	it("SWAP 1 and 6", () => {
		const { text: out } = applyEdits(text, parsePatch("SWAP 1.=1:\n+A\nSWAP 6.=6:\n+F").edits);
		expect(out).toBe("A\n2\n3\n4\n5\nF");
	});

	it("SWAP 2 and 5", () => {
		const { text: out } = applyEdits(text, parsePatch("SWAP 2.=2:\n+B\nSWAP 5.=5:\n+E").edits);
		expect(out).toBe("1\nB\n3\n4\nE\n6");
	});

	it("SWAP 3 and 4", () => {
		const { text: out } = applyEdits(text, parsePatch("SWAP 3.=3:\n+C\nSWAP 4.=4:\n+D").edits);
		expect(out).toBe("1\n2\nC\nD\n5\n6");
	});
});
