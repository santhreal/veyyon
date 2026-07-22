/**
 * unseenLinesMessage truncated reveal requires remainder re-read.
 */
import { describe, expect, it } from "bun:test";
import { unseenLinesMessage } from "../src/messages";

describe("unseenLinesMessage truncated reveal", () => {
	it("mentions first N and remainder", () => {
		const m = unseenLinesMessage("f.ts", [1, 2, 3, 4, 5], "DEAD", {
			lines: [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			],
			truncated: true,
		});
		expect(m).toContain("first 2 unseen");
		expect(m).toContain("  1:a");
		expect(m).toContain("  2:b");
		expect(m).toContain("remainder");
		expect(m).toContain("f.ts:1-5");
	});
});
