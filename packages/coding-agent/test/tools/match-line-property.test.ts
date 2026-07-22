import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "@veyyon/coding-agent/tools/match-line-format";

/**
 * formatMatchLine property: marker, line number, and body always present.
 */

describe("formatMatchLine property-style", () => {
	it("every line number 1..100 appears in both match and context forms", () => {
		for (let n = 1; n <= 100; n++) {
			const match = formatMatchLine(n, "body", true, { useHashLines: false });
			const ctx = formatMatchLine(n, "body", false, { useHashLines: false });
			expect(match).toContain(String(n));
			expect(ctx).toContain(String(n));
			expect(match).toContain("body");
			expect(ctx).toContain("body");
			expect(match.startsWith("*")).toBe(true);
			expect(ctx.startsWith(" ")).toBe(true);
			expect(match).not.toBe(ctx);
		}
	});

	it("hashline mode uses colon separator and plain mode uses pipe", () => {
		const hl = formatMatchLine(7, "x", true, { useHashLines: true });
		const plain = formatMatchLine(7, "x", true, { useHashLines: false });
		expect(hl).toContain("7:");
		expect(plain).toContain("7|");
		expect(hl).toBe("*7:x");
		expect(plain).toBe("*7|x");
	});

	it("empty body still includes the line number and marker", () => {
		const m = formatMatchLine(3, "", true, { useHashLines: false });
		expect(m).toBe("*3|");
		const c = formatMatchLine(3, "", false, { useHashLines: true });
		expect(c).toBe(" 3:");
	});
});
