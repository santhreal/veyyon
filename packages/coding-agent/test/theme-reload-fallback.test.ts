import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FALLBACK_THEME_NAME,
	getCurrentThemeName,
	getThemeByName,
	isThemeWatcherActive,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	type Theme,
} from "@veyyon/coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, setAgentDir } from "@veyyon/utils";

/**
 * Contract for the single theme-reload owner (`applyTheme`).
 *
 * Every entry point — set, preview, symbol preset, color-blind mode — routes
 * through one function so the request-ordering guard, the fallback and the
 * change notification cannot drift apart. They used to be four hand-rolled
 * copies, and two of them swallowed the load failure entirely: toggling a
 * preset while your theme was mid-edit silently replaced what you were looking
 * at. These cases lock in that a fallback is always reported to the caller.
 */

/**
 * A real shipped theme, reused verbatim as the "user's custom theme" fixture.
 * The schema requires a complete colors object, so hand-writing a stub here
 * would silently be an *invalid* theme and every setup step would fall back.
 */
const VALID_THEME = fs.readFileSync(path.join(import.meta.dir, "../src/modes/theme/dark.json"), "utf8");
const INVALID_THEME = "{ this is not valid json";

/** A shipped built-in outside the `dark`/`light` pair the old watcher check named. */
const SHADOWED_BUILTIN = "titanium";

let originalAgentDir: string;
let tempAgentDir: string;
let themesDir: string;
let dark: Theme;

function writeCustomTheme(name: string, contents: string): void {
	fs.writeFileSync(path.join(themesDir, `${name}.json`), contents);
}

beforeAll(async () => {
	const t = await getThemeByName(FALLBACK_THEME_NAME);
	if (!t) throw new Error(`Expected the ${FALLBACK_THEME_NAME} theme to exist`);
	dark = t;
});

beforeEach(() => {
	originalAgentDir = getAgentDir();
	tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-theme-reload-"));
	setAgentDir(tempAgentDir);
	themesDir = getCustomThemesDir();
	fs.mkdirSync(themesDir, { recursive: true });
});

afterEach(() => {
	stopThemeWatcher();
	setAgentDir(originalAgentDir);
	fs.rmSync(tempAgentDir, { recursive: true, force: true });
});

afterAll(() => {
	// Leave a deterministic active theme for any later case in this process.
	setThemeInstance(dark);
});

describe("theme reload — fallback is reported, never silent", () => {
	it("reports the fallback when a symbol preset reload hits a broken theme", async () => {
		writeCustomTheme("mytheme", VALID_THEME);
		expect((await setTheme("mytheme")).success).toBe(true);

		// The user edits their theme and leaves it briefly unparseable — exactly
		// what the theme watcher exists to support.
		writeCustomTheme("mytheme", INVALID_THEME);

		const result = await setSymbolPreset("ascii");

		expect(result.success).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(result.error).toBeTruthy();
	});

	it("reports the fallback when a color-blind reload hits a broken theme", async () => {
		writeCustomTheme("mytheme", VALID_THEME);
		expect((await setTheme("mytheme")).success).toBe(true);
		writeCustomTheme("mytheme", INVALID_THEME);

		const result = await setColorBlindMode(true);

		expect(result.success).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(result.error).toBeTruthy();
	});

	it("keeps a preset reload pointed at the user's theme so a fixed file recovers", async () => {
		writeCustomTheme("mytheme", VALID_THEME);
		await setTheme("mytheme");
		writeCustomTheme("mytheme", INVALID_THEME);

		expect((await setSymbolPreset("ascii")).fellBack).toBe(true);
		// The committed name still points at the user's theme, not the fallback:
		// they chose it, and it is the file they are actively fixing.
		expect(getCurrentThemeName()).toBe("mytheme");

		// Once the file parses again the next toggle picks it straight back up,
		// instead of leaving them stranded on the fallback.
		writeCustomTheme("mytheme", VALID_THEME);
		const recovered = await setSymbolPreset("unicode");
		expect(recovered.success).toBe(true);
		expect(recovered.fellBack).toBeUndefined();
		expect(getCurrentThemeName()).toBe("mytheme");
	});

	it("commits the fallback name when an explicitly requested theme fails", async () => {
		// setTheme is the opposite case: the user asked for this theme by name and
		// it does not load, so leaving them pointed at it would fail every reload.
		const result = await setTheme("__definitely_not_a_real_theme__");

		expect(result.success).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(getCurrentThemeName()).toBe(FALLBACK_THEME_NAME);
	});

	it("succeeds without a fallback flag when the theme loads", async () => {
		writeCustomTheme("mytheme", VALID_THEME);

		const result = await setSymbolPreset("nerd");

		expect(result.success).toBe(true);
		expect(result.fellBack).toBeUndefined();
		expect(result.error).toBeUndefined();
	});
});

describe("theme watcher — built-in detection", () => {
	it("does not watch a custom file that shadows a built-in name", async () => {
		// Built-ins win in `loadThemeJson`, so a user file named after one is never
		// loaded. Watching it would fire a reload on every edit that then resolved
		// back to the built-in, silently discarding their changes.
		//
		// Deliberately a built-in that is NOT dark/light: the check this replaced
		// hardcoded exactly those two names, so a fixture using either would pass
		// against the old bug too and prove nothing.
		writeCustomTheme(SHADOWED_BUILTIN, VALID_THEME);

		await setTheme(SHADOWED_BUILTIN, true);

		expect(isThemeWatcherActive()).toBe(false);
	});

	it("watches a genuinely custom theme file", async () => {
		writeCustomTheme("mytheme", VALID_THEME);

		await setTheme("mytheme", true);

		expect(isThemeWatcherActive()).toBe(true);
	});
});
