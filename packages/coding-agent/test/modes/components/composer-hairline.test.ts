/**
 * The composer hairline is the horizon between the transcript and the prompt.
 * Per the agreed composer design it is a WHISPER: one full-width rule in the
 * faintest structural token (`borderMuted`), and it NEVER animates.
 *
 * The animated-rule mistake shipped once — per-cell shimmer on a solid rule
 * shatters it into uneven bright segments that read as a rendering glitch —
 * and this suite exists to lock it out forever:
 *
 *  1. Geometry: exactly one line, spanning the full requested width in visible
 *     cells, so the hairline can never wrap or leave a ragged edge.
 *  2. Color: every cell carries the single `borderMuted` token — no per-cell
 *     variation, no activity hue, no hardcoded hex.
 *  3. Time-invariance: the rendered bytes are IDENTICAL at different wall-clock
 *     times and across shimmer activity states. If any motion is ever painted
 *     back onto the rule, these assertions fail.
 *
 * QuietZoneLine's indent contract (the composer inset — nothing in the
 * composer zone sits at column 0) is locked here too, since the footline's
 * left margin is part of the same agreed geometry.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { visibleWidth } from "@veyyon/tui/utils";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { ComposerHairline, QuietZoneLine } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { setShimmerActivity } from "@veyyon/coding-agent/modes/theme/shimmer";

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ComposerHairline", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		setSystemTime();
		// Restore the shipped default so later suites see a pristine setting.
		settings.set("display.shimmer", "disabled");
	});

	describe("geometry", () => {
		/** The rule must be exactly one row — a second row would double the
		 * horizon and break the composer's fixed vertical rhythm. */
		it("renders exactly one line", () => {
			expect(new ComposerHairline().render(80)).toHaveLength(1);
		});

		/** Full-bleed: every requested column is a rule cell. A short rule
		 * leaves a ragged right edge; a long one wraps and shatters the row. */
		it("spans the full requested width in visible cells", () => {
			for (const width of [1, 2, 7, 39, 80, 213]) {
				const [line] = new ComposerHairline().render(width);
				expect(visibleWidth(line ?? "")).toBe(width);
				expect(strip(line ?? "")).toBe(theme.boxSharp.horizontal.repeat(width));
			}
		});

		/** Degenerate widths must not crash or emit an empty row. */
		it("clamps width 0 and negatives to a single cell", () => {
			for (const width of [0, -5]) {
				const [line] = new ComposerHairline().render(width);
				expect(strip(line ?? "")).toBe(theme.boxSharp.horizontal);
			}
		});
	});

	describe("color — the whisper contract", () => {
		/** The agreed mockups draw the hairline tone-on-tone (near-black on
		 * black). That is the `borderMuted` token — the faintest structural
		 * color — and the WHOLE rule must carry it: one open sequence, no
		 * per-cell repaint, no other token, no hardcoded hex. */
		it("paints the entire rule with the borderMuted token only", () => {
			const [line] = new ComposerHairline().render(60);
			expect(line).toBe(theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(60)));
		});
	});

	describe("time-invariance — the shattered-rule regression lock", () => {
		/** THE regression this suite exists for: shimmer was once painted onto
		 * the rule, and per-cell luminance variation on a solid `─` row renders
		 * as a glitchy, unevenly-bright dashed line. The rule must produce
		 * byte-identical output at any wall-clock time. */
		it("renders identical bytes at different times", () => {
			const hairline = new ComposerHairline();
			setSystemTime(new Date("2026-07-21T12:00:00Z"));
			const a = hairline.render(84);
			setSystemTime(new Date("2026-07-21T12:00:00.640Z"));
			const b = hairline.render(84);
			setSystemTime(new Date("2026-07-21T12:00:07Z"));
			const c = hairline.render(84);
			expect(b).toEqual(a);
			expect(c).toEqual(a);
		});

		/** Activity states drive the working line's TEXT shimmer, never the
		 * rule: streaming, ask, and error must all leave the hairline's bytes
		 * untouched even with shimmer enabled. */
		it("ignores shimmer activity states entirely", () => {
			settings.set("display.shimmer", "living");
			const hairline = new ComposerHairline();
			setSystemTime(new Date("2026-07-21T12:00:00Z"));
			const rest = hairline.render(84);
			for (const activity of ["streaming", "ask", "error", "tool"] as const) {
				setShimmerActivity(activity);
				setSystemTime(new Date("2026-07-21T12:00:03Z"));
				expect(hairline.render(84)).toEqual(rest);
			}
		});
	});
});

describe("QuietZoneLine indent — the composer inset", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	/** The agreed design insets composer content two columns off the terminal
	 * edge. The indent must be real spaces AND the provider must be offered
	 * the reduced width, so an indented line can never overflow the row. */
	it("prefixes the indent and narrows the provider's width budget", () => {
		const seen: number[] = [];
		const line = new QuietZoneLine(width => {
			seen.push(width);
			return "abc";
		}, 2);
		expect(line.render(40)).toEqual(["  abc"]);
		expect(seen).toEqual([38]);
	});

	/** No indent (the default) must behave exactly as before the inset landed:
	 * full width offered, no prefix — the selector layouts rely on this. */
	it("defaults to zero indent with the full width budget", () => {
		const seen: number[] = [];
		const line = new QuietZoneLine(width => {
			seen.push(width);
			return "xyz";
		});
		expect(line.render(40)).toEqual(["xyz"]);
		expect(seen).toEqual([40]);
	});

	/** A null from the provider means "nothing to say" — the indent must not
	 * turn that into a blank padded row (no empty chrome). */
	it("renders nothing when the provider returns null, even with indent", () => {
		expect(new QuietZoneLine(() => null, 2).render(40)).toEqual([]);
	});

	/** Degenerate terminals: the indent clamps so at least one content column
	 * survives — padding must never consume the whole row. */
	it("clamps the indent on very narrow widths", () => {
		const line = new QuietZoneLine(width => "a".repeat(Math.max(0, width)), 2);
		const [row] = line.render(2);
		expect(row).toBe(" a");
	});
});
