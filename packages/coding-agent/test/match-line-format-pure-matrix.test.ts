/**
 * formatMatchLine pure matrix: plain vs hashline, match vs context.
 */
import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "../src/tools/match-line-format";

describe("formatMatchLine pure matrix", () => {
	it("plain match", () => {
		expect(formatMatchLine(12, "const x = 1;", true, { useHashLines: false })).toBe(
			"*12|const x = 1;",
		);
	});
	it("plain context", () => {
		expect(formatMatchLine(13, "return x;", false, { useHashLines: false })).toBe(" 13|return x;");
	});
	it("hashline match", () => {
		expect(formatMatchLine(1, "export {}", true, { useHashLines: true })).toBe("*1:export {}");
	});
	it("hashline context", () => {
		expect(formatMatchLine(42, "ctx", false, { useHashLines: true })).toBe(" 42:ctx");
	});
	it("no pad large line", () => {
		expect(formatMatchLine(1000, "a", true, { useHashLines: false })).toBe("*1000|a");
	});
	it("empty body plain match", () => {
		expect(formatMatchLine(5, "", true, { useHashLines: false })).toBe("*5|");
	});
	it("empty body hashline context", () => {
		expect(formatMatchLine(5, "", false, { useHashLines: true })).toBe(" 5:");
	});
	it("unicode body", () => {
		expect(formatMatchLine(3, "  日本語", true, { useHashLines: true })).toBe("*3:  日本語");
	});
	it("pipe in body hashline", () => {
		expect(formatMatchLine(7, "a|b|c", true, { useHashLines: true })).toBe("*7:a|b|c");
	});
	it("colon in body plain", () => {
		expect(formatMatchLine(8, "a:b:c", false, { useHashLines: false })).toBe(" 8|a:b:c");
	});
});
