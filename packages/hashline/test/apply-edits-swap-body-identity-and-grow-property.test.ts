/**
 * SWAP body identity (same content) is still a valid apply (content-equal
 * replacement); grow/shrink by fixed deltas across a grid of ranges.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP identity and grow property", () => {
	const lines = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= 6; start++) {
		for (let end = start; end <= start + 2; end++) {
			it(`identity SWAP ${start}.=${end}`, () => {
				const body = lines.slice(start - 1, end);
				const bodyRows = body.map(l => `+${l}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n${bodyRows}`).edits);
				expect(text).toBe(base);
			});

			it(`grow +2 SWAP ${start}.=${end}`, () => {
				const span = end - start + 1;
				const body = Array.from({ length: span + 2 }, (_, i) => `G${i}`);
				const bodyRows = body.map(l => `+${l}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n${bodyRows}`).edits);
				const out = text.split("\n");
				expect(out.length).toBe(12 + 2);
				expect(out.slice(0, start - 1)).toEqual(lines.slice(0, start - 1));
				expect(out.slice(start - 1, start - 1 + body.length)).toEqual(body);
				expect(out.slice(start - 1 + body.length)).toEqual(lines.slice(end));
			});
		}
	}
});
