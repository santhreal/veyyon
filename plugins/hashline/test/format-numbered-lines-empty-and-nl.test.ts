/**
 * formatNumberedLines empty string and newline-only inputs.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLines } from "@veyyon/hashline";

describe("formatNumberedLines empty/newline", () => {
	it("empty string is 1: empty body", () => {
		expect(formatNumberedLines("")).toBe("1:");
	});

	it("single newline is two empty numbered lines", () => {
		// "" split by \n is [""] for "" and ["",""] for "\n"
		expect(formatNumberedLines("\n")).toBe("1:\n2:");
	});

	it("double newline", () => {
		expect(formatNumberedLines("\n\n")).toBe("1:\n2:\n3:");
	});

	it("content with final newline", () => {
		expect(formatNumberedLines("x\n")).toBe("1:x\n2:");
	});
});
