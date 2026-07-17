/**
 * Brand conformance for the default dark theme (titanium).
 *
 * The Veyyon brand is specific and load-bearing: a pitch-black ground
 * (#000000) everywhere — no tinted or raised panels, no colored state
 * backgrounds — with silver (#C6CBD4) as the structural/brand color and
 * ember (#F0862E, the website's sun accent) as the single accent, carried
 * by links, the accent border, and the selection glow (#241510, the one
 * permitted non-black surface). These asserts lock that model so a theme
 * edit that reintroduces a non-black panel background, drifts the silver,
 * or drops the ember accent fails here instead of silently shipping an
 * off-brand default. Reference implementation: website/site.css :root.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EMBER as SUN_EMBER_RAMP } from "@veyyon/pi-coding-agent/modes/components/sun";
import { SILVER_STOPS } from "@veyyon/pi-coding-agent/modes/components/welcome";
import { getThemeByName } from "@veyyon/pi-coding-agent/modes/theme/theme";

const BLACK = "#000000";
const BRAND_SILVER = "#C6CBD4";
const EMBER = "#F0862E";
const EMBER_GLOW = "#241510";

/** Parse a `--token:#hex` custom property out of website/site.css :root. */
function websiteToken(css: string, token: string): string {
	const match = css.match(new RegExp(`--${token}\\s*:\\s*(#[0-9a-fA-F]{6})`));
	expect(match, `website/site.css must define --${token}`).not.toBeNull();
	return match![1].toUpperCase();
}

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

	// Diff rows are pure signal color on the black ground: added/removed carry
	// the same green/red as success/error (website parity below pins those to
	// site.css), context is the dim silver, and no toolDiff*Bg token exists in
	// the schema so a fill can never be reintroduced through the theme.
	it("renders diffs as green/red signal plus dim context, with no background fill tokens", async () => {
		const theme = await titanium();
		expect(theme.getColorHex("toolDiffAdded")).toBe(theme.getColorHex("success"));
		expect(theme.getColorHex("toolDiffRemoved")).toBe(theme.getColorHex("error"));
		expect(theme.getColorHex("toolDiffContext")).toBe(theme.getColorHex("muted"));
		const schema = JSON.parse(
			fs.readFileSync(path.join(import.meta.dir, "../src/modes/theme/theme-schema.json"), "utf-8"),
		);
		const schemaKeys = JSON.stringify(schema);
		expect(schemaKeys).not.toContain("toolDiffAddedBg");
		expect(schemaKeys).not.toContain("toolDiffRemovedBg");
		expect(schemaKeys).not.toContain("toolDiffContextBg");
	});

	it("classifies as a dark theme", async () => {
		const theme = await titanium();
		expect(theme.isLight).toBe(false);
	});

	// The light theme is titanium's inverse (docs/internal/brand.md, Light
	// ground): one white ground with no tinted panels, dark-silver structure,
	// ember accent family, semantic trio re-tuned for contrast on white — and
	// still no blue anywhere.
	it("keeps the light theme on-brand: white ground, silver structure, ember accent", async () => {
		const theme = await getThemeByName("light");
		expect(theme).toBeDefined();
		for (const key of BLACK_BACKGROUND_KEYS) {
			expect(theme!.getBgColorHex(key)).toBe("#FFFFFF");
		}
		// Selection carries a light ember-glow tint, nothing saturated.
		expect(theme!.getBgColorHex("selectedBg").toUpperCase()).toBe("#FBE9D9");
		// Structure is a dark silver (equal-ish RGB channels), never a hue.
		const accent = theme!.getColorHex("accent");
		const [r, g, b] = [accent.slice(1, 3), accent.slice(3, 5), accent.slice(5, 7)].map(c => parseInt(c, 16));
		expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(24);
		// Links carry the ember family; the accent border keeps the true ember.
		expect(theme!.getColorHex("mdLink").toUpperCase()).toBe("#B65E14");
		expect(theme!.getColorHex("borderAccent").toUpperCase()).toBe(EMBER);
		expect(theme!.isLight).toBe(true);
	});

	// `link` is optional in theme JSON; a theme without it must inherit mdLink
	// (light.json and ~46 bundled themes omit it), never throw or paint blank.
	it("falls back to mdLink for themes that do not define the link color", async () => {
		const theme = await getThemeByName("light");
		expect(theme).toBeDefined();
		expect(theme!.getColorHex("link")).toBe(theme!.getColorHex("mdLink"));
	});

	// The website is the brand's reference implementation (brand.md contract:
	// "when this page and the website disagree, the website wins"). These
	// asserts pin every shared token to the site.css :root value so the two
	// shipped surfaces cannot silently drift apart again.
	// The two animation ramps carry brand hexes as raw RGB stops (gradients
	// can't interpolate theme tokens). Pin the brand-bearing stops to the
	// website owner so the ramps are locked copies, not silent divergence.
	it("keeps the shimmer and sun ramp brand stops in parity with site.css", () => {
		const css = fs.readFileSync(path.join(import.meta.dir, "../../../website/site.css"), "utf-8");
		const hex = (stop: readonly [number, number, number]) =>
			`#${stop.map(channel => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
		expect(hex(SILVER_STOPS[1]!)).toBe(websiteToken(css, "silver"));
		expect(hex(SILVER_STOPS[2]!)).toBe(websiteToken(css, "silver-hi"));
		expect(hex(SUN_EMBER_RAMP[4]!)).toBe(websiteToken(css, "sun"));
		expect(hex(SUN_EMBER_RAMP[5]!)).toBe(websiteToken(css, "sun-hi"));
	});

	it("matches the website reference tokens (site.css :root parity)", async () => {
		const theme = await titanium();
		const css = fs.readFileSync(path.join(import.meta.dir, "../../../website/site.css"), "utf-8");
		expect(theme.getColorHex("accent").toUpperCase()).toBe(websiteToken(css, "silver"));
		expect(theme.getColorHex("mdHeading").toUpperCase()).toBe(websiteToken(css, "silver-hi"));
		expect(theme.getColorHex("borderAccent").toUpperCase()).toBe(websiteToken(css, "sun"));
		expect(theme.getColorHex("success").toUpperCase()).toBe(websiteToken(css, "green"));
		expect(theme.getColorHex("warning").toUpperCase()).toBe(websiteToken(css, "amber"));
		expect(theme.getColorHex("error").toUpperCase()).toBe(websiteToken(css, "red"));
		// Ember stays distinct from the amber warning color on both surfaces.
		expect(websiteToken(css, "sun")).not.toBe(websiteToken(css, "amber"));
	});
});
