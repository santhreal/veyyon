/**
 * Coverage for the editor's word-navigation primitives `moveWordLeft` /
 * `moveWordRight` (utils.ts) — the cursor math behind Alt+←/→ and the
 * word-delete keys. They are Unicode-aware (grapheme-segmented, joiner-aware for
 * contractions/hyphenated words, CJK runs treated as their own run) and had no
 * direct test coverage. Beyond exact-value cases this asserts three invariants
 * that every word-nav caller depends on and that a naive rewrite would break:
 *
 *   1. Range — the result is always in [0, text.length].
 *   2. Progress — from a non-boundary cursor the index strictly moves toward the
 *      requested edge (left < cursor, right > cursor). A caller that loops
 *      "move until start/end" would hang forever if this ever returned the input.
 *   3. Grapheme safety — the result is always a grapheme-cluster boundary, so a
 *      surrogate pair, ZWJ emoji, or combining sequence is never split.
 *
 * Deterministic LCG so any fuzz failure reproduces from the printed input.
 */
import { describe, expect, it } from "bun:test";
import { getSegmenter, moveWordLeft, moveWordRight } from "@veyyon/tui/utils";
import { lcg } from "./helpers/adversarial-strings";

/** The set of valid grapheme-cluster boundaries of `text` (indices, incl. 0 and length). */
function graphemeBoundaries(text: string): Set<number> {
	const boundaries = new Set<number>([0]);
	let i = 0;
	for (const { segment } of getSegmenter().segment(text)) {
		i += segment.length;
		boundaries.add(i);
	}
	return boundaries;
}

describe("moveWordLeft / moveWordRight — exact behavior", () => {
	it("jumps over whole words, landing at word starts", () => {
		expect(moveWordLeft("hello world", 11)).toBe(6); // → start of "world"
		expect(moveWordLeft("hello world", 6)).toBe(0); // → start of "hello"
		expect(moveWordLeft("hello world", 5)).toBe(0);
		expect(moveWordRight("hello world", 0)).toBe(5); // → end of "hello"
		expect(moveWordRight("hello world", 5)).toBe(11); // → end of "world"
		expect(moveWordRight("hello world", 6)).toBe(11);
	});

	it("keeps contractions and hyphenated words whole (joiner-aware)", () => {
		expect(moveWordLeft("don't stop", 5)).toBe(0); // apostrophe joins "don't"
		expect(moveWordRight("don't stop", 0)).toBe(5);
		expect(moveWordLeft("well-known", 10)).toBe(0); // hyphen joins "well-known"
		expect(moveWordRight("well-known", 0)).toBe(10);
	});

	it("skips whitespace before crossing a word", () => {
		expect(moveWordLeft("  spaced  ", 10)).toBe(2); // skip trailing ws, then to word start
		expect(moveWordRight("  spaced  ", 0)).toBe(8); // skip leading ws, then to word end
	});

	it("treats a CJK run as its own word", () => {
		expect(moveWordLeft("日本語 text", 3)).toBe(0);
		expect(moveWordRight("日本語 text", 0)).toBe(3); // stops before the space
	});

	it("stops at delimiters that are not joiners", () => {
		expect(moveWordLeft("foo.bar", 7)).toBe(4); // "bar" back to just after "."
		expect(moveWordRight("foo.bar", 0)).toBe(3); // "foo" up to the "."
	});

	it("never splits a ZWJ emoji cluster", () => {
		const family = "👨‍👩‍👧"; // 8 UTF-16 units, one grapheme
		expect(moveWordLeft(`a${family}b`, `a${family}b`.length)).toBe(1 + family.length); // before "b"
		expect(moveWordRight(`${family}x`, 0)).toBe(family.length); // past the whole cluster
	});

	it("handles empty input and single-char edges", () => {
		expect(moveWordLeft("", 0)).toBe(0);
		expect(moveWordRight("", 0)).toBe(0);
		expect(moveWordLeft("a", 1)).toBe(0);
		expect(moveWordRight("a", 0)).toBe(1);
	});

	it("clamps out-of-range cursors instead of throwing", () => {
		expect(moveWordLeft("hello", -5)).toBe(0);
		expect(moveWordLeft("hello", 999)).toBe(0);
		expect(moveWordRight("hello", -5)).toBe(5);
		expect(moveWordRight("hello", 999)).toBe(5);
	});
});

describe("moveWordLeft / moveWordRight — invariants (fuzz)", () => {
	// Fragments chosen to exercise every branch and Unicode hazard: words,
	// whitespace, joiners, delimiters, CJK, surrogate pairs, ZWJ clusters,
	// combining marks, control bytes, and a lone surrogate.
	const FRAGMENTS: readonly string[] = [
		"word",
		"a",
		" ",
		"\t",
		"'",
		"-",
		"’",
		"‑",
		".",
		",",
		"_",
		"日本語",
		"中",
		"👨‍👩‍👧",
		"🇺🇸",
		"é", // e + combining acute
		"\u{1f600}",
		String.fromCharCode(0xd800), // lone high surrogate
		"\n",
		"\x00",
		"123",
		"!!!",
	];

	function build(rand: () => number): string {
		const n = Math.floor(rand() * 20);
		let out = "";
		for (let k = 0; k < n; k++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
		return out;
	}

	it("stays in range, makes progress, and lands on grapheme boundaries", () => {
		const rand = lcg(0x5f_3a_c0_de);
		for (let iter = 0; iter < 20_000; iter++) {
			const text = build(rand);
			const len = text.length;
			const boundaries = graphemeBoundaries(text);
			// Probe from several cursor positions, including out-of-range.
			for (const cursor of [0, len, Math.floor(rand() * (len + 1)), -3, len + 7]) {
				let left: number;
				let right: number;
				try {
					left = moveWordLeft(text, cursor);
					right = moveWordRight(text, cursor);
				} catch (e) {
					throw new Error(`threw on ${JSON.stringify(text)}@${cursor}: ${e}`);
				}
				const clamped = Math.min(Math.max(cursor, 0), len);
				// 1. Range.
				expect(left).toBeGreaterThanOrEqual(0);
				expect(left).toBeLessThanOrEqual(len);
				expect(right).toBeGreaterThanOrEqual(0);
				expect(right).toBeLessThanOrEqual(len);
				// 2. Progress toward the edge (no fixpoint that would hang a caller).
				if (clamped > 0) expect(left).toBeLessThan(clamped);
				if (clamped < len) expect(right).toBeGreaterThan(clamped);
				// 3. Grapheme safety — never lands mid-cluster.
				expect(boundaries.has(left)).toBe(true);
				expect(boundaries.has(right)).toBe(true);
			}
		}
	});

	it("repeated moves converge to the edges without overshoot or stall", () => {
		const rand = lcg(0x1234_abcd);
		for (let iter = 0; iter < 3000; iter++) {
			const text = build(rand);
			const len = text.length;
			// Walk left from the end: strictly decreasing, terminates at 0.
			let pos = len;
			let steps = 0;
			while (pos > 0) {
				const next = moveWordLeft(text, pos);
				expect(next).toBeLessThan(pos);
				pos = next;
				if (++steps > len + 2) throw new Error(`left walk did not terminate on ${JSON.stringify(text)}`);
			}
			expect(pos).toBe(0);
			// Walk right from the start: strictly increasing, terminates at len.
			pos = 0;
			steps = 0;
			while (pos < len) {
				const next = moveWordRight(text, pos);
				expect(next).toBeGreaterThan(pos);
				pos = next;
				if (++steps > len + 2) throw new Error(`right walk did not terminate on ${JSON.stringify(text)}`);
			}
			expect(pos).toBe(len);
		}
	});
});
