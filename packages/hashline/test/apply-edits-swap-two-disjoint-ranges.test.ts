/**
 * Two disjoint range SWAPs in one multi-hunk on 8-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits two disjoint range SWAPs", () => {
	const text = "1\n2\n3\n4\n5\n6\n7\n8";

	it("SWAP 1.=2 and 7.=8", () => {
		const { text: out } = applyEdits(
			text,
			parsePatch("SWAP 1.=2:\n+A\nSWAP 7.=8:\n+B").edits,
		);
		expect(out).toBe("A\n3\n4\n5\n6\nB");
	});

	it("SWAP 2.=3 and 5.=6", () => {
		const { text: out } = applyEdits(
			text,
			parsePatch("SWAP 2.=3:\n+X\nSWAP 5.=6:\n+Y").edits,
		);
		expect(out).toBe("1\nX\n4\nY\n7\n8");
	});
});
