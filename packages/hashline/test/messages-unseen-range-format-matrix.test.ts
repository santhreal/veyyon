/**
 * unseenLinesMessage range compression matrix: exact range strings in re-read selectors.
 */
import { describe, expect, it } from "bun:test";
import { unseenLinesMessage } from "../src/messages";

describe("unseenLinesMessage range compression", () => {
	const cases: Array<{ lines: number[]; ranges: string; selector: string }> = [
		{ lines: [1], ranges: "1", selector: "1" },
		{ lines: [1, 2, 3], ranges: "1-3", selector: "1-3" },
		{ lines: [1, 3], ranges: "1, 3", selector: "1,3" },
		{ lines: [5, 6, 7, 10], ranges: "5-7, 10", selector: "5-7,10" },
		{ lines: [10, 1, 2, 1], ranges: "1-2, 10", selector: "1-2,10" },
		{ lines: [100, 101, 102, 200, 201], ranges: "100-102, 200-201", selector: "100-102,200-201" },
	];

	for (const c of cases) {
		it(`lines ${JSON.stringify(c.lines)} -> ranges ${c.ranges}`, () => {
			const msg = unseenLinesMessage("f.ts", c.lines, "ABCD");
			expect(msg).toContain(`lines ${c.ranges}`);
			expect(msg).toContain(`f.ts:${c.selector}`);
		});
	}

	it("reveal path includes exact numbered preview lines", () => {
		const msg = unseenLinesMessage("p.ts", [3, 4], "CAFE", {
			lines: [
				{ line: 3, text: "aaa" },
				{ line: 4, text: "bbb" },
			],
			truncated: false,
		});
		expect(msg).toContain("  3:aaa");
		expect(msg).toContain("  4:bbb");
		expect(msg).toContain("straight retry");
	});
});
