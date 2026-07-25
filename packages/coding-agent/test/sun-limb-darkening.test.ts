import { describe, expect, it } from "bun:test";
import { EMBER, sunMark } from "@veyyon/coding-agent/modes/components/sun";

/**
 * The sun is drawn as eight stepped ember bands, never a smooth gradient, and
 * the whole brand rests on that ramp being VISIBLE. This suite pins how the
 * mark's lit cells distribute across those bands.
 *
 * The bug it locks out: `base` fell off only across the outer rim
 * (`1 - smoothstep(0.72, 1.02, d)`), so every cell inside 0.72R sat at exactly
 * 1.0 and selected the top band. At the 26-column mark that was 46 of 92 lit
 * cells in band 7 while bands 3 and 4 got 5 and 4 between them. The ramp the
 * brand is built on was invisible at the size where it matters most, and the
 * disc read as a cream blob.
 *
 * Nothing caught it, because every existing sun test asserts geometry (line
 * count, cell width, lit-cell growth during the bloom) and geometry was always
 * correct. A saturated disc is exactly as tall, as wide and as lit as a
 * well-graded one. So the distribution needs its own assertions, and they are
 * exact counts rather than "uses more than one band": a regression that put 40
 * of 85 cells in the top band would satisfy any looser check.
 */
describe("the sun mark's ember bands", () => {
	const BANDS = EMBER.map(([r, g, b]) => `${r};${g};${b}`);

	/**
	 * Lit cells per ember band, counted from the rendered escapes.
	 *
	 * Reads the truecolor SGR that precedes each run and matches it against the
	 * EMBER ramp itself, so the count follows the palette rather than restating
	 * it. Spaces inside a run are ground, not glyphs, and are not counted.
	 */
	function bandHistogram(lines: string[]): { counts: number[]; lit: number } {
		const counts = new Array(EMBER.length).fill(0);
		let lit = 0;
		for (const line of lines) {
			for (const segment of line.split("\x1b[38;2;").slice(1)) {
				const match = /^(\d+;\d+;\d+)m([^\x1b]*)/.exec(segment);
				if (!match) continue;
				const glyphs = match[2].replaceAll(" ", "").length;
				if (glyphs === 0) continue;
				lit += glyphs;
				const band = BANDS.indexOf(match[1]);
				expect(band, `rendered colour ${match[1]} is not a stop on the EMBER ramp`).toBeGreaterThanOrEqual(0);
				counts[band] += glyphs;
			}
		}
		return { counts, lit };
	}

	/** The resting logo-slot mark: the size the disc is actually shipped at. */
	const restingMark = () => sunMark(26, 9, { trueColor: true });

	/**
	 * The exact distribution, band by band. Written out rather than summarised
	 * because the failure this replaces was a specific misallocation, and only a
	 * per-band count says WHICH bands lost their cells.
	 */
	it("spreads its lit cells across every band instead of saturating the hottest", () => {
		const { counts, lit } = bandHistogram(restingMark());
		expect(lit).toBe(85);
		expect(counts).toEqual([1, 4, 7, 10, 10, 14, 19, 20]);
	});

	/**
	 * The property behind the numbers above, stated so a future retune has a rule
	 * to satisfy rather than a table to copy. The top band held exactly half the
	 * disc before; a quarter is the ceiling that keeps the ramp readable.
	 */
	it("keeps the hottest band under a quarter of the disc", () => {
		const { counts, lit } = bandHistogram(restingMark());
		expect(counts[7] / lit).toBeLessThan(0.25);
	});

	/**
	 * Limb darkening must not cost the sun its core. A term that dimmed the centre
	 * too far would satisfy every spread assertion above and leave a disc with no
	 * hot middle at all, which is the opposite failure and just as wrong.
	 */
	it("still reaches the hottest band at the core", () => {
		const { counts } = bandHistogram(restingMark());
		expect(counts[7]).toBeGreaterThan(0);
	});

	/**
	 * Every band is used. A ramp with a gap in it is a ramp with fewer steps, and
	 * the dark rim stops (0 and 1) are the ones a rim-only falloff starves first.
	 */
	it("uses all eight bands, including the dark rim", () => {
		const { counts } = bandHistogram(restingMark());
		for (const [band, count] of counts.entries()) {
			expect(count, `band ${band} has no cells`).toBeGreaterThan(0);
		}
	});

	/**
	 * Brightness must fall from the core outward. The histogram alone cannot say
	 * that: the same counts could come from a disc that is dark in the middle and
	 * bright at the edge. This measures the mean band of the inner cells against
	 * the outer ones on the mark's centre row.
	 */
	it("draws its centre hotter than its edge", () => {
		const lines = restingMark();
		const centreRow = lines[Math.floor(lines.length / 2)] ?? "";
		const bands: number[] = [];
		for (const segment of centreRow.split("\x1b[38;2;").slice(1)) {
			const match = /^(\d+;\d+;\d+)m([^\x1b]*)/.exec(segment);
			if (!match) continue;
			const band = BANDS.indexOf(match[1]);
			for (const ch of match[2]) if (ch !== " ") bands.push(band);
		}
		expect(bands.length).toBeGreaterThan(6);
		const edge = Math.round(bands.length / 4);
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		const inner = mean(bands.slice(edge, bands.length - edge));
		const outer = mean([...bands.slice(0, edge), ...bands.slice(bands.length - edge)]);
		expect(inner).toBeGreaterThan(outer);
	});

	/**
	 * Geometry is unchanged. The fix touches brightness only, and the existing
	 * splash suites assert line count and cell width elsewhere; this pins that a
	 * brightness change did not quietly resize the mark.
	 */
	it("leaves the mark's dimensions alone", () => {
		const lines = restingMark();
		expect(lines).toHaveLength(9);
		for (const line of lines) {
			expect([...line.replaceAll(/\x1b\[[0-9;]*m/g, "")]).toHaveLength(26);
		}
	});
});
