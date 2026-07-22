import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as themeModule from "@veyyon/coding-agent/modes/theme/theme";
import { __resetDirsFromEnvForTests, getCustomThemesDir, Snowflake } from "@veyyon/utils";

/**
 * Automatic theme switching resolves a theme name, commits it to
 * `currentThemeName`, and then loads it asynchronously. The commit happens
 * first so that concurrent re-evaluations do not stack.
 *
 * The bug was that a failed load left the name committed anyway. Every later
 * re-evaluation then hit `if (resolved === currentThemeName) return` and gave
 * up before trying, so the failure was permanent for the rest of the session:
 * the terminal sat in dark mode, veyyon kept rendering its light theme, and
 * nothing retried even once the cause was gone. The failure was reported at
 * debug level, so there was nothing to see either.
 *
 * The realistic path in is a custom theme that is broken and then fixed. The
 * user edits `~/.veyyon/agent/themes/mine.json`, gets it wrong, sees no theme
 * change, fixes the file, and still sees no theme change until they restart.
 */
describe("automatic theme switching retries after a failed load", () => {
	let tempHome = "";
	let savedConfigDir: string | undefined;
	const THEME_NAME = "regression-custom-theme";

	function writeCustomTheme(name: string): void {
		const dir = getCustomThemesDir();
		fs.mkdirSync(dir, { recursive: true });
		const base = JSON.parse(
			fs.readFileSync(path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json"), "utf-8"),
		);
		fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ ...base, name }));
	}

	beforeEach(async () => {
		savedConfigDir = process.env.VEYYON_CONFIG_DIR;
		tempHome = path.join(os.tmpdir(), "veyyon-theme-retry", Snowflake.next());
		fs.mkdirSync(tempHome, { recursive: true });
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempHome);
		__resetDirsFromEnvForTests();
		themeModule.stopThemeWatcher();
		await themeModule.initTheme();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		if (savedConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = savedConfigDir;
		__resetDirsFromEnvForTests();
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("keeps reporting the theme that is actually loaded when the switch fails", async () => {
		// REGRESSION: the name was committed before the load, so after a failure
		// getCurrentThemeName() named a theme that had never been applied. Anything
		// reading it, the status line, /theme, the settings UI, showed the user a
		// theme they were not looking at.
		const before = themeModule.getCurrentThemeName();
		themeModule.setAutoThemeMapping("dark", THEME_NAME);
		themeModule.enableAutoTheme();
		themeModule.onTerminalAppearanceChange("dark");
		await Bun.sleep(50);

		expect(themeModule.getCurrentThemeName()).toBe(before);
	});

	it("applies the theme once the file it could not load appears", async () => {
		// REGRESSION and the reason this matters. Before the fix the second
		// re-evaluation early-returned because the failed name was still committed,
		// so fixing the theme file changed nothing until a restart.
		themeModule.setAutoThemeMapping("dark", THEME_NAME);
		themeModule.enableAutoTheme();
		themeModule.onTerminalAppearanceChange("dark");
		await Bun.sleep(50);
		expect(themeModule.getCurrentThemeName()).not.toBe(THEME_NAME);

		writeCustomTheme(THEME_NAME);
		// Drive a fresh appearance change: away and back, the way a terminal that
		// switches to light and back to dark would.
		themeModule.onTerminalAppearanceChange("light");
		await Bun.sleep(50);
		themeModule.onTerminalAppearanceChange("dark");
		await Bun.sleep(50);

		expect(themeModule.getCurrentThemeName()).toBe(THEME_NAME);
	});

	it("still switches normally when the theme loads first time", async () => {
		// The positive twin: restoring the name on failure must not have broken the
		// path where nothing fails.
		writeCustomTheme(THEME_NAME);
		themeModule.setAutoThemeMapping("dark", THEME_NAME);
		themeModule.enableAutoTheme();
		themeModule.onTerminalAppearanceChange("dark");
		await Bun.sleep(50);

		expect(themeModule.getCurrentThemeName()).toBe(THEME_NAME);
	});

	it("survives repeated failures without ever adopting the theme it cannot load", async () => {
		// Each retry re-enters the same path, so restoring the previous name has to
		// be idempotent: a second failure must not restore the FAILED name.
		//
		// The light half of the mapping is a real theme and loads fine, so the run
		// settles on it. What matters is that the broken dark theme is never
		// reported as current, however many times it is attempted.
		themeModule.setAutoThemeMapping("dark", THEME_NAME);
		themeModule.enableAutoTheme();
		const seen: Array<string | undefined> = [];

		for (let i = 0; i < 3; i++) {
			themeModule.onTerminalAppearanceChange("light");
			await Bun.sleep(20);
			seen.push(themeModule.getCurrentThemeName());
			themeModule.onTerminalAppearanceChange("dark");
			await Bun.sleep(20);
			seen.push(themeModule.getCurrentThemeName());
		}

		expect(seen).not.toContain(THEME_NAME);
		// And it is still tracking a theme that genuinely loaded, not left undefined.
		expect(themeModule.getCurrentThemeName()).toBeDefined();
	});
});
