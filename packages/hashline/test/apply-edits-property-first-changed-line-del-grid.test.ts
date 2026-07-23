/**
 * firstChangedLine for DEL equals the deleted start line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits firstChangedLine DEL grid", () => {
	const n = 12;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let start = 1; start <= n; start++) {
		for (const end of [start, Math.min(start + 2, n)]) {
			it(`DEL ${start}.=${end}`, () => {
				const r = applyEdits(base, parsePatch(formatDeleteHeader(start, end)).edits);
				expect(r.firstChangedLine).toBe(start);
			});
		}
	}
});
