/**
 * File of single-character lines: every op works on unit addresses.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits single-char lines file", () => {
	const base = "a\nb\nc\nd\ne\nf\ng\nh";

	it("SWAP every other", () => {
		const patch = "SWAP 1.=1:\n+A\nSWAP 3.=3:\n+C\nSWAP 5.=5:\n+E\nSWAP 7.=7:\n+G";
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text.split("\n")).toEqual(["A", "b", "C", "d", "E", "f", "G", "h"]);
	});

	it("DEL all single chars via multi-hunk", () => {
		const dels = Array.from({ length: 8 }, (_, i) => `DEL ${i + 1}`).join("\n");
		expect(applyEdits(base, parsePatch(dels).edits).text).toBe("");
	});
});
