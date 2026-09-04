/**
 * DEL single and range grid: every start/end pair on an n-line file yields
 * exact remaining lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL range grid property", () => {
	for (const n of [4, 7, 11]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");

		for (let start = 1; start <= n; start++) {
			for (let end = start; end <= n; end++) {
				it(`n=${n} DEL ${start}.=${end}`, () => {
					const header = formatDeleteHeader(start, end);
					const { text } = applyEdits(base, parsePatch(header).edits);
					const want = lines.filter((_, i) => i + 1 < start || i + 1 > end);
					expect(text.split("\n")).toEqual(want.length === 0 ? [""] : want);
					// empty file: apply may return "" not [""]
					if (want.length === 0) {
						expect(text === "" || text === "").toBe(true);
					} else {
						expect(text).toBe(want.join("\n"));
					}
				});
			}
		}
	}
});
