/**
 * Brand conformance for the default dark theme (titanium).
 *
 * The Veyyon brand is specific and load-bearing: a pitch-black ground
 * (#000000) everywhere — no tinted or raised panels, no colored state
 * backgrounds — with silver (#B8BDC7) as the structural/brand color and
 * ember (#F0862E, the website's sun accent) as the single accent, carried
 * by links, the accent border, and the selection glow (#241510, the one
 * permitted non-black surface). These asserts lock that model so a theme
 * edit that reintroduces a non-black panel background, drifts the silver,
 * or drops the ember accent fails here instead of silently shipping an
 * off-brand default. Reference implementation: website/site.css :root.
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/pi-coding-agent/modes/theme/theme";

const BLACK = "#000000";
const BRAND_SILVER = "#B8BDC7";
const EMBER = "#F0862E";
const EMBER_GLOW = "#241510";

// Every paintable background surface must stay pitch black, except the
// selection surface, which carries the ember glow tint.
const BLACK_BACKGROUND_KEYS = [
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
	it("paints every non-selection background surface pitch black", async () => {
		const theme = await titanium();
		for (const key of BLACK_BACKGROUND_KEYS) {
			expect(theme.getBgColorHex(key)).toBe(BLACK);
		}
	});

	it("tints the selection surface with the ember glow, nothing brighter", async () => {
		const theme = await titanium();
		expect(theme.getBgColorHex("selectedBg").toUpperCase()).toBe(EMBER_GLOW);
	});

	it("uses brand silver for the primary accent and structural border tone", async () => {
		const theme = await titanium();
		expect(theme.getColorHex("accent").toUpperCase()).toBe(BRAND_SILVER);
	});

	it("carries the ember accent on links and the accent border (website parity)", async () => {
		const theme = await titanium();
		expect(theme.getColorHex("mdLink").toUpperCase()).toBe(EMBER);
		expect(theme.getColorHex("link").toUpperCase()).toBe(EMBER);
		expect(theme.getColorHex("borderAccent").toUpperCase()).toBe(EMBER);
		// The accent stays silver — ember is the highlight, never a primary fill.
		expect(theme.getColorHex("accent").toUpperCase()).not.toBe(EMBER);
	});

	it("classifies as a dark theme", async () => {
		const theme = await titanium();
		expect(theme.isLight).toBe(false);
	});
});
