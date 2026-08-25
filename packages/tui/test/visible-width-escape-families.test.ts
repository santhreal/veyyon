/**
 * `visibleWidth` has to know the whole escape grammar, not the two forms Bun knows.
 *
 * `Bun.stringWidth` recognises CSI (`ESC [ ... final`) and OSC, and nothing else, so
 * the rest of ECMA-48 arrives as ordinary text and is charged for whatever bytes it
 * happens to contain. The native width engine strips all of it, and so does every
 * terminal, which makes each of these a disagreement between the oracle that CUTS a
 * span (`truncateToWidth`, native) and the oracle that MEASURES it (`visibleWidth`).
 * A span cut to fit W then re-measures wider than W, and the caller that sized a
 * viewport by the cut writes past the last column.
 *
 * Eleven of the nineteen measured escape-class disagreements are closed by the three
 * families below. The five that remain are unterminated introducers, where Bun and a
 * real terminal both answer zero and the native counts the bytes after the `ESC`;
 * those are pinned at the bottom as the native's to fix, so this suite fails loudly
 * if that ever changes rather than quietly going stale.
 */

import { describe, expect, it } from "bun:test";
import { sliceWithWidth, visibleWidth } from "../src/utils";

/** The native oracle, which is what `truncateToWidth` and `wrapTextWithAnsi` cut on. */
function nativeWidth(text: string): number {
	return sliceWithWidth(text, 0, 9999, false).width;
}

describe("two-byte Fe and Fs escapes", () => {
	/**
	 * `ESC` plus one byte in `0x40..0x7e` is a complete sequence and draws nothing.
	 *
	 * Bun charges for the second byte, so `"\x1bm"` measured one cell. `m` is the
	 * common one because it is the last byte of every SGR sequence, which means a
	 * truncation that cut a colour code in half left exactly this shape behind.
	 */
	it("costs nothing, and does not leak its final byte into the width", () => {
		for (const sequence of ["\x1bm", "\x1bZ", "\x1bc", "\x1bD", "\x1bN", "\x1b~"]) {
			expect(visibleWidth(sequence)).toBe(0);
			expect(visibleWidth(sequence)).toBe(nativeWidth(sequence));
		}
	});

	/**
	 * Only the two bytes are consumed, so the text around the sequence still counts.
	 *
	 * A strip that ran to the end of the string would make this zero, and a strip
	 * that took only the `ESC` would make it three. Both are wrong in a way a
	 * single-sequence test cannot see.
	 */
	it("consumes exactly two bytes", () => {
		expect(visibleWidth("a\x1bmb")).toBe(2);
		expect(visibleWidth("\x1bNa")).toBe(1);
		expect(visibleWidth("\x1bOa")).toBe(1);
		expect(visibleWidth("ab\x1bccd")).toBe(4);
	});

	/**
	 * `ESC` plus a byte in `0x30..0x3f` is the Fp class, and it draws nothing either.
	 *
	 * `ESC 7` and `ESC 8` save and restore the cursor and `ESC =` sets keypad mode;
	 * a terminal consumes all three. Both oracles used to charge one cell for the
	 * second byte, which was wrong in the same direction on both sides and therefore
	 * invisible. Bun 1.4.0 started stripping the class, which split the pair — the
	 * measurer answered zero while the native still cut as though it were a cell, so
	 * a span cut to fit W re-measured NARROWER than W and padding computed from the
	 * cut came out short. The native strips it now too, and this side matches the
	 * class explicitly rather than relying on which Bun is underneath.
	 */
	it("costs nothing for the Fp range, on both oracles", () => {
		for (const sequence of ["\x1b7", "\x1b8", "\x1b=", "\x1b>"]) {
			expect(visibleWidth(sequence)).toBe(0);
			expect(visibleWidth(sequence)).toBe(nativeWidth(sequence));
		}
		// Two bytes, and only two: the text around the sequence still counts.
		expect(visibleWidth("a\x1b7b")).toBe(2);
		expect(visibleWidth("a\x1b7b")).toBe(nativeWidth("a\x1b7b"));
	});
});

describe("nF escapes", () => {
	/**
	 * `ESC` then intermediate bytes then a final: the character-set designators.
	 *
	 * `ESC ( B` selects ASCII into G0 and is emitted by anything that resets a
	 * terminal's character sets, so it turns up in captured output and in shell
	 * prompts. Bun charged two cells for it.
	 */
	it("costs nothing for designators and other intermediate-byte sequences", () => {
		for (const sequence of ["\x1b(B", "\x1b)0", "\x1b#8", "\x1b F"]) {
			expect(visibleWidth(sequence)).toBe(0);
			expect(visibleWidth(sequence)).toBe(nativeWidth(sequence));
		}
		expect(visibleWidth("a\x1b(Bb")).toBe(2);
	});
});

describe("string sequences", () => {
	/**
	 * DCS, SOS, PM and APC carry a PAYLOAD, and the payload is not text.
	 *
	 * This is the family with the largest error, because Bun measured the entire
	 * payload: a DCS-wrapped terminal reply or an APC-wrapped image escape was
	 * charged its full byte length. It is also why this family is matched before the
	 * two-byte rule, which would otherwise take the introducer and hand the payload
	 * to the width tables as ordinary characters.
	 */
	it("costs nothing, payload included, for either terminator", () => {
		for (const introducer of ["P", "X", "^", "_"]) {
			for (const terminator of ["\x1b\\", "\x07"]) {
				const sequence = `\x1b${introducer}payload here${terminator}`;
				expect(visibleWidth(sequence)).toBe(0);
				expect(visibleWidth(sequence)).toBe(nativeWidth(sequence));
			}
		}
	});

	/**
	 * And it stops at the terminator rather than swallowing the rest of the line.
	 *
	 * The lazy quantifier is the whole difference between stripping one sequence and
	 * silently deleting every visible cell after it, which would read as a correct
	 * zero on the sequence alone.
	 */
	it("stops at the first terminator", () => {
		expect(visibleWidth("\x1bPq\x1b\\after")).toBe(5);
		expect(visibleWidth("before\x1b_x\x07after")).toBe(11);
	});
});

describe("an unterminated string sequence draws nothing in either oracle", () => {
	/**
	 * Half of the escape-class disagreement, and the half that ran the wrong way for
	 * the native: Bun answered zero, which is what a terminal does with a sequence it
	 * is still assembling, and the native charged the payload bytes as cells.
	 *
	 * `string_sequence_consumed_len_u16` in `crates/veyyon-text` closes it. The
	 * scanner used to skip the `ESC` alone and hand the rest to the text pass, which
	 * is where the old counts came from: four cells for `ESC ] 8 ; ;`.
	 *
	 * Both numbers are asserted, not just their equality: agreeing on a wrong number
	 * is the failure this file exists to catch.
	 */
	it("measures zero on both sides", () => {
		for (const sequence of ["\x1b]", "\x1b]8;;", "\x1b]66;s=2;Hi", "\x1bPq", "\x1b_data"]) {
			expect(visibleWidth(sequence)).toBe(0);
			expect(nativeWidth(sequence)).toBe(0);
		}
	});

	/**
	 * And the consumed payload stops where the terminal stops it, rather than eating
	 * the output that follows. An `ESC` inside the payload aborts the string, and
	 * what comes after is ordinary text: here a two-byte `ESC Z` of no width, then a
	 * `b` that draws.
	 */
	it("stops at the escape that aborts the payload", () => {
		expect(nativeWidth("\x1b]66;;a\x1bZb\x1b\\")).toBe(1);
		expect(visibleWidth("\x1b]66;;a\x1bZb\x1b\\")).toBe(1);
	});
});

describe("what is deliberately still divergent", () => {
	/**
	 * An unterminated CSI, where the two oracles disagree and neither is obviously
	 * wrong. Bun answers zero. The native drops the unclassifiable `ESC` and draws
	 * the `[` and any parameter bytes as ordinary text, which is the contract
	 * `a_stray_csi_introducer_does_not_swallow_the_line` pins in
	 * `crates/veyyon-text`: a stray introducer must not consume the line, and the
	 * grammar walk stops at the first byte it does not allow.
	 *
	 * It stays open because it is the SAFE direction. The native's number is the
	 * larger one, so a cut lands early and nothing overflows. Closing it means
	 * deciding whether `ESC [` itself draws, which changes that contract rather than
	 * extending it, so it does not ride along with the string-sequence fix above.
	 */
	it("still measures an unterminated CSI as zero while the native counts its bytes", () => {
		const cases: [string, number][] = [
			["\x1b[", 1],
			["\x1b[3", 2],
			["\x1b[31", 3],
		];
		for (const [sequence, native] of cases) {
			expect(visibleWidth(sequence)).toBe(0);
			expect(nativeWidth(sequence)).toBe(native);
		}
	});
});

describe("the sequences that do count are untouched", () => {
	/**
	 * The guard on the guard: a strip this broad must not eat anything visible.
	 *
	 * A pattern that matched too much would turn every one of the assertions above
	 * green while quietly zeroing real content, so the shapes the renderer actually
	 * emits are measured against the native oracle here as well.
	 */
	it("agrees with the native oracle on real styled output", () => {
		const samples = [
			"\x1b[31mred\x1b[0m",
			"\x1b[1;32;40mbold green\x1b[0m",
			"\x1b]8;;https://example.com\x07label\x1b]8;;\x07",
			"\x1b]66;s=2;AB\x07",
			"plain text",
			"一二三",
			"\x1b[38;2;255;0;0mtruecolor\x1b[39m",
		];
		for (const sample of samples) {
			expect(visibleWidth(sample)).toBe(nativeWidth(sample));
		}
		expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
		expect(visibleWidth("\x1b]8;;https://example.com\x07label\x1b]8;;\x07")).toBe(5);
	});
});
