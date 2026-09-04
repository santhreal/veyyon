import { describe, expect, it } from "bun:test";
import { formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";

/**
 * formatNumberedLine with unicode bodies.
 */

describe("formatNumberedLine unicode", () => {
	it("embeds unicode bodies after the colon", () => {
		expect(formatNumberedLine(1, "日本語")).toBe("1:日本語");
		expect(formatNumberedLine(2, "🙂")).toBe("2:🙂");
		expect(formatNumberedLine(10, "café")).toBe("10:café");
	});

	it("formatNumberedLines with unicode multi-line", () => {
		const out = formatNumberedLines("日\n本\n", 5);
		expect(out).toContain("5:日");
		expect(out).toContain("6:本");
	});
});
