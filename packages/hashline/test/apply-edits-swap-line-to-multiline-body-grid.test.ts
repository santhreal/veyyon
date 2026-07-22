/**
 * Single-line SWAP to multi-line body: mid length equals bodyLen.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP line to multiline body grid", () => {
	const base = "a\nb\nc\nd\ne";
	for (let line = 1; line <= 5; line++) {
		for (const bodyLen of [2, 3, 5]) {
			it(`line ${line} bodyLen ${bodyLen}`, () => {
				const body = Array.from({ length: bodyLen }, (_, i) => `M${i}`);
				const rows = body.map(l => `+${l}`).join("\n");
				const { text } = applyEdits(
					base,
					parsePatch(`SWAP ${line}.=${line}:\n${rows}`).edits,
				);
				const out = text.split("\n");
				expect(out.length).toBe(5 - 1 + bodyLen);
				expect(out.slice(line - 1, line - 1 + bodyLen)).toEqual(body);
			});
		}
	}
});
