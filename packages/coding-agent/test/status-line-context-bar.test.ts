/**
 * The growing context bar — the quiet zone's replacement for `88.7%/231K ⟲`,
 * built to the user's spec ("a growing horizontal bar ... that pulses, with
 * major fills"): 8 cells, filled cells in the usage-level hue from the ONE
 * getContextUsageThemeColor owner, reached major-fill cells (25/50/75/~90%)
 * locked gold, a breathing brand-pixel tip at the frontier, dim rest cells,
 * and the auto-compaction mark changed from ⟲ to a session-accent ∞.
 *
 * Locks:
 *  1. Geometry: always exactly 8 visible cells, at 0%, mid-fill, and 100%.
 *  2. Fill math floors (no cell lights before its 12.5% is really used).
 *  3. Major cells paint matchHighlight gold once reached; ordinary filled
 *     cells carry the level hue; rest cells are dim ▱.
 *  4. The tip breathes through the brand frames ░▒▓█▓▒ as wall time advances,
 *     and doubles its cadence at the error level (the urgency signal).
 *  5. Error level drops the gold majors — the whole bar goes alarm, nothing
 *     distracts from red.
 *  6. The unicode auto-compaction icon is ∞ (the user rejected ⟲).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderContextBar } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

function cells(bar: string): string {
	return stripVTControlCharacters(bar);
}

describe("context bar", () => {
	beforeAll(() => {
		initTheme();
	});

	it("renders exactly 8 visible cells at every fill level", () => {
		for (const ratio of [0, 0.061, 0.37, 0.5, 0.87, 0.999, 1]) {
			expect(cells(renderContextBar(ratio, "normal", 0, false))).toHaveLength(8);
		}
	});

	it("floors the fill: a cell lights only once its full 12.5% is used", () => {
		// 12.4% < 1/8 — no solid cell yet, only the breathing tip at cell 0.
		expect(cells(renderContextBar(0.124, "normal", 0, true))).toMatch(/^[░▒▓█]▱{7}$/);
		// 37.5% — exactly 3 solid cells, tip at cell 3.
		expect(cells(renderContextBar(0.375, "normal", 0, true))).toMatch(/^▰{3}[░▒▓█]▱{4}$/);
		// Full — all solid, no tip left to breathe.
		expect(cells(renderContextBar(1, "normal", 0, false))).toBe("▰".repeat(8));
	});

	it("locks reached major cells in gold and leaves rest cells dim", () => {
		// 60% fills cells 0..3 — majors 1 and 3 (25%, 50% edges) are reached.
		// Level "normal" keeps the level hue (silver) distinct from gold; at
		// "warning" titanium's matchHighlight and warning share the same gold,
		// which would make this count degenerate.
		const bar = renderContextBar(0.6, "normal", 0, false);
		const gold = theme.fg("matchHighlight", "▰");
		const dim = theme.fg("dim", "▱");
		expect(bar.split(gold).length - 1).toBe(2);
		expect(bar).toContain(dim);
		// Ordinary filled cells carry the level hue, not gold.
		expect(bar).toContain(theme.fg("statusLineContext", "▰"));
	});

	it("breathes the tip through the brand frames as wall time advances", () => {
		const seen = new Set<string>();
		for (let step = 0; step < 6; step++) {
			const frame = cells(renderContextBar(0.375, "normal", step * 1000, true))[3];
			expect("░▒▓█").toContain(frame as string);
			seen.add(frame as string);
		}
		// A full cycle visits every distinct brand glyph (▓/▒ repeat inside it).
		expect(seen).toEqual(new Set(["░", "▒", "▓", "█"]));
	});

	it("doubles the breath cadence at the error level", () => {
		// Same instant: error has advanced twice as many frames as normal.
		const at = 3000;
		const normalTip = cells(renderContextBar(0.375, "normal", at, true))[3];
		const urgentTip = cells(renderContextBar(0.375, "error", at, true))[3];
		expect(normalTip).toBe("█"); // frame 3 of ░▒▓█▓▒
		expect(urgentTip).toBe("░"); // frame 6 wraps to 0
	});

	it("drops the gold majors at the error level — the bar goes all alarm", () => {
		const bar = renderContextBar(0.95, "error", 0, false);
		expect(bar).not.toContain(theme.fg("matchHighlight", "▰"));
		expect(bar).toContain(theme.fg("error", "▰"));
	});

	/** The user's exact complaint: the ⟲ auto-compaction mark "could be better
	 * and more unique". The unicode preset now carries ∞ — auto-compaction as
	 * the endless session — and ⟲ must never come back. */
	it("uses ∞ for the auto-compaction icon, never ⟲", () => {
		expect(theme.icon.auto).toBe("∞");
	});

	/** Motion means "the model is working right now" — the spinner's contract.
	 * The first shipped bar breathed on an IDLE screen, signalling activity
	 * that did not exist (the same logic error as the wall-clock timer that
	 * ticked before the model ever started). At rest the bar must be a pure
	 * function of the data: byte-identical at any wall time. */
	it("is time-invariant at rest — no motion on an idle screen", () => {
		for (const ratio of [0.06, 0.375, 0.87]) {
			const at0 = renderContextBar(ratio, "normal", 0, false);
			for (const t of [500, 1000, 3000, 60_000, 3_600_000]) {
				expect(renderContextBar(ratio, "normal", t, false)).toBe(at0);
			}
		}
	});

	/** At rest the frontier cell is DATA: the next cell's fractional fill in
	 * quarter steps (▱ under 25%, then ░ ▒ ▓), so a static bar still reads
	 * more finely than 12.5% cells. */
	it("encodes the fractional cell fill in the resting tip", () => {
		// 0.375 → 3 cells exactly, next cell 0% full: dim ▱.
		expect(cells(renderContextBar(0.375, "normal", 0, false))).toBe("▰▰▰▱▱▱▱▱");
		// 0.42 → 3 cells + 36% of the next: ░.
		expect(cells(renderContextBar(0.42, "normal", 0, false))).toBe("▰▰▰░▱▱▱▱");
		// 0.44 → 3 cells + 52% of the next: ▒.
		expect(cells(renderContextBar(0.44, "normal", 0, false))).toBe("▰▰▰▒▱▱▱▱");
		// 0.48 → 3 cells + 84% of the next: ▓.
		expect(cells(renderContextBar(0.48, "normal", 0, false))).toBe("▰▰▰▓▱▱▱▱");
	});
});
