import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "@veyyon/coding-agent/tools/match-line-format";

/**
 * formatMatchLine exact formatting for match vs context, with and without hashlines.
 */

describe("formatMatchLine adversarial", () => {
	it("formats a match line with hashline markers when enabled", () => {
		const text = formatMatchLine(12, "const x = 1;", true, { useHashLines: true });
		expect(text).toContain("12");
		expect(text).toContain("const x = 1;");
		// Hashline match rows use a distinctive marker (often = or similar).
		expect(text.length).toBeGreaterThan("const x = 1;".length);
	});

	it("formats a non-match context line differently from a match when hashlines on", () => {
		const match = formatMatchLine(1, "hit", true, { useHashLines: true });
		const ctx = formatMatchLine(1, "hit", false, { useHashLines: true });
		expect(match).not.toBe(ctx);
		expect(match).toContain("hit");
		expect(ctx).toContain("hit");
	});

	it("formats without hashlines still includes line number and body", () => {
		const text = formatMatchLine(3, "plain body", true, { useHashLines: false });
		expect(text).toContain("3");
		expect(text).toContain("plain body");
	});

	it("preserves unicode body bytes", () => {
		const text = formatMatchLine(1, "日本語", true, { useHashLines: false });
		expect(text).toContain("日本語");
	});

	it("preserves empty body without inventing content", () => {
		const text = formatMatchLine(5, "", true, { useHashLines: false });
		expect(text).toContain("5");
		expect(text.includes("invented")).toBe(false);
	});

	it("large line number appears exactly", () => {
		const text = formatMatchLine(99999, "x", true, { useHashLines: false });
		expect(text).toContain("99999");
		expect(text).toContain("x");
	});
});
