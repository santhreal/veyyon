// WHY
//
// THE DEFECT. `spliceAtColumns` walks a row's existing escapes with a `g`-flagged regex so it can
// splice band colours between cells without landing inside an escape. That regex was compiled per
// call, which is a fresh `lastIndex` per call and therefore correct by accident. Compiling it once
// for the process — which is what a per-row allocation on every painted row of every frame is worth
// removing — makes `lastIndex` survive from one row to the next, and a walk that starts partway
// through a row skips the escapes before that point. The band is then spliced INTO an escape
// sequence, which does not render as a colour boundary; it renders as the escape's own bytes
// printed as text across the row.
//
// THE CLASS. One shared mutable matcher read by a function called once per row per frame. The
// property that closes it is not "the regex is reset" — that is the implementation — it is that
// painting a row yields the same bytes no matter what was painted before it. Any future shared
// matcher, cache, or cursor in this path breaks that property, not just this one.
//
// The suite drives the real exported `paintBand` against the real titanium theme built truecolor on
// purpose: the splice branch only runs in truecolor, and a suite that trusts the CI terminal's
// capability silently asserts the flat-band branch instead and stays green while the walk is
// broken. `setAnsiPolicy("full")` is required for the same reason — a runtime with no TTY emits no
// colour at all and every assertion would compare nothing to nothing.
//
// MUTATIONS THIS CATCHES: dropping the `lastIndex` reset; dropping the matcher's `g` flag, which
// makes `exec` return the first match forever and the walk never terminate; narrowing the pattern
// so an OSC closed by ST stops counting as an escape.
//
// ONE MUTATION IS EQUIVALENT, and a reader who tries it should not go looking for the hole. Seeding
// `lastIndex` to 1 instead of 0 changes nothing observable: the only escape it can skip is one at
// index 0, that escape then sits at the START of the run handed to the column slicer, and the SGR
// carry the slicer appends reproduces exactly the bytes it skipped. A skipped escape in the MIDDLE
// of a run is the shape that corrupts, and no `lastIndex` seed can produce one.
//
// WHAT IT DOES NOT CATCH: which colours the ramp chooses, and where the boundaries land. Those are
// owned by the two mixing suites next to this file. This one asserts only that the answer does not
// depend on history, and that a styled row gets its own bytes back.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, paintBand, setThemeInstance, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme-class";
import { getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";

const originalColorterm = Bun.env.COLORTERM;
const originalAnsiPolicy = getAnsiPolicy();
let originalTheme: Theme | undefined;

/**
 * Rows that already carry their own escapes, which is the only shape whose walk consumes the
 * matcher. Lengths differ on purpose: a short row painted after a long one is where a surviving
 * `lastIndex` lands past every escape the short row has.
 */
const STYLED_ROWS = [
	`\x1b[38;5;12mblue label\x1b[39m and plain tail that runs on for a while`,
	`\x1b[1mbold\x1b[22m`,
	`\x1b[38;2;10;20;30mtruecolor\x1b[39m\x1b[4munderline\x1b[24m mid`,
	`plain leading text \x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\ trailing`,
	`\x1b[7mshort\x1b[27m`,
] as const;

/**
 * The cells a row prints, with every escape removed. Matches the same shapes the painter's own
 * walk recognises, so a sequence the walk broke in half shows up here as leftover text.
 */
function visibleText(row: string): string {
	return row.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[@-Z\\-_])/g, "");
}

/**
 * The row with background SGRs removed. A band on a STYLED row adds nothing else: the label lift
 * is refused outright for a row carrying its own escapes, and every insert is a background fill or
 * the closing reset. So this is the exact inverse of painting one, and anything left over — a
 * foreground carry a column slicer appended, a broken sequence — is the band having changed bytes
 * that were the caller's.
 */
function withoutBandBackground(row: string): string {
	return row.replace(/\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+|49)m/g, "");
}

beforeAll(async () => {
	originalTheme = theme;
	setAnsiPolicy("full");
	Bun.env.COLORTERM = "truecolor";
	const loaded = await getThemeByName("titanium");
	if (!loaded) throw new Error("titanium theme unavailable in test env");
	if (loaded.getColorMode() !== "truecolor") {
		throw new Error(`titanium built as ${loaded.getColorMode()}, wanted truecolor`);
	}
	setThemeInstance(loaded);
});

afterAll(() => {
	setAnsiPolicy(originalAnsiPolicy);
	if (originalColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
	// The theme is a process-wide binding, so a suite that switches it and walks away decides the
	// colours every later file renders in. Put back the one that was live on entry.
	if (originalTheme !== undefined) setThemeInstance(originalTheme);
});

describe("painting a band on a styled row does not depend on the row before it", () => {
	it("paints a row the same way whichever row was painted before it", () => {
		// Each row's answer in isolation, taken first so no other row has been walked.
		const alone = new Map<string, string>();
		for (const row of STYLED_ROWS) alone.set(row, paintBand(row, "selectedBg", 0.6));

		// The same rows again, now each preceded by every other row — the frame's actual order.
		for (const previous of STYLED_ROWS) {
			for (const row of STYLED_ROWS) {
				const baseline = alone.get(row);
				if (baseline === undefined) throw new Error(`no baseline for ${JSON.stringify(row)}`);
				paintBand(previous, "selectedBg", 0.6);
				expect(paintBand(row, "selectedBg", 0.6), `${JSON.stringify(row)} after ${JSON.stringify(previous)}`).toBe(
					baseline,
				);
			}
		}
	});

	it("repeats byte for byte when the same row is painted many times", () => {
		for (const row of STYLED_ROWS) {
			const first = paintBand(row, "selectedBg", 1);
			for (let repeat = 0; repeat < 4; repeat++) {
				expect(paintBand(row, "selectedBg", 1), JSON.stringify(row)).toBe(first);
			}
		}
	});

	it("keeps the row's own escapes and its printed width whatever preceded it", () => {
		for (const previous of STYLED_ROWS) {
			for (const row of STYLED_ROWS) {
				paintBand(previous, "selectedBg", 0.4);
				const painted = paintBand(row, "selectedBg", 0.4);
				// A skipped escape is spliced into rather than around, so its bytes stop being an
				// escape and start being cells. Width is what notices that.
				expect(visibleWidth(painted), `${JSON.stringify(row)} after ${JSON.stringify(previous)}`).toBe(
					visibleWidth(row),
				);
				// The row's own styling is the caller's, and the band never rewrites it.
				for (const sgr of row.match(/\x1b\[[0-9;]*m/g) ?? []) {
					expect(painted, `${JSON.stringify(sgr)} in ${JSON.stringify(row)}`).toContain(sgr);
				}
			}
		}
	});

	it("prints the row's own text and nothing else, whatever the walk did", () => {
		// The strongest thing a caller can ask of a band: it adds colour and no cells. A splice that
		// lands INSIDE one of the row's own escapes breaks that escape in half — the tail stops being
		// an escape and starts being printed characters — so comparing the visible text catches a
		// mis-positioned insert that a width check can miss when the halves happen to cancel.
		for (const row of STYLED_ROWS) {
			const painted = paintBand(row, "selectedBg", 0.6);
			expect(visibleText(painted), JSON.stringify(row)).toBe(visibleText(row));
		}
	});

	it("adds background and gives the row's own bytes back untouched", () => {
		// Width and visible text both survive a walk that hands an escape-bearing run to the column
		// slicer, because the SGR carry it appends is invisible to either. This is the assertion that
		// sees it: remove what a band is allowed to add, and the caller's row must be left exactly.
		for (const strength of [0.2, 0.6, 1]) {
			for (const row of STYLED_ROWS) {
				const painted = paintBand(row, "selectedBg", strength);
				expect(withoutBandBackground(painted), `${JSON.stringify(row)} at ${strength}`).toBe(row);
			}
		}
	});
});
