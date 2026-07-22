/**
 * renderSliderLines — the ONE owner of the segment-slider line (TOUCH-2).
 * The plan-review model slider and the hook selector previously each
 * hand-rolled this line with raw `◂` / `▸` / `↳` literals, which (a) drifted
 * as two copies and (b) ignored the symbol presets, handing an ascii terminal
 * glyphs it cannot render. The arrows now route through `theme.nav.prev` /
 * `theme.nav.next` and the detail hook through `theme.tree.hook`.
 *
 * Locks:
 *  1. Unicode preset renders the approved ◂ / ▸ arrows, accent when a step
 *     exists in that direction and dim at the ends.
 *  2. The ascii preset degrades every glyph to renderable ascii (< > `-),
 *     with no unicode arrow leaking through.
 *  3. The active segment's detail renders on a hooked second line; absent
 *     detail renders a single line.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderSliderLines } from "@veyyon/coding-agent/modes/components/segment-track";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { createTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";

const titanium = defaultThemes.titanium as ThemeJson;

function useTheme(preset: "unicode" | "ascii"): void {
	setThemeInstance(createTheme(titanium, { mode: "truecolor", symbolPresetOverride: preset }));
}

const SEGMENTS = [
	{ label: "fast", detail: "haiku tier" },
	{ label: "base" },
	{ label: "max", detail: "opus tier" },
];

describe("renderSliderLines — one slider owner, preset-safe glyphs", () => {
	beforeAll(() => useTheme("unicode"));
	afterAll(() => useTheme("unicode"));

	it("renders ◂/▸ arrows from the unicode preset with end-state dimming", () => {
		useTheme("unicode");
		const [line] = renderSliderLines(SEGMENTS, 0, "tier");
		expect(Bun.stripANSI(line!)).toContain("◂");
		expect(Bun.stripANSI(line!)).toContain("▸");
		// activeIndex 0: no previous step, the ◂ paints dim, the ▸ accent.
		const dimOpen = "[38;2;86;95;119m"; // titanium dim #565F77
		expect(line!).toContain(`${dimOpen}◂`);
		expect(line!).not.toContain(`${dimOpen}▸`);
	});

	it("degrades to pure ascii under the ascii preset — no unicode arrows leak", () => {
		useTheme("ascii");
		const lines = renderSliderLines(SEGMENTS, 0, "tier");
		const plain = lines.map(l => Bun.stripANSI(l)).join("\n");
		expect(plain).not.toContain("◂");
		expect(plain).not.toContain("▸");
		expect(plain).not.toContain("↳");
		expect(plain).toContain("<");
		expect(plain).toContain(">");
		expect(plain).toContain("`-");
	});

	it("hooks the active segment's detail onto a second line", () => {
		useTheme("unicode");
		const lines = renderSliderLines(SEGMENTS, 2);
		expect(lines).toHaveLength(2);
		expect(Bun.stripANSI(lines[1]!)).toContain("opus tier");
		expect(Bun.stripANSI(lines[1]!)).toContain("└");
	});

	it("renders a single line when the active segment has no detail", () => {
		useTheme("unicode");
		expect(renderSliderLines(SEGMENTS, 1)).toHaveLength(1);
	});
});
