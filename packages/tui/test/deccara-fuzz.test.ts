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
 * WHY A SPEC AND NOT A STRING. A case here is a line together with the WIDTH it must fill: the
 * analysis only takes its non-null path when the line ends exactly at `width`, so shrinking the
 * line alone would produce a case that no longer describes what failed. The case is therefore the
 * generative spec -- how the line was built, and the width -- and the line is derived from it, so
 * every simplification stays a case the builder could have produced. That is what let this suite
 * move onto `fuzzCases` and finally get a shrinker and a corpus.
 */
import { describe, expect, it } from "bun:test";
import { analyzeBgFillLine, DECSACE_DEFAULT, DECSACE_RECT, planDeccaraFills } from "@veyyon/tui";
import { fuzzCases } from "@veyyon/utils/adversarial-strings";

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

const byteLen = (s: string) => s.length;

/**
 * A row, described the way it was generated rather than as finished text.
 *
 * `fragments` indexes into {@link FRAGMENTS}, and `fillContentCols`/`fillBg` describe the
 * well-formed fillable shape. Keeping the description means a simplification is always a real
 * generated row: drop a fragment, narrow the content. Editing the rendered string instead could
 * cut an escape sequence in half and report a parser bug that does not exist.
 */
type RowSpec =
	| { readonly kind: "junk"; readonly fragments: readonly number[] }
	| { readonly kind: "fill"; readonly contentCols: number; readonly bg: number };

/** A whole case: the rows and the width they are measured against. */
type FrameCase = {
	readonly width: number;
	readonly rows: readonly RowSpec[];
	/** `planDeccaraFills`'s third argument. Part of the case so a failure names it. */
	readonly minRun: number;
};

const FILL_BACKGROUNDS = ["\x1b[41m", "\x1b[48;5;22m", "\x1b[48;2;1;2;3m"] as const;

function buildRowSpec(rand: () => number, width: number): RowSpec {
	if (rand() < 0.5) {
		const n = Math.floor(rand() * 14);
		const fragments: number[] = [];
		for (let i = 0; i < n; i++) fragments.push(Math.floor(rand() * FRAGMENTS.length));
		return { kind: "junk", fragments };
	}
	return {
		kind: "fill",
		contentCols: Math.floor(rand() * width),
		bg: Math.floor(rand() * FILL_BACKGROUNDS.length),
	};
}

function buildFrame(rand: () => number, maxRows: number): FrameCase {
	const width = 1 + Math.floor(rand() * 120);
	const rowCount = Math.floor(rand() * (maxRows + 1));
	const rows: RowSpec[] = [];
	for (let r = 0; r < rowCount; r++) rows.push(buildRowSpec(rand, width));
	return { width, rows, minRun: Math.floor(rand() * 50) };
}

/** Render one row spec. The `fill` shape needs the case's width, which is why it is not stored. */
function renderRow(row: RowSpec, width: number): string {
	if (row.kind === "junk") return row.fragments.map(index => FRAGMENTS[index % FRAGMENTS.length]).join("");
	// Clamped rather than assumed: a shrunk width must not produce a negative pad.
	const contentCols = Math.min(row.contentCols, width);
	const content = "x".repeat(contentCols);
	const bg = FILL_BACKGROUNDS[row.bg % FILL_BACKGROUNDS.length] as string;
	return `${content}${bg}${" ".repeat(width - contentCols)}\x1b[0m`;
}

/** Simpler frames, biggest reduction first: fewer rows, then simpler rows, then a smaller width. */
function simplifyFrame(frame: FrameCase): FrameCase[] {
	const candidates: FrameCase[] = [];

	for (let i = 0; i < frame.rows.length; i++) {
		candidates.push({ ...frame, rows: [...frame.rows.slice(0, i), ...frame.rows.slice(i + 1)] });
	}
	for (let i = 0; i < frame.rows.length; i++) {
		const row = frame.rows[i] as RowSpec;
		if (row.kind === "junk" && row.fragments.length > 0) {
			const halved = row.fragments.slice(0, Math.floor(row.fragments.length / 2));
			candidates.push({
				...frame,
				rows: frame.rows.map((r, j) => (j === i ? { kind: "junk" as const, fragments: halved } : r)),
			});
		}
		if (row.kind === "fill" && row.contentCols > 0) {
			candidates.push({
				...frame,
				rows: frame.rows.map((r, j) => (j === i ? { ...row, contentCols: Math.floor(row.contentCols / 2) } : r)),
			});
		}
	}
	if (frame.width > 1) candidates.push({ ...frame, width: Math.max(1, Math.floor(frame.width / 2)) });
	if (frame.minRun > 0) candidates.push({ ...frame, minRun: 0 });

	return candidates;
}

/**
 * Frames this fuzzer found, replayed before any generated one.
 *
 * Empty is the honest state: the hand-written loop it replaced persisted nothing.
 */
const DECCARA_CORPUS: readonly FrameCase[] = [];

describe("deccara fuzz invariants", () => {
	it("analyzeBgFillLine never throws and returns an in-range cut", () => {
		fuzzCases<FrameCase>(
			{
				seed: 0xdec_0a201,
				iterations: 8_000,
				corpus: DECCARA_CORPUS,
				// One row per case here: the analysis is per line, so a multi-row case would report
				// a frame when the failure is about a single line.
				build: rand => ({ ...buildFrame(rand, 1), rows: [buildRowSpec(rand, 1 + Math.floor(rand() * 120))] }),
				simplify: simplifyFrame,
			},
			frame => {
				const row = frame.rows[0];
				if (!row) return;
				const line = renderRow(row, frame.width);

				const result = analyzeBgFillLine(line, frame.width);

				if (result !== null) {
					expect(result.cut).toBeGreaterThanOrEqual(0);
					expect(result.cut).toBeLessThanOrEqual(line.length);
					expect(result.leftCol).toBeGreaterThanOrEqual(0);
					expect(result.leftCol).toBeLessThan(frame.width);
					expect(typeof result.bg).toBe("string");
				}
			},
		);
	});

	it("planDeccaraFills keeps rows parallel and never grows the frame", () => {
		fuzzCases<FrameCase>(
			{
				seed: 0x0a2_dec01,
				iterations: 6_000,
				corpus: DECCARA_CORPUS,
				build: rand => buildFrame(rand, 7),
				simplify: simplifyFrame,
			},
			frame => {
				const lines = frame.rows.map(row => renderRow(row, frame.width));

				const plan = planDeccaraFills(lines, frame.width, frame.minRun);

				// Rows stay parallel to the input.
				expect(plan.texts).toHaveLength(lines.length);
				// The optimizer only ever removes trailing bytes: the total emitted byte count
				// (rewritten rows + the DECCARA sequence) must not exceed the input.
				const inputBytes = lines.reduce((sum, l) => sum + byteLen(l), 0);
				const outputBytes = plan.texts.reduce((sum, t) => sum + byteLen(t), 0) + byteLen(plan.sequence);
				expect(outputBytes).toBeLessThanOrEqual(inputBytes);
				// When a rectangle batch is emitted it must be a real byte win (strictly smaller)
				// and be wrapped in the DECSACE begin/end markers.
				if (plan.sequence.length > 0) {
					expect(outputBytes).toBeLessThan(inputBytes);
					expect(plan.sequence.startsWith(DECSACE_RECT)).toBe(true);
					expect(plan.sequence.endsWith(DECSACE_DEFAULT)).toBe(true);
				}
			},
		);
	});

	/**
	 * The harness's own contract, because every case above trusts it. A `fill` row must end EXACTLY
	 * at the case's width, which is the only condition under which the analysis takes its non-null
	 * path; if the renderer got that wrong the fuzz cases would still pass while testing nothing.
	 */
	it("renders a fillable row that ends exactly at the width", () => {
		const line = renderRow({ kind: "fill", contentCols: 3, bg: 0 }, 10);

		expect(line).toBe(`xxx\x1b[41m${" ".repeat(7)}\x1b[0m`);
		expect(analyzeBgFillLine(line, 10)).not.toBeNull();
	});

	/**
	 * Shrinking the width must not produce an impossible row. `contentCols` is remembered from the
	 * original case, so a halved width would ask for negative padding if the renderer did not clamp
	 * it, and `" ".repeat(-1)` throws -- reported as a parser crash that never happened.
	 */
	it("clamps content to the width so a shrunk case still renders", () => {
		expect(() => renderRow({ kind: "fill", contentCols: 80, bg: 1 }, 4)).not.toThrow();
		expect(renderRow({ kind: "fill", contentCols: 80, bg: 1 }, 4)).toBe("xxxx\x1b[48;5;22m\x1b[0m");
	});

	/** Every simplification is a frame the generator could have produced, and renders. */
	it("only simplifies to frames that still render", () => {
		const frame: FrameCase = {
			width: 20,
			rows: [
				{ kind: "fill", contentCols: 5, bg: 0 },
				{ kind: "junk", fragments: [0, 1, 2, 3] },
			],
			minRun: 4,
		};

		const candidates = simplifyFrame(frame);
		expect(candidates.length).toBeGreaterThan(0);
		// Dropping a whole row comes first, because it removes the most.
		expect(candidates[0]?.rows.map(row => row.kind)).toEqual(["junk"]);

		for (const candidate of candidates) {
			expect(candidate.width).toBeGreaterThanOrEqual(1);
			for (const row of candidate.rows) expect(() => renderRow(row, candidate.width)).not.toThrow();
		}
	});

	/** Terminates on the smallest frame there is, rather than proposing itself forever. */
	it("proposes nothing to simplify for an already-minimal frame", () => {
		expect(simplifyFrame({ width: 1, rows: [], minRun: 0 })).toEqual([]);
	});
});
