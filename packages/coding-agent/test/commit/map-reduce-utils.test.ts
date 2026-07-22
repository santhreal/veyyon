import { describe, expect, it } from "bun:test";
import { estimateTokens, MAX_FILE_TOKENS, truncateToTokenLimit } from "@veyyon/coding-agent/commit/map-reduce/utils";

/**
 * The commit map-reduce per-file budget helpers had no tests. `estimateTokens`
 * is the byte-aware (~4-bytes-per-token) fallback estimate, and
 * `truncateToTokenLimit` clips an oversized file diff so the map phase stays
 * under budget. The boundary math matters: a naive `length/4` char slice would
 * keep ~3x too much CJK text (3 UTF-8 bytes per char) and overflow the model's
 * context. These tests pin the exact estimates and the byte-aware truncation so
 * that regression cannot silently reintroduce the char-based overshoot.
 */

describe("estimateTokens", () => {
	it("returns 0 for empty text", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates ASCII as ceil(bytes/4) since one ASCII char is one byte", () => {
		expect(estimateTokens("abcd")).toBe(1); // 4 bytes -> 1
		expect(estimateTokens("abcde")).toBe(2); // 5 bytes -> ceil(5/4) = 2
		expect(estimateTokens("a".repeat(400))).toBe(100); // 400 bytes -> 100
	});

	it("counts CJK by its UTF-8 byte weight, not its character count", () => {
		// "中" is 3 UTF-8 bytes, so 100 of them is 300 bytes -> ceil(300/4) = 75
		// tokens, far above the naive char-based 100/4 = 25 a length heuristic gives.
		expect(estimateTokens("中")).toBe(1); // 3 bytes -> ceil(3/4) = 1
		expect(estimateTokens("中".repeat(100))).toBe(75);
	});
});

describe("truncateToTokenLimit", () => {
	it("returns text unchanged when it is at or under the budget (no elision marker)", () => {
		const text = "a".repeat(400); // 100 tokens
		expect(truncateToTokenLimit(text, 100)).toBe(text); // exactly at budget
		expect(truncateToTokenLimit(text, 200)).toBe(text); // under budget
		expect(truncateToTokenLimit(text, 100)).not.toContain("elided");
	});

	it("clips ASCII to a real prefix and reports the exact elided char count", () => {
		const text = "a".repeat(400); // 100 tokens
		// keep = floor(400 * 50 / 100) = 200; elided = 400 - 200 = 200.
		const out = truncateToTokenLimit(text, 50);
		expect(out).toBe(`${"a".repeat(200)}\n[…200ch elided…]`);
		// The kept prefix alone lands at the 50-token budget.
		expect(estimateTokens("a".repeat(200))).toBe(50);
	});

	it("truncates CJK by byte weight so the kept prefix stays within budget", () => {
		const text = "中".repeat(100); // 300 bytes -> 75 tokens
		// keep = floor(100 * 30 / 75) = 40 chars; the kept 40 CJK chars are 120
		// bytes -> exactly 30 tokens. A char-based slice would keep 4*30 = 120 chars
		// (360 bytes -> 90 tokens), triple the budget.
		const out = truncateToTokenLimit(text, 30);
		expect(out.startsWith("中".repeat(40))).toBe(true);
		expect(out).toContain("[…60ch elided…]");
		expect(estimateTokens("中".repeat(40))).toBe(30);
	});

	it("keeps the elided count consistent: kept-chars + elided-chars = original length", () => {
		const text = "x".repeat(1000);
		const out = truncateToTokenLimit(text, 60); // tokens = 250, keep = floor(1000*60/250)=240
		const kept = out.slice(0, out.indexOf("\n"));
		const match = out.match(/…(\d+)ch elided…/);
		expect(match).not.toBeNull();
		const elided = Number(match?.[1]);
		expect(kept.length + elided).toBe(text.length);
		expect(kept).toBe("x".repeat(240));
		expect(elided).toBe(760);
	});

	it("degrades to only the marker (keep = 0) when the budget is zero", () => {
		const text = "a".repeat(400);
		// tokens (100) > 0, keep = max(0, floor(400*0/100)) = 0.
		expect(truncateToTokenLimit(text, 0)).toBe("\n[…400ch elided…]");
	});
});

describe("MAX_FILE_TOKENS", () => {
	it("is the single 50k per-file default shared by the pipeline entry and map phase", () => {
		expect(MAX_FILE_TOKENS).toBe(50_000);
	});
});
