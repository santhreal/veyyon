import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateThemeVars } from "@veyyon/coding-agent/export/html";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { getResolvedThemeColors, getThemeByName, isLightTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { getCustomThemesDir, removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

describe("Theme.isLight", () => {
	it("classifies built-in themes by their status-line surface", async () => {
		// porcelain styles a dark chat bubble (userMessageBg) on an otherwise-light
		// theme with a light status line. Session accents render on the status line,
		// so it must read as light — classifying by userMessageBg got this wrong.
		expect((await getThemeByName("porcelain"))?.isLight).toBe(true);
		expect((await getThemeByName("light-catppuccin"))?.isLight).toBe(true);
		expect((await getThemeByName("dark-catppuccin"))?.isLight).toBe(false);
	});

	it("exposes the status-line surface luminance for accent sizing", async () => {
		const light = await getThemeByName("light-catppuccin");
		const dark = await getThemeByName("dark-catppuccin");
		// Light themes hand the real surface luminance to getSessionAccentHex...
		expect(light?.accentSurfaceLuminance).toBeGreaterThan(0.5);
		// ...dark themes pass undefined so accents stay vivid.
		expect(dark?.accentSurfaceLuminance).toBeUndefined();
	});
});

describe("isLightTheme (standalone)", () => {
	// Regression for #2516: the standalone helper used to classify on
	// userMessageBg, mismatching Theme.isLight (statusLineBg). porcelain is the
	// canonical mismatch (dark bubble, light status line); sandstone/limestone
	// exercise the custom-light path.
	it.each([
		["sandstone", true],
		["limestone", true],
		["porcelain", true],
		["light", true],
		["dark", false],
		["dark-catppuccin", false],
	])("classifies %s as isLight=%s", (name, expected) => {
		expect(isLightTheme(name)).toBe(expected);
	});
});

describe("getResolvedThemeColors HTML export defaults", () => {
	// Regression for #2516: empty color tokens fell back to #e5e5e7 (the
	// dark-theme grey) for every theme not literally named "light", making the
	// session transcript text illegible on every custom light theme.
	it("uses near-black for empty text tokens on light themes", async () => {
		const colors = await getResolvedThemeColors("sandstone");
		expect(colors.text).toBe("#000000");
		expect(colors.userMessageText).toBe("#000000");
		expect(colors.customMessageText).toBe("#000000");
		expect(colors.toolTitle).toBe("#000000");
	});

	it("uses light grey for empty text tokens on dark themes", async () => {
		// "titanium" (the shipped default dark theme) leaves its `text` token empty,
		// so it exercises the dark-theme grey fallback. `userMessageText` is no
		// longer a fallback probe: titanium sets it explicitly to full silver.
		// Prompts used to render in the dim tone and read as gray-on-gray — invisible
		// against the ground. The message text must be bright.
		const colors = await getResolvedThemeColors("titanium");
		expect(colors.text).toBe("#e5e5e7");
		expect(colors.userMessageText).toBe("#C6CBD4");
	});
	let tempAgentDir: string | undefined;
	let dirOverrides: DirOverridesSnapshot | undefined;

	afterEach(async () => {
		if (tempAgentDir === undefined) return;
		// The snapshot restores the variable AND the active profile that `setAgentDir`
		// clears; the hand-rolled pair this replaces only put the variable back.
		if (dirOverrides) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await removeWithRetries(tempAgentDir);
		tempAgentDir = undefined;
	});

	it("uses light text when a light-status custom theme derives dark export surfaces from userMessageBg", async () => {
		dirOverrides = captureDirOverrides();
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-theme-export-"));
		setAgentDir(tempAgentDir);

		const { export: _ignoredExport, ...themeWithoutExport } = defaultThemes.porcelain;
		const customThemeName = "light-status-dark-export-derived";
		await Bun.write(
			path.join(getCustomThemesDir(), `${customThemeName}.json`),
			JSON.stringify({ ...themeWithoutExport, name: customThemeName }),
		);

		const vars = await generateThemeVars(customThemeName);
		expect(vars).toContain("--body-bg: rgb(56, 78, 112);");
		expect(vars).toContain("--container-bg: rgb(68, 95, 136);");
		expect(vars).toContain("--text: #e5e5e7;");
		expect(vars).toContain("--userMessageText: #e5e5e7;");
	});
});
