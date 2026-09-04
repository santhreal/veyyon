/**
 * formatNumberedLine for many N and bodies.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLine, HL_LINE_BODY_SEP } from "@veyyon/hashline";

describe("formatNumberedLine matrix", () => {
	for (const n of [1, 2, 9, 10, 99, 100, 999, 1000, 9999]) {
		it(`N=${n} empty body`, () => {
			expect(formatNumberedLine(n, "")).toBe(`${n}${HL_LINE_BODY_SEP}`);
		});
		it(`N=${n} body hello`, () => {
			expect(formatNumberedLine(n, "hello")).toBe(`${n}${HL_LINE_BODY_SEP}hello`);
		});
	}
	it("preserves body with colons and pipes", () => {
		expect(formatNumberedLine(5, "a:b|c")).toBe("5:a:b|c");
	});
	it("preserves unicode", () => {
		expect(formatNumberedLine(3, "日本語")).toBe("3:日本語");
	});
});
