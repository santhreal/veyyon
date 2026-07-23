/**
 * The growing context bar — the quiet zone's replacement for `88.7%/231K ⟲`:
 * 8 cells, filled cells in the usage-level hue from the ONE
 * getContextUsageThemeColor owner, dim ▱ rest cells, and the auto-compaction
 * mark changed from ⟲ to a session-accent ∞.
 *
 * The bar is STRICTLY two glyphs (▰/▱) and two tones (level hue / dim). The
 * first shipped design mixed shaded quarter-step glyphs (░▒▓) into the
 * outlined track as a "fractional tip" and sprinkled gold "major cells" into
 * the fill — the user read the shaded tip as a rendering artifact ("a random
 * rectangle in the middle of the context window box", 2026-07-22). The
 * adjacent percent text already carries sub-cell precision, so the tip
 * encoding was redundant data dressed as noise. This suite locks the clean
 * contract:
 *  1. Geometry: always exactly 8 visible cells, at 0%, mid-fill, and 100%.
 *  2. Fill math rounds to the nearest cell (the % text is the precise value).
 *  3. Only ▰ and ▱ ever appear — the ░▒▓█ family and gold majors are banned.
 *  4. Live (agent running): the frontier cell pulses ▰↔▱ in the same
 *     two-glyph vocabulary, doubling cadence at the error level.
 *  5. At rest the bar is byte-identical at any wall time (no idle motion).
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

	/** The resting bar is two-tone data, nothing else: rounded fill in the
	 * level hue, dim outline for the remainder. Rounding (not flooring) keeps
	 * the bar honest to the nearest cell — the % text carries the precision. */
	it("rounds the fill to the nearest cell at rest", () => {
		// 37.5% → exactly 3 cells (0.375 * 8 = 3).
		expect(cells(renderContextBar(0.375, "normal", 0, false))).toBe("▰▰▰▱▱▱▱▱");
		// 42% → 3.36 cells rounds down to 3 — NOT a shaded partial glyph.
		expect(cells(renderContextBar(0.42, "normal", 0, false))).toBe("▰▰▰▱▱▱▱▱");
		// 48% → 3.84 cells rounds up to 4.
		expect(cells(renderContextBar(0.48, "normal", 0, false))).toBe("▰▰▰▰▱▱▱▱");
		// Full — all solid.
		expect(cells(renderContextBar(1, "normal", 0, false))).toBe("▰".repeat(8));
		// Empty — all outline.
		expect(cells(renderContextBar(0, "normal", 0, false))).toBe("▱".repeat(8));
	});

	/** The regression this suite exists to prevent: the "random rectangle".
	 * No fill level, live or at rest, at any wall time, may ever emit a glyph
	 * outside the ▰/▱ pair — the ░▒▓█ shaded family reads as a paint bug when
	 * mixed into an outlined track. */
	it("emits only ▰ and ▱ — shaded glyphs are banned in every state", () => {
		for (const ratio of [0, 0.124, 0.375, 0.42, 0.44, 0.48, 0.87, 0.999, 1]) {
			for (const live of [false, true]) {
				for (const t of [0, 500, 1000, 1500, 3000]) {
					for (const level of ["normal", "warning", "error"] as const) {
						expect(cells(renderContextBar(ratio, level, t, live))).toMatch(/^[▰▱]{8}$/);
					}
				}
			}
		}
	});

	/** One hue for the fill: the old design locked "major cells" in
	 * matchHighlight gold, which read as random recoloured cells rather than
	 * anchors. The whole fill carries the level hue and nothing else. */
	it("paints every filled cell in the level hue — no gold major cells", () => {
		const bar = renderContextBar(0.6, "normal", 0, false);
		expect(bar).not.toContain(theme.fg("matchHighlight", "▰"));
		// 0.6 * 8 = 4.8 → 5 filled cells, all in the level hue.
		const hue = theme.fg("statusLineContext", "▰");
		expect(bar.split(hue).length - 1).toBe(5);
		expect(bar).toContain(theme.fg("dim", "▱"));
	});

	/** Motion means "the model is working right now" — the spinner's contract.
	 * While live, the frontier cell pulses between filled and empty in the
	 * SAME two-glyph vocabulary; no foreign glyph is introduced for motion. */
	it("pulses the frontier cell ▰↔▱ while live", () => {
		// 37.5% live: cell 3 is the frontier. Step cadence is 1000ms.
		expect(cells(renderContextBar(0.375, "normal", 0, true))).toBe("▰▰▰▰▱▱▱▱");
		expect(cells(renderContextBar(0.375, "normal", 1000, true))).toBe("▰▰▰▱▱▱▱▱");
		expect(cells(renderContextBar(0.375, "normal", 2000, true))).toBe("▰▰▰▰▱▱▱▱");
		// The pulsed-on frontier carries the level hue, the off phase is dim.
		const on = renderContextBar(0.375, "normal", 0, true);
		expect(on.split(theme.fg("statusLineContext", "▰")).length - 1).toBe(4);
	});

	it("doubles the pulse cadence at the error level", () => {
		// At t=500ms: normal (1000ms step) is still on phase 0 (tip on);
		// error (500ms step) has advanced to phase 1 (tip off).
		const normalTip = cells(renderContextBar(0.375, "normal", 500, true))[3];
		const urgentTip = cells(renderContextBar(0.375, "error", 500, true))[3];
		expect(normalTip).toBe("▰");
		expect(urgentTip).toBe("▱");
	});

	it("has no frontier pulse at 100% — nothing left to fill", () => {
		for (const t of [0, 500, 1000]) {
			expect(cells(renderContextBar(1, "normal", t, true))).toBe("▰".repeat(8));
		}
	});

	/** The first shipped bar breathed on an IDLE screen, signalling activity
	 * that did not exist. At rest the bar must be a pure function of the
	 * data: byte-identical at any wall time. */
	it("is time-invariant at rest — no motion on an idle screen", () => {
		for (const ratio of [0.06, 0.375, 0.87]) {
			const at0 = renderContextBar(ratio, "normal", 0, false);
			for (const t of [500, 1000, 3000, 60_000, 3_600_000]) {
				expect(renderContextBar(ratio, "normal", t, false)).toBe(at0);
			}
		}
	});

	/** The user's exact complaint: the ⟲ auto-compaction mark "could be better
	 * and more unique". The unicode preset now carries ∞ — auto-compaction as
	 * the endless session — and ⟲ must never come back. */
	it("uses ∞ for the auto-compaction icon, never ⟲", () => {
		expect(theme.icon.auto).toBe("∞");
	});
});
