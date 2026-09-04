/**
 * DEL single vs range format: DEL n and DEL n.=n both delete one line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("parsePatch DEL range format variants", () => {
	const base = "a\nb\nc\nd";

	for (let n = 1; n <= 4; n++) {
		it(`DEL ${n} equals DEL ${n}.=${n}`, () => {
			const a = applyEdits(base, parsePatch(`DEL ${n}`).edits).text;
			const b = applyEdits(base, parsePatch(`DEL ${n}.=${n}`).edits).text;
			expect(a).toBe(b);
		});
	}

	it("DEL 2.=3 removes two lines", () => {
		expect(applyEdits(base, parsePatch("DEL 2.=3").edits).text).toBe("a\nd");
	});
});
