/**
 * Brand conformance for the default dark theme (titanium).
 *
 * The Veyyon brand is specific and load-bearing: a pitch-black ground
 * (#000000) *everywhere* — no tinted or raised panels, no colored state
 * backgrounds — with silver (#B8BDC7) as the structural/brand color and a
 * sparing deep blue (#4A84C9) reserved for highlights (links, active state).
 * These asserts lock that model so a future theme edit that reintroduces a
 * non-black panel background, or drifts the brand silver/blue, fails here
 * instead of silently shipping an off-brand default.
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/pi-coding-agent/modes/theme/theme";

const BLACK = "#000000";
const BRAND_SILVER = "#B8BDC7";
const HIGHLIGHT_BLUE = "#4A84C9";

// The full ThemeBg set — every paintable background surface in the UI.
const BACKGROUND_KEYS = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"statusLineBg",
] as const;

async function titanium() {
	const theme = await getThemeByName("titanium");
	expect(theme).toBeDefined();
	return theme!;
}

describe("brand conformance (titanium, the default dark theme)", () => {
	it("paints every background surface pitch black", async () => {
		const theme = await titanium();
		for (const key of BACKGROUND_KEYS) {
			expect(theme.getBgColorHex(key)).toBe(BLACK);
		}
	});

	it("uses brand silver for the primary accent and structural border tone", async () => {
		const theme = await titanium();
		expect(theme.getColorHex("accent").toUpperCase()).toBe(BRAND_SILVER);
	});

	it("reserves the deep blue strictly for highlights (links), never the accent", async () => {
		const theme = await titanium();
		expect(theme.getColorHex("mdLink").toUpperCase()).toBe(HIGHLIGHT_BLUE);
		// The accent must not be the highlight blue — blue is a sparing highlight,
		// not a primary fill.
		expect(theme.getColorHex("accent").toUpperCase()).not.toBe(HIGHLIGHT_BLUE);
	});

	it("classifies as a dark theme", async () => {
		const theme = await titanium();
		expect(theme.isLight).toBe(false);
	});
});
