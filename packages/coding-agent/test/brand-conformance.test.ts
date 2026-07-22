/**
 * Brand conformance for the default dark theme (titanium).
 *
 * The Veyyon brand is specific and load-bearing: a pitch-black ground
 * (#000000) everywhere — no tinted or raised panels, no colored state
 * backgrounds — with silver (#C6CBD4) as the structural/brand color and
 * ember (#F0862E, the website's sun accent) as the single accent, carried
 * by links, the accent border, and the selection surface (#241510, a dim ember
 * wash under selected text and the one permitted non-black surface). These asserts lock that model so a theme
 * edit that reintroduces a non-black panel background, drifts the silver,
 * or drops the ember accent fails here instead of silently shipping an
 * off-brand default. Reference implementation: website/site.css :root.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EMBER as SUN_EMBER_RAMP, GLYPH as SUN_GLYPH } from "@veyyon/coding-agent/modes/components/sun";
import { SILVER_STOPS } from "@veyyon/coding-agent/modes/components/welcome";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";

const BLACK = "#000000";
const BRAND_SILVER = "#C6CBD4";
const EMBER = "#F0862E";
const EMBER_SELECTION = "#241510";

/** Parse a `--token:#hex` custom property out of website/site.css :root. */
function websiteToken(css: string, token: string): string {
	const match = css.match(new RegExp(`--${token}\\s*:\\s*(#[0-9a-fA-F]{6})`));
	expect(match, `website/site.css must define --${token}`).not.toBeNull();
	return match![1].toUpperCase();
}

/**
 * Assert that a web sun renderer's inline material equals the terminal sun
 * (sun.ts). Every surface that draws the sun — the hero, the marks, the OAuth
 * callback page — must draw the identical ember ramp and glyph vocabulary, or
 * the brand fractures into several slightly-different suns. This extracts the
 * `COLORS`/`GLYPH` arrays a renderer declares and pins both to the terminal
 * `EMBER`/`GLYPH`, stop for stop. `source` names the file for the failure line.
 */
function expectSunFieldParity(js: string, source: string): void {
	const hex = (stop: readonly [number, number, number]) =>
		`#${stop.map(channel => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

	const colorsMatch = js.match(/COLORS = \[([^\]]+)\]/);
	expect(colorsMatch, `${source} must define a COLORS ramp`).not.toBeNull();
	const webColors = [...colorsMatch![1].matchAll(/#[0-9a-fA-F]{6}/g)].map(m => m[0].toUpperCase());
	expect(webColors.length, `${source}: the ember ramp has eight stops`).toBe(8);
	expect(webColors, `${source}: ember ramp equals the terminal EMBER ramp, stop for stop`).toEqual(
		SUN_EMBER_RAMP.map(hex),
	);

	const glyphMatch = js.match(/GLYPH = \[([^\]]+)\]/);
	expect(glyphMatch, `${source} must define a GLYPH ramp`).not.toBeNull();
	const webGlyphs = [...glyphMatch![1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
	expect(webGlyphs, `${source}: glyph ramp equals the terminal GLYPH ramp`).toEqual([...SUN_GLYPH]);
}

// Every paintable background surface must stay pitch black, except the
// selection surface, which carries the dim ember wash.
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

	it("tints the selection surface with a dim ember wash, nothing brighter", async () => {
		const theme = await titanium();
		expect(theme.getBgColorHex("selectedBg").toUpperCase()).toBe(EMBER_SELECTION);
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
		// Selection carries a dim ember wash, nothing saturated.
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

	// website/sun-field.js is the web-side single source: both the hero journey
	// (website/sun.js) and the structural marks (website/sunmark.js) read their
	// material from it. Pin it to the terminal sun so the web hero and the
	// terminal splash render one sun, not two copies that silently drift.
	it("keeps website/sun-field.js in parity with the terminal sun (sun.ts)", () => {
		const field = fs.readFileSync(path.join(import.meta.dir, "../../../website/sun-field.js"), "utf-8");
		expectSunFieldParity(field, "website/sun-field.js");
	});

	// The OAuth callback page (packages/ai) is served self-contained by the local
	// auth server, so it cannot import the shared source and carries its own
	// inline COLORS/GLYPH. It is the fourth surface that draws the sun; pin it too
	// so the copy it is forced to keep still cannot drift from the one sun.
	it("keeps the OAuth callback sun (oauth.html) in parity with the terminal sun", () => {
		const oauth = fs.readFileSync(
			path.join(import.meta.dir, "../../ai/src/registry/oauth/oauth.html"),
			"utf-8",
		);
		expectSunFieldParity(oauth, "packages/ai/src/registry/oauth/oauth.html");
	});

	// The three shipped web dashboards (collab-web, veybot, stats) inherited an
	// off-brand oh-my-pi identity — purple(307) grounds, a pink(341) accent,
	// a cyan(205/230) link, and a pink→purple→cyan gradient mark. They now
	// carry the same black/silver/ember system as the CLI. These asserts pin
	// the migration: no saturated color anywhere in the cyan→pink arc, the
	// ember accent present, and no multi-hue gradient mark. tokens.css /
	// index.css / styles.css are the only files in those apps allowed raw
	// color values.
	const DASHBOARD_TOKEN_FILES = [
		{ label: "collab-web", rel: "../../collab-web/src/styles/tokens.css" },
		{ label: "veybot", rel: "../../../python/veybot/web/src/styles/index.css" },
		{ label: "stats", rel: "../../stats/src/client/styles.css" },
	] as const;

	// The banned oh-my-pi mark/accent hexes: pink, violet, cyan, brand-purple,
	// lilac, and the coral chart-error red (all replaced by the ember/silver/
	// canonical-semantic system).
	const BANNED_HEXES = ["#ed4abf", "#9b4dff", "#5ad8e6", "#945ff9", "#b281d6", "#ff6b7d"] as const;

	// oklch(L C H): a saturated stop (C >= 0.03) whose hue sits in the
	// cyan→blue→purple→pink arc [175, 350) is off-brand. The brand hues —
	// ember ~52, amber ~85, green ~150, red ~25 — all fall outside it, and
	// the silver ramp (hue ~250) is neutral (C < 0.02), so it passes.
	function offBrandOklchStops(css: string): string[] {
		const hits: string[] = [];
		for (const m of css.matchAll(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)) {
			const chroma = Number.parseFloat(m[2]!);
			const hue = Number.parseFloat(m[3]!);
			if (chroma >= 0.03 && hue >= 175 && hue < 350) hits.push(m[0]);
		}
		return hits;
	}

	for (const { label, rel } of DASHBOARD_TOKEN_FILES)
		it(`keeps the ${label} dashboard free of cyan/purple/pink chrome`, () => {
			const css = fs.readFileSync(path.join(import.meta.dir, rel), "utf-8");
			expect(offBrandOklchStops(css)).toEqual([]);
			// The banned gradient/accent hexes from the oh-my-pi identity are gone.
			for (const banned of BANNED_HEXES) {
				expect(css.toLowerCase()).not.toContain(banned);
			}
			// The ember sun is present as the accent (raw #f0862e in the mark
			// bands, or the ember oklch stop hue ~52).
			const hasEmber =
				css.toLowerCase().includes("#f0862e") || /oklch\(\s*0\.7[01]\d*\s+0\.16\d*\s+5[0-9]/.test(css);
			expect(hasEmber, "dashboard must carry the ember-sun accent").toBe(true);
		});

	it("draws each dashboard brand mark as a stepped ember sun, not a multi-hue gradient", () => {
		const collab = fs.readFileSync(path.join(import.meta.dir, "../../collab-web/src/styles/tokens.css"), "utf-8");
		// The mark is a hard-stop radial (discrete bands), never a linear multi-hue sweep.
		expect(collab).toContain("--brand-mark: radial-gradient(circle");
		expect(collab).not.toContain("linear-gradient");
		const veybot = fs.readFileSync(
			path.join(import.meta.dir, "../../../python/veybot/web/src/styles/index.css"),
			"utf-8",
		);
		expect(veybot).toMatch(/\.rmp-rail-mark[^}]*radial-gradient\(circle/s);
		const stats = fs.readFileSync(path.join(import.meta.dir, "../../stats/src/client/styles.css"), "utf-8");
		expect(stats).toMatch(/\.stats-logo-container::before[^}]*radial-gradient\(circle/s);
	});

	// The collab-web favicon was the oh-my-pi π glyph in a pink→purple→cyan
	// linear gradient; it is now the stepped ember sun (concentric ember
	// circles, no gradient), a copy of website/favicon.svg.
	it("ships the stepped ember-sun favicon (no π glyph, no gradient)", () => {
		const svg = fs.readFileSync(path.join(import.meta.dir, "../../collab-web/public/favicon.svg"), "utf-8");
		// No gradient element and no gradient fill reference (the comment may
		// still say "no smooth gradient", so match markup, not the word).
		expect(svg).not.toContain("<linearGradient");
		expect(svg).not.toContain("<radialGradient");
		expect(svg).not.toContain("url(#");
		for (const banned of BANNED_HEXES) expect(svg.toLowerCase()).not.toContain(banned);
		// The four concentric ember bands of the sun.
		for (const band of ["#c8590c", "#f0862e", "#fb9e44", "#ffca80"]) expect(svg).toContain(band);
	});

	// assets/icon.svg was the inherited oh-my-pi glyph — a literal π (bar + two
	// legs) with a plugin connector, painted in Tailwind orange (#f97316). It is
	// now the same stepped ember sun as the favicon, so no repo-committed mark
	// carries the Pi identity.
	it("ships the app icon as the ember sun, not the π glyph", () => {
		const svg = fs.readFileSync(path.join(import.meta.dir, "../../../assets/icon.svg"), "utf-8");
		expect(svg.toLowerCase()).not.toContain("#f97316"); // off-brand tailwind orange
		expect(svg.toLowerCase()).not.toContain("pi symbol"); // the old mark's comment
		expect(svg).not.toContain("<linearGradient");
		expect(svg).not.toContain("<radialGradient");
		for (const band of ["#c8590c", "#f0862e", "#fb9e44", "#ffca80"]) expect(svg).toContain(band);
	});

	// assets/banner.html was the same π glyph inside "circuit trace" chrome on an
	// off-black (#050505) ground with a tailwind-emerald (#10b981) status dot. It
	// is now the ember sun on pitch black with the brand-green dot, matching the
	// collab og card's brand system.
	it("ships the brand banner as the ember sun on pitch black", () => {
		const html = fs.readFileSync(path.join(import.meta.dir, "../../../assets/banner.html"), "utf-8").toLowerCase();
		expect(html).not.toContain("pi-symbol"); // the old π class
		expect(html).not.toContain("#10b981"); // tailwind emerald status dot
		expect(html).not.toContain("#f97316"); // tailwind orange
		expect(html).not.toContain("#050505"); // off-black ground
		// The stepped ember-sun mark and the brand-green status dot.
		for (const band of ["#ffca80", "#fb9e44", "#f0862e", "#c8590c"]) expect(html).toContain(band);
		expect(html).toContain("#7fb98a"); // brand green
	});

	// tool-render.css bridges its `--tv-*` tokens to whatever host palette is
	// present (collab-web / the HTML export), each with a static fallback for
	// standalone use. Those fallbacks inherited oh-my-pi values: purple(307)
	// neutrals, a pink(341) accent, a cyan(205) ring. They are now silver-neutral
	// text with an ember accent/ring, so even an unstyled host renders on-brand.
	it("keeps the tool-render fallback tokens on the ember/silver system", () => {
		const css = fs.readFileSync(path.join(import.meta.dir, "../../tool-render/src/tool-render.css"), "utf-8");
		expect(offBrandOklchStops(css)).toEqual([]);
		for (const banned of BANNED_HEXES) expect(css.toLowerCase()).not.toContain(banned);
		// The accent + ring fallbacks are the ember stop (hue ~52).
		expect(css).toMatch(/--tv-accent:\s*var\(--accent,\s*oklch\(\s*0\.7\d*\s+0\.16\d*\s+52/);
		expect(css).toMatch(/--tv-ring:\s*var\(--ring,\s*oklch\(\s*0\.7\d*\s+0\.16\d*\s+52/);
	});

	// The mdBook handbook theme (docs/handbook/theme/veyyon.css) was a coherent
	// dark-silver theme but diverged from canonical: near-black raised panels
	// (#08090A/#050505/#0F1113) instead of pitch black, no ember accent anywhere
	// (links/markers all silver), and semantic green/amber/red at off-canonical
	// hexes (#89d281/#c9a35a/#c07070). It now uses pitch-black grounds with the
	// ember accent on links/focus/syntax-keywords and the exact canonical trio.
	it("keeps the handbook theme on pitch black with the ember accent", () => {
		const css = fs.readFileSync(path.join(import.meta.dir, "../../../docs/handbook/theme/veyyon.css"), "utf-8");
		const lower = css.toLowerCase();
		// The old raised near-black panels and off-canonical semantic hexes are gone.
		for (const stale of ["#08090a", "#0b0c0e", "#0f1113", "#101214", "#89d281", "#c9a35a", "#c07070", "#b8bdc7"]) {
			expect(lower).not.toContain(stale);
		}
		for (const banned of BANNED_HEXES) expect(lower).not.toContain(banned);
		expect(offBrandOklchStops(css)).toEqual([]);
		// The ember accent and the exact canonical semantic trio are present.
		expect(lower).toContain("#f0862e"); // ember
		expect(lower).toContain("#fb9e44"); // ember-hi
		expect(lower).toContain("#7fb98a"); // green
		expect(lower).toContain("#c9a24b"); // amber
		expect(lower).toContain("#c96f6e"); // red
		// Surfaces are pitch black — links/focus carry ember, not silver.
		expect(css).toMatch(/--vy-surface:\s*#000000/);
		expect(css).toMatch(/--links:\s*var\(--vy-ember\)/);
	});

	// The shared OAuth success page (packages/ai/src/registry/oauth/oauth.html,
	// shown after login for every provider) had two off-brand tokens: --red was
	// the coral #e2686a instead of canonical #c96f6e, and --line was a white-alpha
	// hairline rgba(255,255,255,…) where the brand uses silver-alpha. Its ground,
	// silver ramp, ember sun, and green were already canonical.
	it("keeps the OAuth success page on the canonical palette", () => {
		const html = fs
			.readFileSync(path.join(import.meta.dir, "../../ai/src/registry/oauth/oauth.html"), "utf-8")
			.toLowerCase();
		for (const banned of BANNED_HEXES) expect(html).not.toContain(banned);
		expect(html).not.toContain("#e2686a"); // coral red
		expect(html).not.toMatch(/--line:\s*rgba\(255,\s*255,\s*255/); // white-alpha hairline
		expect(html).toMatch(/--bg:\s*#000000/); // pitch black
		expect(html).toContain("#f0862e"); // ember sun
		expect(html).toContain("#c96f6e"); // canonical red
		expect(html).toMatch(/--line:\s*rgba\(198,\s*203,\s*212/); // silver-alpha hairline
	});

	// Two hex-valued brand surfaces outside the token CSS: the HTML transcript
	// export palette and the stats chart series palette. Neither may carry the
	// banned oh-my-pi hexes, and each must lead with the ember accent.
	const HEX_PALETTE_FILES = [
		{ label: "web-export palette", rel: "../src/export/html/web-palette.ts" },
		{ label: "stats chart palette", rel: "../../stats/src/client/components/chart-shared.tsx" },
	] as const;

	for (const { label, rel } of HEX_PALETTE_FILES)
		it(`keeps the ${label} on the ember/silver system`, () => {
			const src = fs.readFileSync(path.join(import.meta.dir, rel), "utf-8").toLowerCase();
			for (const banned of BANNED_HEXES) expect(src).not.toContain(banned);
			// No off-brand oklch stops either (accent-muted/ring/error wells use oklch).
			expect(offBrandOklchStops(src)).toEqual([]);
			expect(src).toContain("#f0862e");
		});

	// Route/component files hardcode chart series colors inline (Chart.js
	// datasets), so a single missed off-brand hex (e.g. the coral #ff6b7d error
	// series) can slip past the two palette-owner locks above. Sweep the whole
	// stats client tree so any banned hex in any .tsx/.css fails here.
	it("keeps the entire stats client tree free of banned hexes", () => {
		const root = path.join(import.meta.dir, "../../stats/src/client");
		const walk = (dir: string): string[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) return walk(full);
				return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
			});
		const offenders: string[] = [];
		for (const file of walk(root)) {
			const src = fs.readFileSync(file, "utf-8").toLowerCase();
			for (const banned of BANNED_HEXES) {
				if (src.includes(banned)) offenders.push(`${path.relative(root, file)}: ${banned}`);
			}
		}
		expect(offenders).toEqual([]);
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
		// The Daybreak cool arc + match gold are shared brand values: the TUI's
		// identity/state tokens and the site's CSS variables must move together.
		expect(theme.getColorHex("sessionAccent").toUpperCase()).toBe(websiteToken(css, "teal"));
		expect(theme.getColorHex("modeAccent").toUpperCase()).toBe(websiteToken(css, "violet"));
		expect(theme.getColorHex("shareAccent").toUpperCase()).toBe(websiteToken(css, "indigo"));
		expect(theme.getColorHex("infoAccent").toUpperCase()).toBe(websiteToken(css, "rose"));
		expect(theme.getColorHex("matchHighlight").toUpperCase()).toBe(websiteToken(css, "gold"));
	});
});
