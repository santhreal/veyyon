/**
 * Fuzz + invariant tests for the DECCARA background-fill optimizer.
 *
 * `analyzeBgFillLine` and `planDeccaraFills` run on every rendered frame's ANSI
 * line strings — which carry model-authored text, arbitrary SGR runs, wide/ZWJ
 * graphemes, and (from malformed output) truncated escapes. They must never
 * throw, must keep the row array parallel to the input, must return an in-range
 * cut index, and — the load-bearing contract — must never make a frame *larger*:
 * the whole point is to shrink trailing-background bytes, so the emitted plan's
 * total byte count can only be ≤ the original.
 *
 * Deterministic LCG so a failing frame reproduces from the printed seed.
 */
import { describe, expect, it } from "bun:test";
import { analyzeBgFillLine, DECSACE_DEFAULT, DECSACE_RECT, planDeccaraFills } from "@veyyon/pi-tui";
import { lcg } from "./helpers/adversarial-strings";

// SGR / text fragments spanning the parser's branches: background colors (the
// only thing it acts on), resets, foreground/attribute SGR, malformed and
// non-SGR CSI, OSC/APC intros it must refuse, plus printable/space/wide/ZWJ runs.
const FRAGMENTS: readonly string[] = [
	"\x1b[41m", // bg red
	"\x1b[48;5;22m", // bg 256
	"\x1b[48;2;10;20;30m", // bg truecolor
	"\x1b[49m", // default bg
	"\x1b[0m", // reset
	"\x1b[1m", // bold (non-bg SGR)
	"\x1b[38;5;9m", // fg
	"\x1b[", // truncated CSI
	"\x1b[999", // unterminated CSI params
	"\x1b[2J", // non-SGR CSI (final 'J')
	"\x1b]8;;http://x\x07", // OSC hyperlink (must bail)
	"\x1b_G\x1b\\", // APC (must bail)
	"a",
	"Z ",
	"   ",
	" ",
	"一", // wide
	"Ａ", // fullwidth
	"\u{1f600}", // emoji
	"\u{1f468}‍\u{1f469}‍\u{1f467}", // ZWJ family
	"́", // combining accent
	"",
];

function buildLine(rand: () => number): string {
	const n = Math.floor(rand() * 14);
	let out = "";
	for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
	return out;
}

// A well-formed full-width fillable row: content, then a background SGR, then
// trailing spaces out to `width`. Exercises the non-null analysis path that
// random junk rarely reaches (analysis requires col === width exactly).
function buildFillableLine(rand: () => number, width: number): string {
	const contentCols = Math.floor(rand() * width);
	const content = "x".repeat(contentCols);
	const bg = ["\x1b[41m", "\x1b[48;5;22m", "\x1b[48;2;1;2;3m"][Math.floor(rand() * 3)]!;
	const pad = " ".repeat(width - contentCols);
	return `${content}${bg}${pad}\x1b[0m`;
}

const byteLen = (s: string) => s.length;

describe("deccara fuzz invariants", () => {
	it("analyzeBgFillLine never throws and returns an in-range cut", () => {
		const rand = lcg(0xdec_0a201);
		for (let iter = 0; iter < 8000; iter++) {
			const width = 1 + Math.floor(rand() * 120);
			const line = rand() < 0.5 ? buildLine(rand) : buildFillableLine(rand, width);
			let result: ReturnType<typeof analyzeBgFillLine>;
			try {
				result = analyzeBgFillLine(line, width);
			} catch (e) {
				throw new Error(`analyzeBgFillLine(${JSON.stringify(line)}, ${width}) threw: ${e}`);
			}
			if (result !== null) {
				expect(result.cut).toBeGreaterThanOrEqual(0);
				expect(result.cut).toBeLessThanOrEqual(line.length);
				expect(result.leftCol).toBeGreaterThanOrEqual(0);
				expect(result.leftCol).toBeLessThan(width);
				expect(typeof result.bg).toBe("string");
			}
		}
	});

	it("planDeccaraFills keeps rows parallel and never grows the frame", () => {
		const rand = lcg(0x0a2_dec01);
		for (let iter = 0; iter < 6000; iter++) {
			const width = 1 + Math.floor(rand() * 120);
			const rowCount = Math.floor(rand() * 8);
			const lines: string[] = [];
			for (let r = 0; r < rowCount; r++) {
				lines.push(rand() < 0.5 ? buildFillableLine(rand, width) : buildLine(rand));
			}
			let plan: ReturnType<typeof planDeccaraFills>;
			try {
				plan = planDeccaraFills(lines, width, Math.floor(rand() * 50));
			} catch (e) {
				throw new Error(`planDeccaraFills threw on ${JSON.stringify(lines)} width ${width}: ${e}`);
			}
			// Rows stay parallel to the input.
			expect(plan.texts).toHaveLength(lines.length);
			// The optimizer only ever removes trailing bytes: the total emitted byte
			// count (rewritten rows + the DECCARA sequence) must not exceed the input.
			const inputBytes = lines.reduce((sum, l) => sum + byteLen(l), 0);
			const outputBytes = plan.texts.reduce((sum, t) => sum + byteLen(t), 0) + byteLen(plan.sequence);
			expect(outputBytes).toBeLessThanOrEqual(inputBytes);
			// When a rectangle batch is emitted it must be a real byte win (strictly
			// smaller) and be wrapped in the DECSACE begin/end markers.
			if (plan.sequence.length > 0) {
				expect(outputBytes).toBeLessThan(inputBytes);
				expect(plan.sequence.startsWith(DECSACE_RECT)).toBe(true);
				expect(plan.sequence.endsWith(DECSACE_DEFAULT)).toBe(true);
			}
		}
	});
});
