/**
 * Multi-hunk: DEL two lines then SWAP another on original anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multi DEL then SWAP", () => {
	it("DEL 1 DEL 5 SWAP 3 on 5-line", () => {
		const text = "1\n2\n3\n4\n5";
		const { text: out } = applyEdits(
			text,
			parsePatch("DEL 1\nDEL 5\nSWAP 3.=3:\n+C").edits,
		);
		expect(out).toBe("2\nC\n4");
	});

	it("DEL range 2.=3 SWAP 1", () => {
		const text = "a\nb\nc\nd";
		const { text: out } = applyEdits(
			text,
			parsePatch("DEL 2.=3\nSWAP 1.=1:\n+A").edits,
		);
		expect(out).toBe("A\nd");
	});
});
