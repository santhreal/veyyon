/**
 * DEL every inclusive subrange of a 4-line file: exact remaining text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

function lines4(): string {
	return "1\n2\n3\n4";
}

describe("applyEdits DEL subrange permutations on 4 lines", () => {
	const n = 4;
	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= n; end++) {
			it(`DEL ${start}.=${end} leaves complement lines`, () => {
				const header = formatDeleteHeader(start, end);
				const { text } = applyEdits(lines4(), parsePatch(header).edits);
				const want = Array.from({ length: n }, (_, i) => String(i + 1)).filter(
					(_, i) => i + 1 < start || i + 1 > end,
				);
				expect(text).toBe(want.join("\n"));
			});
		}
	}
});
