/**
 * Fuzz + property tests for the width-math primitives (truncateToWidth,
 * visibleWidth, wrapTextWithAnsi). These sit on the render hot path and cross
 * into Rust natives, so adversarial UTF-16 (lone surrogates, malformed ANSI/OSC,
 * combining/zero-width/wide graphemes) plus extreme widths must never panic and
 * must respect basic invariants:
 *   - visibleWidth: finite integer >= 0, never throws
 *   - truncateToWidth(_, w, Omit): never throws; result width <= w
 *   - wrapTextWithAnsi(_, w): never throws
 *
 * Deterministic LCG so a failure reproduces from the printed seed input.
 */
import { describe, expect, it } from "bun:test";
import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
// `fuzzStrings` for the cases whose input IS the adversarial string, so they get shrinking and a
// corpus; the raw generator for the last case, which assembles tokens under a width constraint
// rather than drawing one string.
import { fuzzSeed, fuzzStrings, lcg } from "@veyyon/utils/adversarial-strings";

// Content on which the two independent width oracles — the Rust-native
// truncateToWidth and the JS visibleWidth (Bun.stringWidth + corrections) —
// provably agree. This is the surface the width-BOUND property guards, and it is
// deliberately grown as divergences are fixed rather than left at the safe
// minimum: printable ASCII, wide CJK/fullwidth graphemes, a single emoji,
// well-formed ANSI color, and the zero-width marks whose corrections now live in
// `visibleWidth` (see `visible-width-enclosing-marks.test.ts` for what each one
// pins), and WELL-FORMED OSC 66 text-sizing spans, whose three divergences are
// fixed and pinned in `visible-width-osc66-spans.test.ts`. Still excluded, and
// still fuzzed for no-throw above: raw C0 control bytes, UNTERMINATED escape
// introducers, MALFORMED OSC 66 spans (an escape in the payload, or no
// terminator), and ZWJ emoji families. On those the two oracles use different
// width models (BUG-WIDTH-MODEL-DIVERGENCE): the native counts the bytes after an
// `ESC` that never completed a sequence, where Bun and a real terminal both draw
// nothing. Every remaining one is the NATIVE's answer to fix, and every one is in
// the safe direction, native wider than JS, so it clips a span rather than
// overflowing a line.
const SAFE_FRAGMENTS: string[] = [
	"a",
	"Z",
	"9",
	" ",
	"一", // CJK (wide)
	"Ａ", // fullwidth A (wide)
	"　", // ideographic space (wide)
	"\u{1f600}", // single emoji
	"\u0489", // enclosing mark Bun over-counted (zero cells)
	"\ua670", // ditto, the other block
	"\u20dd", // enclosing mark both oracles already zeroed
	"\u20e3", // keycap combiner with no keycap base (zero cells)
	"1\ufe0f\u20e3", // a real keycap sequence (two cells)
	"\ufe0f", // lone variation selector (zero cells)
	"\x1b[31m",
	"\x1b[0m",
	"\x1b[1;32;40m",
	"\x1bm", // two-byte Fe escape, zero cells
	"\x1b(B", // nF character-set designator, zero cells
	"\x1bPq\x1b\\", // DCS string sequence, payload included, zero cells
	"\x1b]0;t\ti\x07", // OSC with a tab in it, zero cells
	"\x1b]66;s=2;Hi\x1b\\", // OSC 66 scaled span, four cells
	"\x1b]66;w=5;Hi\x07", // OSC 66 with a declared width, five cells
	"\x1b]66;s=2;a\t\x1b\\", // OSC 66 whose payload tab scales with the span
	"\x1b]66;w=+5;Hi\x1b\\", // OSC 66 with malformed metadata, two cells
];

function buildSafeString(rand: () => number): string {
	const n = Math.floor(rand() * 24);
	let out = "";
	for (let i = 0; i < n; i++) out += SAFE_FRAGMENTS[Math.floor(rand() * SAFE_FRAGMENTS.length)];
	return out;
}

const WIDTHS = [0, 1, 2, 3, 5, 8, 13, 40, 200, -1, -100, 2 ** 31, Number.MAX_SAFE_INTEGER, 0.5, Number.NaN];

/**
 * Inputs that broke these primitives before, replayed first on every run and under every seed.
 *
 * Empty is the honest state. Add the string a failure's `corpus entry:` line prints, with a comment
 * naming the bug it locks out; see `docs/internal/fuzzing.md`.
 */
const VISIBLE_WIDTH_CORPUS: readonly string[] = [
	// A zero-width mark inside an unterminated OSC. `visibleWidth` strips the OSC
	// before measuring, and the first version of the enclosing-mark correction
	// re-scanned the ORIGINAL string and subtracted a cell for a mark that was never
	// counted, returning -1. The correction now removes the marks from the text it is
	// about to measure instead of adjusting the number afterwards.
	"\x1b]\u0489",
];

/** Same, for the `truncateToWidth` no-throw invariant. See {@link VISIBLE_WIDTH_CORPUS}. */
const TRUNCATE_CORPUS: readonly string[] = [];

/** Same, for the narrower safe-alphabet width-cap property. See {@link VISIBLE_WIDTH_CORPUS}. */
const TRUNCATE_SAFE_CORPUS: readonly string[] = [];

/** Same, for the `wrapTextWithAnsi` no-throw invariant. See {@link VISIBLE_WIDTH_CORPUS}. */
const WRAP_CORPUS: readonly string[] = [];

describe("width-math fuzz invariants", () => {
	it("visibleWidth never throws and returns a finite non-negative integer", () => {
		fuzzStrings({ seed: 0x1234_5678, iterations: 6000, corpus: VISIBLE_WIDTH_CORPUS }, s => {
			let w: number;
			try {
				w = visibleWidth(s);
			} catch (e) {
				throw new Error(`visibleWidth threw on ${JSON.stringify(s)}: ${e}`);
			}
			if (!Number.isInteger(w) || w < 0) {
				throw new Error(`visibleWidth(${JSON.stringify(s)}) = ${w} (not a non-negative integer)`);
			}
		});
	});

	it("truncateToWidth never throws on adversarial input (full fragment pool)", () => {
		fuzzStrings({ seed: 0x0bad_f00d, iterations: 6000, corpus: TRUNCATE_CORPUS }, (s, rand) => {
			const w = WIDTHS[Math.floor(rand() * WIDTHS.length)]!;
			try {
				truncateToWidth(s, w, Ellipsis.Omit);
			} catch (e) {
				throw new Error(`truncateToWidth(${JSON.stringify(s)}, ${w}) threw: ${e}`);
			}
		});
	});

	it("truncateToWidth never exceeds the target width on realistic content (Omit)", () => {
		// Malformed / partial escape sequences are excluded here — the native
		// truncateToWidth and JS visibleWidth use different width models for those
		// (BUG-WIDTH-MODEL-DIVERGENCE): visibleWidth adds back OSC66 scaled widths
		// and counts stray OSC/CSI-intro bytes that the native truncate strips to
		// zero, so a truncated malformed span can read wider than the target. That
		// divergence is tracked for a native fix; the no-throw test above still
		// fuzzes those inputs. This property guards the realistic surface: text,
		// wide graphemes, combining/zero-width marks, emoji, and well-formed ANSI.
		fuzzStrings(
			{ seed: 0x0bad_f00d, iterations: 6000, corpus: TRUNCATE_SAFE_CORPUS, build: buildSafeString },
			(s, rand) => {
				const w = WIDTHS[Math.floor(rand() * WIDTHS.length)]!;
				const out = truncateToWidth(s, w, Ellipsis.Omit);
				// Mirror truncateToWidth's own normalization: widths at/above INT32_MAX
				// (incl. Infinity) are capped there rather than wrapping through `| 0`.
				const target = w >= 0x7fff_ffff ? 0x7fff_ffff : Math.max(0, w | 0);
				const outWidth = visibleWidth(out);
				if (outWidth > target) {
					throw new Error(
						`truncateToWidth(${JSON.stringify(s)}, ${w}) -> width ${outWidth} > target ${target}: ${JSON.stringify(out)}`,
					);
				}
			},
		);
	});

	it("truncateToWidth returns the full text for unbounded widths (no 2^31 wrap)", () => {
		// `maxWidth | 0` wraps at 2^31, so Infinity/NaN/>=2^31 once collapsed to 0
		// and truncated the text to nothing. An unbounded width must be a no-op.
		const samples = ["hello world", "一二三四五", "\x1b[31mred\x1b[0m text", "a".repeat(1000), "😀 mixed 漢字"];
		for (const text of samples) {
			for (const w of [Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER, 0x7fff_ffff]) {
				expect(truncateToWidth(text, w, Ellipsis.Omit)).toBe(text);
			}
		}
	});

	it("wrapTextWithAnsi normalizes CR/CRLF so no row carries a stray carriage return", () => {
		// A `\r` surviving into a wrapped row moves the terminal cursor to column 0
		// and corrupts the line. CRLF and bare CR must both act as clean LF breaks.
		expect(wrapTextWithAnsi("First\r\nSecond", 40)).toEqual(["First", "Second"]);
		expect(wrapTextWithAnsi("Alpha\rBeta", 40)).toEqual(["Alpha", "Beta"]);
		expect(wrapTextWithAnsi("a\rb\r\nc", 40)).toEqual(["a", "b", "c"]);
		for (const s of ["x\r\ny", "p\rq", "\r\r\r", "line\r"]) {
			for (const line of wrapTextWithAnsi(s, 8)) {
				expect(line.includes("\r")).toBe(false);
			}
		}
	});

	it("wrapTextWithAnsi never throws for positive widths", () => {
		fuzzStrings({ seed: 0xfeed_face, iterations: 4000, corpus: WRAP_CORPUS }, (s, rand) => {
			const w = [1, 2, 3, 8, 40][Math.floor(rand() * 5)]!;
			try {
				const lines = wrapTextWithAnsi(s, w);
				expect(Array.isArray(lines)).toBe(true);
			} catch (e) {
				throw new Error(`wrapTextWithAnsi(${JSON.stringify(s)}, ${w}) threw: ${e}`);
			}
		});
	});

	it("wrapTextWithAnsi keeps each line within the width on realistic content", () => {
		// A wrapped line wider than the target makes the terminal wrap it AGAIN,
		// corrupting the frame's row accounting. The only unavoidable overflow is a
		// single unbreakable token wider than the whole width; excluding a stray
		// space so tokens stay atomic, every produced line must fit. Uses the agreed
		// width surface (see SAFE_FRAGMENTS) so the check is about wrapping, not the
		// native/JS width-oracle divergence.
		const wrapFragments = SAFE_FRAGMENTS.filter(f => f !== " ");
		const rand = lcg(fuzzSeed(0xc0ffee11));
		for (let iter = 0; iter < 5000; iter++) {
			const width = [1, 2, 3, 5, 8, 13, 40][Math.floor(rand() * 7)]!;
			// Build space-separated tokens each no wider than `width` so no token is
			// inherently unbreakable — then every wrapped line is expected to fit.
			const tokenCount = 1 + Math.floor(rand() * 6);
			const tokens: string[] = [];
			for (let t = 0; t < tokenCount; t++) {
				let token = "";
				while (visibleWidth(token) < width) {
					const frag = wrapFragments[Math.floor(rand() * wrapFragments.length)]!;
					if (visibleWidth(token + frag) > width) break;
					token += frag;
				}
				// A token must be genuinely visible: a pure-ANSI (zero-width) token
				// carries only its separating spaces, and a run of them sums those
				// interior spaces past the width — an artifact of standalone
				// zero-width tokens that never occurs in real content (ANSI codes
				// attach to text, they are not space-separated on their own).
				tokens.push(visibleWidth(token) >= 1 ? token : "a");
			}
			const s = tokens.join(" ");
			for (const line of wrapTextWithAnsi(s, width)) {
				const lineWidth = visibleWidth(line);
				if (lineWidth > width) {
					throw new Error(
						`wrapTextWithAnsi(${JSON.stringify(s)}, ${width}) produced over-wide line ${JSON.stringify(line)} = ${lineWidth}`,
					);
				}
			}
		}
	});
});
