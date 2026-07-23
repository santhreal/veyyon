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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { CardPadRow, ComposerHairline, QuietZoneLine } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { setShimmerActivity } from "@veyyon/coding-agent/modes/theme/shimmer";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui/utils";

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

describe("CardPadRow — the card's vertical body", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	/**
	 * The composer has NO card (user order 2026-07-22: every painted composer
	 * box, theme token and derived tint alike, read as a gray slab on the
	 * real terminal). The pad row is pure vertical air: an empty string with
	 * zero escape bytes, regardless of what the theme's composerBg token says.
	 */
	it("paints nothing — no ground, no escapes, whatever the theme declares", () => {
		const [row] = new CardPadRow().render();
		expect(row).toBe("");
	});

	/** Chrome is silent: the pad row is pure ground — no glyphs, no foreground
	 * paint, byte-identical across wall-clock time and shimmer states. */
	it("renders identical bytes across time and shimmer activity", () => {
		settings.set("display.shimmer", "living");
		const pad = new CardPadRow();
		setSystemTime(new Date("2026-07-21T12:00:00Z"));
		const rest = pad.render();
		for (const activity of ["streaming", "ask", "error", "tool"] as const) {
			setShimmerActivity(activity);
			setSystemTime(new Date("2026-07-21T12:00:03Z"));
			expect(pad.render()).toEqual(rest);
		}
		setSystemTime();
		settings.set("display.shimmer", "disabled");
	});
});

describe("composer placeholder", () => {
	/** The idle hint read as uneven spacing: `ask anything  ·  / for commands`
	 * put DOUBLE spaces around the interpunct (user report 2026-07-22, "double
	 * wide gaps"). The placeholder lives in ONE module const routed to both
	 * the initial editor and mode-switch rebuilds; this source lock keeps the
	 * spacing single and the const the only definition site. */
	it("uses single spaces around the interpunct and one definition site", () => {
		const src = readFileSync(join(import.meta.dir, "../../../src/modes/interactive-mode.ts"), "utf8");
		expect(src).toContain('const COMPOSER_PLACEHOLDER = "ask anything · / for commands";');
		// Both setPlaceholder call sites route through the const — no literal.
		expect(src.match(/setPlaceholder\(COMPOSER_PLACEHOLDER\)/g)?.length).toBe(2);
		expect(src).not.toContain('setPlaceholder("ask anything');
		// The double-space regression itself, banned anywhere in the module.
		expect(src).not.toContain("ask anything  ·");
	});
});

describe("composer card wiring (interactive-mode)", () => {
	const src = () => readFileSync(join(import.meta.dir, "../../../src/modes/interactive-mode.ts"), "utf8");

	/** The card's vertical padding must be CardPadRow, never a bare Spacer:
	 * bare spacers render terminal ground and collapse the card to a single
	 * cramped tinted strip hugging the text (user screenshot, 2026-07-22).
	 * The mount order moved to mountComposerZone (ARCH-2), so the sandwich is
	 * locked in composer-chrome.ts and the host must delegate to it; the
	 * behavioral pin (CardPadRow, not Spacer) lives in
	 * composer-zone-mount.test.ts against the real mount function. */
	it("mounts the pad/editor/pad sandwich through the one composer-chrome owner", () => {
		const chrome = readFileSync(join(import.meta.dir, "../../../src/modes/components/composer-chrome.ts"), "utf8");
		expect(chrome).toMatch(
			/addChild\(new CardPadRow\(\)\);\s*\n\s*ui\.addChild\(parts\.editorContainer\);\s*\n\s*ui\.addChild\(new CardPadRow\(\)\)/,
		);
		expect(chrome).not.toMatch(/addChild\(new Spacer\(1\)\);\s*\n\s*ui\.addChild\(parts\.editorContainer\)/);
		// The host mounts nothing inline — one mount owner only.
		expect(src()).toContain("mountComposerZone(this.ui, {");
		expect(src()).not.toContain("addChild(new CardPadRow())");
	});

	/** The composer has NO painted ground (user order 2026-07-22: every
	 * attempt at a tinted composer box read as a gray slab on the real
	 * terminal). The input rows must carry no background, and no card owner
	 * may creep back in at any call site. */
	it("paints no ground behind the input rows — the gray box stays dead", () => {
		const text = src();
		expect(text).toContain("this.editor.setRowBackground(undefined)");
		expect(text).not.toContain("composerCardGround");
		expect(text).not.toMatch(/setRowBackground\([^)]*getBgAnsi\("composerBg"\)/);
	});

	/** The derived tints only exist if the app FEEDS the detection: the OSC 11
	 * report must reach setDetectedTerminalGround both on change and as the
	 * subscribe-time replay seed. This wiring was missing entirely once —
	 * every derived chrome color silently used its static fallback forever. */
	it("feeds the OSC 11 background report into the ground-tint owner", () => {
		const text = src();
		expect(text.match(/setDetectedTerminalGround\(/g)?.length).toBeGreaterThanOrEqual(2);
		expect(text).toMatch(/onBackgroundColorChange\?\.\(hex => \{[\s\S]{0,400}setDetectedTerminalGround\(hex\)/);
	});
});
