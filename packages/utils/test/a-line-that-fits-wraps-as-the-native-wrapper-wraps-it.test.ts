/**
 * `wrapTextWithAnsi` returns a line that already fits without calling the native wrapper, and the
 * row it returns must be the row the native wrapper returns for the same line and width.
 *
 * The class this closes is any divergence between that shortcut and the native wrap: a character or
 * escape the shortcut measures differently, a leading indent the native hanging indent rewrites, a
 * width the binding coerces differently from the comparison (a fraction, a negative, NaN, Infinity,
 * a value past 2^32). Every input is compared against the native binding called directly, over a
 * pool built around those boundaries and at widths on both sides of each.
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
	8,
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
});
