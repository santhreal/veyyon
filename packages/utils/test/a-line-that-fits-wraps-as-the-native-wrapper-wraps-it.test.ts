/**
 * `wrapTextWithAnsi` returns a line that already fits without calling the native wrapper, and the
 * row it returns must be the row the native wrapper returns for the same line and width.
 *
 * The class this closes is any divergence between that shortcut and the native wrap: a character or
 * escape the shortcut measures differently, a character that joins its neighbour into one cluster
 * the native measures whole, a leading indent the native hanging indent rewrites, including the
 * width at which it stops hanging, a width the binding coerces differently from the comparison (a
 * fraction, a negative, NaN, Infinity, a value past 2^32). Every input is compared against the
 * native binding called directly, over a pool built around those boundaries and at widths on both
 * sides of each, and every unit of the blocks the shortcut counts past ASCII is swept alone, beside a
 * letter, and beside each character that can join a cluster.
 *
 * Not caught: whether the native wrap is itself right, which the other wrap suites pin, and any
 * character family absent from the pool below.
 */
import { describe, expect, it } from "bun:test";
import { wrapTextWithAnsi as nativeWrapTextWithAnsi } from "@veyyon/natives";
import { fuzzStrings } from "@veyyon/utils/adversarial-strings";
import { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-width";
import { normalizeWrapInput, wrapTextWithAnsi } from "@veyyon/utils/wrap";

const WIDTHS = [
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	13,
	40,
	200,
	-1,
	0.5,
	7.9,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	2 ** 32 + 3,
	2 ** 31,
];

function expectNativeRows(text: string): void {
	for (const width of WIDTHS) {
		const native = nativeWrapTextWithAnsi(normalizeWrapInput(text), width, DEFAULT_TAB_WIDTH);
		expect({ text, width, rows: wrapTextWithAnsi(text, width) }).toEqual({ text, width, rows: native });
	}
}

/** What the shortcut counts, what it refuses, and what sits on the edge between the two. */
const FRAGMENTS: readonly string[] = [
	" ",
	"a",
	"Z",
	"~",
	"\x1b[31m",
	"\x1b[0m",
	"\x1b[m",
	"\x1b[1;32;40m",
	"\x1b[38:2::1:2:3m",
	"\x1b[2K", // CSI that is not SGR
	"\x1b[?25h", // private CSI
	"\x1b[31", // CSI cut before its final byte
	"\x1b[>4;2m", // private CSI that also ends in `m`
	"\x1b[ m", // CSI with an intermediate byte
	"\x1b(0", // character-set designator, so a following `m` is a cell
	"\x1bm", // two-byte escape
	"\x1b]8;;https://x\x07", // OSC 8 hyperlink opener
	"\x1b]66;s=2;Hi\x1b\\", // OSC 66 span, four cells
	"\t",
	"\r",
	"\n",
	"\x00",
	"\x7f",
	"é",
	"一",
	"\u{1f600}",
	"…", // one cell, ambiguous width
	"▪",
	"─",
	"→",
	"·",
	"✓",
	"\u00a0", // no-break space: a cell, not an indent
	"\u00ad", // soft hyphen, outside the counted blocks
	"\u2329", // wide bracket inside a counted block
	"\u25fd", // wide geometric shape inside a counted block
	"\u203c", // pictographic
	"\u0301", // combining acute
	"\u200d", // zero-width joiner
	"\ufe0f", // emoji presentation selector
	"\u1100", // Hangul leading consonant, which joins a following medial vowel
	"\u1161", // Hangul medial vowel
	"\u0903", // spacing mark
	"\u0d4e", // prepended letter
	"\u2028", // line separator
	"  ",
	"    ",
];

describe("a line that fits wraps as the native wrapper wraps it", () => {
	it.each([
		["the empty line", ""],
		["a line one cell short of the width", "abcd"],
		["a line at exactly the width", "abcde"],
		["a line one cell over the width", "abcdef"],
		["a line of nothing but spaces", "     "],
		["a styled line", "\x1b[31mred\x1b[0m text"],
		["a line of nothing but SGR", "\x1b[1m\x1b[0m"],
		["an indent followed by its style", "    \x1b[2mindented\x1b[0m"],
		["a style ahead of its indent", "\x1b[2m    indented\x1b[0m"],
		["a style inside its indent", "  \x1b[2m  indented\x1b[0m"],
		["a style ahead of an indent that leaves no room to hang", "\x1b[2m    abcd\x1b[0m"],
		["styles between the spaces of an indent", " \x1b[1m \x1b[31m  \x1b[4mx"],
		["a style ahead of an indent with no content", "\x1b[2m    \x1b[0m"],
		["an ellipsis at exactly the width", "abcd…"],
		["a bullet past the width", "▪ abcde"],
		["box drawing", "│ ── ┌┐ └┘"],
		["a no-break space ahead of a style and an indent", "\u00a0\x1b[2m  x"],
		["trailing spaces", "text   "],
		["a carriage return", "one\rtwo"],
		["a tab", "a\tb"],
		["a character-set designator ahead of an m", "abcd\x1b(0m"],
		["a wide character", "一二三"],
	])("%s", (_name, text) => {
		expectNativeRows(text);
	});

	it("holds for every generated line from the boundary pool", () => {
		fuzzStrings(
			{
				seed: 0x77_72_61_70,
				iterations: 2_000,
				build: rand => {
					const count = Math.floor(rand() * 16);
					let out = "";
					for (let i = 0; i < count; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
					return out;
				},
			},
			expectNativeRows,
		);
	});

	it("holds for every unit of the counted blocks alone, beside a letter and beside a joining character", () => {
		const joiners = ["\u0301", "\u200d", "\ufe0f", "\u1161", "\u0903", "\u20e3", "\u{1f3fb}"];
		const blocks: readonly (readonly [number, number])[] = [
			[0x00a0, 0x00ff],
			[0x2000, 0x206f],
			[0x2190, 0x23ff],
			[0x2500, 0x25ff],
			[0x2700, 0x27bf],
		];
		for (const [first, last] of blocks) {
			for (let code = first; code <= last; code++) {
				const unit = String.fromCharCode(code);
				for (const text of [
					unit,
					`a${unit}`,
					`${unit}a`,
					`\x1b[2m  ${unit}x`,
					...joiners.map(join => unit + join),
				]) {
					expectNativeRows(text);
				}
			}
		}
	});
});
