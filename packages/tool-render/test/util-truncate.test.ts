import { describe, expect, it } from "bun:test";
import { argsDigest, truncate } from "../src/util";

// tool-render's `truncate` used to be a local implementation that sliced by
// UTF-16 code unit (splitting emoji/astral chars into a lone surrogate) and
// appended the ellipsis past the budget (result up to maxLen+1). It now
// delegates to the single owner in @veyyon/utils/format. These tests lock the
// corrected contract so a naive local copy cannot creep back.

describe("truncate — delegates to the code-point-safe owner", () => {
	it("returns the string unchanged when it fits", () => {
		expect(truncate("short", 100)).toBe("short");
		expect(truncate("", 100)).toBe("");
	});

	it("defaults maxLen to 100 (the historical tool-render default)", () => {
		const s = "x".repeat(150);
		const out = truncate(s);
		expect([...out]).toHaveLength(100);
		expect(out.endsWith("…")).toBe(true);
	});

	it("reserves the ellipsis width so the result never exceeds maxLen code points", () => {
		const out = truncate("abcdefghij", 5);
		expect([...out]).toHaveLength(5);
		expect(out).toBe("abcd…");
	});

	it("never splits an astral character into a lone surrogate", () => {
		// Ten emoji; each is a surrogate pair (2 UTF-16 code units). A code-unit
		// slice at an odd boundary would emit a lone surrogate; the owner cuts by
		// code point so every retained emoji stays intact.
		const emoji = "😀".repeat(10);
		const out = truncate(emoji, 5);
		expect([...out]).toHaveLength(5);
		// Four whole emoji plus the ellipsis, no replacement char.
		expect(out).toBe("😀😀😀😀…");
		expect(out).not.toContain("�");
	});

	it("argsDigest routes its summary through the same truncation", () => {
		const digest = argsDigest({ path: "z".repeat(200) }, 20);
		expect([...digest].length).toBeLessThanOrEqual(20);
		expect(digest.endsWith("…")).toBe(true);
	});
});
