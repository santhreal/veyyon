import * as fs from "node:fs";
import * as path from "node:path";
import { detectMacOSAppearance, MacAppearanceObserver } from "@veyyon/natives";
import type { EditorTheme, SelectListTheme, SettingsListTheme } from "@veyyon/tui";
import { blendHex, parseHexColor, TERMINAL } from "@veyyon/tui";
import { adjustHsv, colorLuma } from "@veyyon/utils/color";
import { getCustomThemesDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
// Owners, not the `@veyyon/utils` barrel: 5 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { type } from "arktype";
import {
	onAutoThemeMappingChanged,
	onColorBlindModeChanged,
	onSymbolPresetChanged,
	registerSettingsTestResetHook,
} from "../../config/settings";
// The bundled theme JSON lives in `./builtin-themes` and the light/dark classifier in
// `./theme-luminance`, so `config/settings` can reach `isLightTheme` for its legacy theme migration
// without importing this module and without paying for a hundred JSON modules. Importing it from here
// closed a cycle (settings -> theme -> shimmer -> settings) that cost 51 MB per realm; see the notes at
// the top of both files.
import { getBuiltinThemes } from "./builtin-themes";
import {
	ansi256ToHex,
	type ColorMode,
	detectColorMode,
	getThemeJsonSchema,
	resolveThemeColors,
	resolveVarRefs,
	type ThemeBg,
	type ThemeColor,
	type ThemeJson,
} from "./color";
import { lavaText } from "./shimmer";
import { getSymbolTheme } from "./symbol-theme";
import { normalizeSpinnerFramesOverride, type SymbolPreset } from "./symbols";
import { setActiveTheme, theme } from "./theme-binding";
import { Theme } from "./theme-class";

export { getLanguageFromPath } from "../../utils/lang-from-path";
// Re-exported so this stays the one place callers import theme lookups from, even though the
// definitions moved out of the cycle. Each comes from its owning leaf rather than through
// `./builtin-themes`, so this file states where each one actually lives.
export { getBuiltinThemes } from "./builtin-themes";
export { isValidThemeColor } from "./color";
// The memoised native highlighter moved to `./highlight` with the markdown adapter that also
// needed it, so this module stopped naming `@veyyon/natives` and `lru-cache`. Re-exported because
// every caller already asks this file for it and `./highlight` reaches two modules, so forwarding
// it costs nothing. `getMarkdownTheme` is deliberately NOT forwarded: that one carries the mermaid
// renderer, and forwarding it would put those 36 modules straight back on this file's graph.
export { highlightCode } from "./highlight";
export type { SpinnerType, SymbolKey, SymbolPreset } from "./symbols";
export { isLightTheme, isLightThemeJson } from "./theme-luminance";
export type { ThemeBg, ThemeColor };
export { Theme };

// ============================================================================
// Theme Loading
// ============================================================================

export async function getAvailableThemes(): Promise<string[]> {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const result: ThemeInfo[] = [];

	// Built-in themes (embedded, no file path)
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

	// Custom themes
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some(themeInfo => themeInfo.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadThemeJson(name: string): Promise<ThemeJson> {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	let content: string;
	try {
		content = await Bun.file(themePath).text();
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Theme not found: ${name}`);
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	let parsed: ThemeJson;
	try {
		parsed = getThemeJsonSchema()(json) as ThemeJson;
		if (parsed instanceof type.errors) {
			throw new Error(parsed.summary);
		}
	} catch (error) {
		const parseErrorMessage = errorMessage(error);
		// Extract color key information if available
		const missingColorMatch = parseErrorMessage.match(/missing keys: (.+)/i);
		const missingColors: string[] = missingColorMatch
			? missingColorMatch[1].split(",").map((s: string) => s.trim())
			: [];

		let fullErrorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			fullErrorMessage += `\nMissing required color tokens:\n`;
			fullErrorMessage += missingColors.map(c => `  - ${c}`).join("\n");
			fullErrorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			fullErrorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		fullErrorMessage += `\n\nValidation error:\n  - ${parseErrorMessage}`;

		throw new Error(fullErrorMessage);
	}
	return parsed;
}

interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

/** HSV adjustment to shift green toward blue for colorblind mode (red-green colorblindness) */
const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

/**
 * Defaults for the optional identity/state accent tokens, keyed by the token,
 * valued by the required token whose resolved color it inherits when a theme
 * does not declare it. Session/mode identity fall back to the theme's accent,
 * share to its link color, info to muted, and match highlights to warning
 * (the closest "look here" hue every theme already has).
 */
const QUIET_TOKEN_DEFAULTS: Partial<Record<ThemeColor, ThemeColor>> = {
	sessionAccent: "accent",
	modeAccent: "accent",
	shareAccent: "link",
	infoAccent: "muted",
	matchHighlight: "warning",
};

export function createTheme(themeJson: ThemeJson, options: CreateThemeOptions = {}): Theme {
	const { mode, symbolPresetOverride, colorBlindMode } = options;
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);

	if (colorBlindMode) {
		const added = resolvedColors.toolDiffAdded;
		if (typeof added === "string" && added.startsWith("#")) {
			resolvedColors.toolDiffAdded = adjustHsv(added, COLORBLIND_ADJUSTMENT);
		}
	}

	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"statusLineBg",
		"composerBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	// The identity/state accent tokens are optional in theme JSON (they arrived
	// with the design system's cool arc, long after most themes were authored).
	// A theme that omits one gets its DOCUMENTED default here — the one owner of
	// that contract — so lookups never throw and older themes stay valid. Themes
	// override by declaring the key (titanium.json binds the Daybreak arcs). The
	// preferred fallback token can itself be optional (e.g. `link`), so the
	// chain bottoms out on `accent`, which every theme must declare.
	for (const [token, fallback] of Object.entries(QUIET_TOKEN_DEFAULTS) as [ThemeColor, ThemeColor][]) {
		if (fgColors[token] === undefined) {
			fgColors[token] = fgColors[fallback] ?? fgColors.accent;
		}
	}
	// The composer quiet card (DS-6 layer 0) defaults to UNPAINTED (the empty
	// sentinel, `\x1b[49m`): the inline TUI's ground is the terminal's own
	// background, and inheriting statusLineBg here is how the composer band
	// rendered as a grey slab on mismatched terminals. A theme that wants a
	// painted composer card must say so explicitly.
	if (bgColors.composerBg === undefined) {
		bgColors.composerBg = "";
	}
	// Extract symbol configuration - settings override takes precedence over theme
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	const spinnerFramesOverrides = normalizeSpinnerFramesOverride(themeJson.symbols?.spinnerFrames);
	// The theme's terminal ground for the painted-ground feature (`tui.paintGround`)
	// comes from `export.pageBg`, the same background HTML export already uses.
	// It is accepted only as a literal 6-digit hex: OSC 11 painting needs an exact
	// #RRGGBB, and a page background left as an ansi index or an unresolved var is
	// not one, so it resolves to no ground (the consumer then inherits the terminal
	// background rather than painting a wrong color).
	const rawGround = resolveThemeExportColors(themeJson).pageBg;
	const groundHex = rawGround !== undefined && parseHexColor(rawGround) !== null ? rawGround : undefined;
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides, spinnerFramesOverrides, groundHex);
}

async function loadTheme(name: string, options: CreateThemeOptions = {}): Promise<Theme> {
	const themeJson = await loadThemeJson(name);
	return createTheme(themeJson, options);
}

export async function getThemeByName(name: string): Promise<Theme | undefined> {
	try {
		return await loadTheme(name);
	} catch (error) {
		// Undefined is also the answer for a theme that does not exist, and the caller (an extension
		// asking for a theme by name) cannot tell a typo from a broken theme file. Naming the theme and
		// the parse error is the difference between fixing your JSON and assuming the name was wrong.
		logger.warn("Theme could not be loaded", { theme: name, error: errorMessage(error) });
		return undefined;
	}
}

/** Appearance detected via OSC 11 background color query, or undefined if not yet available. */
var terminalReportedAppearance: "dark" | "light" | undefined;

/** Appearance reported by the macOS fallback observer, or undefined if not yet available. */
var macOSReportedAppearance: "dark" | "light" | undefined;

function shouldUseMacOSAppearanceFallback(): boolean {
	// Zellij currently breaks OSC 11 passthrough on macOS, so terminal-derived
	// appearance cannot be trusted there. Fall back to host macOS appearance
	// without letting it override valid terminal signals elsewhere.
	return process.platform === "darwin" && !!Bun.env.ZELLIJ;
}

function detectTerminalBackground(): "dark" | "light" {
	// Tier 1: terminal-reported appearance from OSC 11 luminance.
	if (!shouldUseMacOSAppearanceFallback() && terminalReportedAppearance) {
		return terminalReportedAppearance;
	}

	// Tier 2: COLORFGBG env var (static at process start, but still terminal-derived).
	const colorfgbg = Bun.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) return bg < 8 ? "dark" : "light";
		}
	}

	// Tier 3: host macOS appearance for known-broken terminal paths only.
	if (shouldUseMacOSAppearanceFallback()) {
		const macAppearance = macOSReportedAppearance ?? detectMacOSAppearance();
		if (macAppearance) return macAppearance;
	}

	return "dark";
}

function getDefaultTheme(): string {
	const bg = detectTerminalBackground();
	return bg === "light" ? autoLightTheme : autoDarkTheme;
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// The binding itself lives in `./theme-binding`, a leaf, so a caller that only
// needs to READ the active theme does not have to import this engine. Re-exported
// here because this module has always been where callers import it from.
export { theme } from "./theme-binding";

var currentThemeName: string | undefined;

/** Get the name of the currently active theme. */
export function getCurrentThemeName(): string | undefined {
	return currentThemeName;
}

/** Returns unstyled `text` before `initTheme()` assigns the global theme; use only for early-render paths. */
export function fgOrPlain(color: ThemeColor, text: string, styledText: string = text): string {
	return typeof theme === "undefined" ? text : theme.fg(color, styledText);
}
export interface ThemeChangeEvent {
	/** Preview/presentation-only changes should repaint live UI without replacing native scrollback. */
	ephemeral?: boolean;
}

var currentSymbolPresetOverride: SymbolPreset | undefined;
var currentColorBlindMode: boolean = false;
var themeWatcher: fs.FSWatcher | undefined;
var themeReloadTimer: NodeJS.Timeout | undefined;
var sigwinchHandler: (() => void) | undefined;
var autoDetectedTheme: boolean = false;
var autoDarkTheme: string = "dark";
var autoLightTheme: string = "light";
var onThemeChangeCallback: ((event: ThemeChangeEvent) => void) | undefined;
var themeLoadRequestId: number = 0;
let themeEpoch = 0;

function getCurrentThemeOptions(): CreateThemeOptions {
	return {
		symbolPresetOverride: currentSymbolPresetOverride,
		colorBlindMode: currentColorBlindMode,
	};
}

/**
 * The theme every fallback lands on. It is compiled into the binary as a
 * built-in, so it is the one theme guaranteed to load no matter what is on disk.
 */
export const FALLBACK_THEME_NAME = "dark";

/** Outcome of loading a theme and making it active. */
export interface ThemeLoadResult {
	success: boolean;
	error?: string;
	/**
	 * The requested theme failed and `FALLBACK_THEME_NAME` is now rendering.
	 * Callers with a user-visible channel MUST surface this: the user asked for
	 * one theme and is looking at another, so staying quiet hides a real degrade.
	 */
	fellBack?: boolean;
}

interface ApplyThemeOptions {
	/** Repaint live UI without replacing native scrollback. */
	ephemeral?: boolean;
	/** Start the custom-theme file watcher once the theme loads. */
	enableWatcher?: boolean;
	/**
	 * Record `name` as the committed theme on success, and the fallback name if
	 * it falls back.
	 *
	 * `currentThemeName` means "the theme the user chose", not "the theme
	 * currently rendering" — the two deliberately diverge. A preview renders
	 * another theme while leaving the committed name alone so cancelling can
	 * restore it (`settings-selector.ts` captures `getCurrentThemeName()` for
	 * exactly that). A preset/color-blind reload keeps the committed name too:
	 * if the user's theme is mid-edit and broken, holding their name means the
	 * next toggle retries it and picks the file back up once they fix it, rather
	 * than permanently kicking them onto the fallback.
	 */
	commitName?: boolean;
	/**
	 * Leave the active theme untouched when the load fails, instead of falling
	 * back. Previewing is browsing: failing to render a candidate is not a reason
	 * to throw away the theme the user is actually on. The error still surfaces
	 * through the result, so the degrade stays visible either way.
	 */
	keepCurrentOnError?: boolean;
	/** Result message when a newer request superseded this one. */
	supersededMessage?: string;
}

/**
 * The one owner of "load a theme and make it active".
 *
 * Every entry point (init, explicit set, preview, symbol preset, color-blind
 * mode) routes through here so the request-ordering guard, the fallback, and
 * the change notification cannot drift apart. They previously hand-rolled this
 * sequence four times over and had already drifted: two copies swallowed the
 * load failure entirely, so a broken theme silently swapped what you were
 * looking at with nothing said (Law 10).
 */
async function applyTheme(name: string, options: ApplyThemeOptions = {}): Promise<ThemeLoadResult> {
	const {
		ephemeral,
		enableWatcher,
		commitName,
		keepCurrentOnError,
		supersededMessage = "Theme change superseded by a newer request",
	} = options;
	const event: ThemeChangeEvent = ephemeral ? { ephemeral: true } : {};
	const requestId = ++themeLoadRequestId;

	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: supersededMessage };
		}
		setActiveTheme(loadedTheme);
		if (commitName) currentThemeName = name;
		if (enableWatcher) await startThemeWatcher();
		notifyThemeChange(event);
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: supersededMessage };
		}

		const message = errorMessage(error);
		if (keepCurrentOnError) {
			logger.warn("Theme failed to load; keeping the active theme", { requested: name, error: message });
			return { success: false, error: message };
		}

		// Loud and recorded: the operator is about to be shown a theme they did
		// not pick. The returned `fellBack` is the user-visible half — the log
		// alone would be a silent degrade.
		logger.warn("Theme failed to load; falling back", {
			requested: name,
			fallback: FALLBACK_THEME_NAME,
			error: message,
		});

		if (commitName) currentThemeName = FALLBACK_THEME_NAME;
		// The fallback is a built-in, so this cannot hit the disk or throw. If it
		// ever does, the theme system is unusable and the throw is the honest signal.
		setActiveTheme(await loadTheme(FALLBACK_THEME_NAME, getCurrentThemeOptions()));
		// Bump the epoch so memoized renderers re-shape with the fallback colors
		// instead of holding the failed theme's stale styling.
		notifyThemeChange(event);
		// Deliberately no watcher on the fallback: it is a built-in with no file.
		return { success: false, error: message, fellBack: true };
	}
}

export async function initTheme(
	enableWatcher: boolean = false,
	symbolPreset?: SymbolPreset,
	colorBlindMode?: boolean,
	darkTheme?: string,
	lightTheme?: string,
): Promise<void> {
	autoDetectedTheme = true;
	autoDarkTheme = darkTheme ?? "dark";
	autoLightTheme = lightTheme ?? "light";
	const name = getDefaultTheme();
	currentThemeName = name;
	currentSymbolPresetOverride = symbolPreset;
	currentColorBlindMode = colorBlindMode ?? false;
	const result = await applyTheme(name, { enableWatcher, commitName: true });
	if (result.success && enableWatcher) {
		startSigwinchListener();
	}
}

/**
 * Switch to `name` as the committed theme. On failure the fallback renders and
 * the committed name moves with it: the user explicitly asked for this theme,
 * so leaving them pointed at one that does not load would fail the same way on
 * every subsequent reload.
 */
export async function setTheme(name: string, enableWatcher: boolean = false): Promise<ThemeLoadResult> {
	autoDetectedTheme = false;
	return applyTheme(name, { enableWatcher, commitName: true });
}

export async function previewTheme(
	name: string,
	event: ThemeChangeEvent = { ephemeral: true },
): Promise<ThemeLoadResult> {
	return applyTheme(name, {
		ephemeral: event.ephemeral,
		keepCurrentOnError: true,
		supersededMessage: "Theme preview superseded by a newer request",
	});
}

/**
 * Enable auto-detection mode, switching to the appropriate dark/light theme.
 */
export function enableAutoTheme(event: ThemeChangeEvent = {}): void {
	autoDetectedTheme = true;
	reevaluateAutoTheme("enableAutoTheme", event);
}

/**
 * Update the theme mappings for auto-detection mode.
 * When a dark/light mapping changes and auto-detection is active, re-evaluate the theme.
 */
export function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void {
	if (mode === "dark") autoDarkTheme = themeName;
	else autoLightTheme = themeName;
	reevaluateAutoTheme("setAutoThemeMapping");
}

/**
 * Called when the terminal detects a dark/light appearance change.
 * The terminal layer queries OSC 11 (background color) and computes luminance;
 * Mode 2031 notifications trigger re-queries rather than providing the value directly.
 */
export function onTerminalAppearanceChange(mode: "dark" | "light"): void {
	if (terminalReportedAppearance === mode) return;
	terminalReportedAppearance = mode;
	reevaluateAutoTheme("terminal appearance");
}

export function setThemeInstance(themeInstance: Theme): void {
	autoDetectedTheme = false;
	setActiveTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher();
	notifyThemeChange({ ephemeral: true });
}

/**
 * Set the symbol preset override, recreating the theme with the new preset.
 *
 * Returns the reload outcome so callers can surface a fallback. The preset
 * itself always takes effect; only re-rendering the committed theme can fail.
 */
export async function setSymbolPreset(preset: SymbolPreset): Promise<ThemeLoadResult> {
	currentSymbolPresetOverride = preset;
	if (!currentThemeName) return { success: true };
	return applyTheme(currentThemeName, { ephemeral: true });
}

/**
 * Get the current symbol preset override.
 */
export function getSymbolPresetOverride(): SymbolPreset | undefined {
	return currentSymbolPresetOverride;
}

/**
 * Set color blind mode, recreating the theme with the new setting.
 * When enabled, uses blue instead of green for diff additions.
 */
export async function setColorBlindMode(enabled: boolean): Promise<ThemeLoadResult> {
	currentColorBlindMode = enabled;
	if (!currentThemeName) return { success: true };
	return applyTheme(currentThemeName, { ephemeral: true });
}

/**
 * Get the current color blind mode setting.
 */
export function getColorBlindMode(): boolean {
	return currentColorBlindMode;
}

// ============================================================================
// Live application of theme settings
// ============================================================================

/**
 * Apply `theme.dark`, `theme.light`, `symbolPreset` and `colorBlindMode` to the
 * running engine when an operator changes them mid-session.
 *
 * THE SUBSCRIPTION LIVES HERE, NOT IN SETTINGS. `config/settings` used to call the
 * three setters above directly, which made domain configuration import the
 * terminal UI and closed the cycle settings -> theme -> shimmer -> settings. That
 * component cost 51 MB every time any part of it was imported, and the test runner
 * gives each test file its own realm, so a full run paid it about 1,800 times and
 * ran out of memory. Settings now fires a signal and this module listens, which
 * reverses the edge and leaves settings free of the theme engine.
 *
 * These run at import, so a program that never loads the theme engine simply has
 * no listener. That is correct rather than a dropped update: `Settings.set` writes
 * and persists the value either way, and there is no rendered theme to re-apply
 * until this module is loaded, at which point `applyTheme` reads the committed
 * settings.
 */
onAutoThemeMappingChanged(
	(slot, themeName) => {
		setAutoThemeMapping(slot, themeName);
	},
	{ permanent: true },
);

/**
 * Put this module's ambient state back to what a freshly started process has.
 *
 * WHY IT EXISTS. `currentSymbolPresetOverride` and `currentColorBlindMode` are module scope and
 * survive `resetSettingsForTest`, so one suite writing `symbolPreset: "ascii"` changed what every
 * later suite in the same process rendered. That is how the mermaid suite came to assert on box
 * borders and receive a diagram drawn with `+` and `|` -- zero lines matching, and a failure that
 * reads as "the renderer produced nothing" rather than as "someone else chose ASCII". The hook fires
 * asynchronously off a settings signal, which is why it looked timing-dependent as well.
 *
 * `markdownMermaidRendering` was the third variable here and is the same class with a harsher
 * outcome. It moved to `./markdown-theme` with the function that owns it, and that module registers
 * its own hook: a module resets its own ambient state, and a suite that never loads the markdown
 * adapter has none of that state to restore.
 *
 * Registered rather than exported for tests to call, so a suite that resets settings gets this for
 * free and cannot forget it.
 */
registerSettingsTestResetHook(() => {
	currentSymbolPresetOverride = undefined;
	currentColorBlindMode = false;
});

onSymbolPresetChanged(
	preset => {
		setSymbolPreset(preset)
			.then(result => {
				// The preset applied, but re-rendering the committed theme fell back.
				// Record which theme is actually on screen now.
				if (result.fellBack) {
					logger.warn("Settings: symbolPreset applied but the theme fell back", {
						preset,
						error: result.error,
					});
				}
			})
			.catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset, error: String(err) });
			});
	},
	{ permanent: true },
);

onColorBlindModeChanged(
	enabled => {
		setColorBlindMode(enabled)
			.then(result => {
				if (result.fellBack) {
					logger.warn("Settings: colorBlindMode applied but the theme fell back", {
						enabled,
						error: result.error,
					});
				}
			})
			.catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled, error: String(err) });
			});
	},
	{ permanent: true },
);

export function onThemeChange(callback: (event: ThemeChangeEvent) => void): () => void {
	onThemeChangeCallback = callback;
	return () => {
		if (onThemeChangeCallback === callback) {
			onThemeChangeCallback = undefined;
		}
	};
}

/**
 * Monotonic counter bumped on any theme-affecting change that should invalidate
 * cached renders: theme swaps and reloads (including the invalid-theme dark
 * fallback), theme previews, symbol-preset changes, and color-blind-mode
 * changes — everything that routes through {@link notifyThemeChange}. Consumers
 * key cached renders on it so the next render re-shapes their output.
 */
export function getThemeEpoch(): number {
	return themeEpoch;
}

/** Bump the theme epoch and notify the registered theme-change listener. */
function notifyThemeChange(event: ThemeChangeEvent = {}): void {
	themeEpoch++;
	try {
		onThemeChangeCallback?.(event);
	} catch (error) {
		// The listener is the UI's repaint hook: render-cache invalidation, the
		// editor border, native scrollback replacement. It is invoked inside the
		// theme watcher's and the auto-theme observer's `.then()`, so a throw here
		// lands in a sibling `.catch` written for a FAILED LOAD — and that handler
		// rolls `currentThemeName` back to the previous name even though
		// `setActiveTheme` already succeeded, leaving the tracked name disagreeing
		// with the live theme for the rest of the session (the watcher's
		// `currentThemeName !== watchedThemeName` guard then misfires too). On the
		// synchronous `/theme` path the same throw instead unwinds into the command
		// and reports a theme that did load as broken. The epoch is already bumped,
		// so the next render re-shapes either way: a dead repaint hook is a logged
		// warning, never a rolled-back theme.
		logger.warn("Theme change listener threw; the UI may not repaint until the next render", {
			error: errorMessage(error),
		});
	}
}

/**
 * Get available symbol presets.
 */
export function getAvailableSymbolPresets(): SymbolPreset[] {
	return ["unicode", "nerd", "ascii"];
}

/**
 * Check if a string is a valid symbol preset.
 */
export function isValidSymbolPreset(preset: string): preset is SymbolPreset {
	return preset === "unicode" || preset === "nerd" || preset === "ascii";
}

async function startThemeWatcher(): Promise<void> {
	stopThemeWatcher();

	// Only watch custom themes. Ask the built-in registry rather than naming
	// themes here: `loadThemeJson` resolves built-ins before ever touching the
	// custom themes dir, so a user file that shadows a built-in name is never
	// loaded. Watching it anyway would fire a reload on every edit that then
	// re-resolved to the built-in, silently discarding their changes.
	if (!currentThemeName || currentThemeName in getBuiltinThemes()) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			loadTheme(watchedThemeName, getCurrentThemeOptions())
				.then(loadedTheme => {
					setActiveTheme(loadedTheme);
					notifyThemeChange({ ephemeral: true });
				})
				.catch(() => {
					// Ignore errors (file might be in invalid state while being edited)
				});
		}, 100);
	};

	try {
		themeWatcher = fs.watch(customThemesDir, (_eventType, filename) => {
			if (currentThemeName !== watchedThemeName) {
				return;
			}
			if (!filename) {
				scheduleReload();
				return;
			}
			const changedFile = String(filename);
			if (changedFile !== watchedFileName) {
				return;
			}
			scheduleReload();
		});
	} catch {
		// Ignore errors starting watcher
	}
}

/**
 * Shared logic for re-evaluating the auto-detected theme.
 * Called from SIGWINCH, terminal appearance change handler, and macOS fallback observer.
 */
function reevaluateAutoTheme(debugLabel: string, event: ThemeChangeEvent = {}): void {
	if (!autoDetectedTheme) return;
	const resolved = getDefaultTheme();
	if (resolved === currentThemeName) return;
	const previous = currentThemeName;
	currentThemeName = resolved;
	loadTheme(resolved, getCurrentThemeOptions())
		.then(loadedTheme => {
			setActiveTheme(loadedTheme);
			notifyThemeChange(event);
		})
		.catch(err => {
			// Put the name back. It was committed before the load so concurrent
			// re-evaluations would not stack, but leaving it committed after a failure
			// meant `resolved === currentThemeName` matched on every later terminal
			// appearance change, so the early return above skipped the retry forever:
			// the terminal was in dark mode, veyyon still rendered its light theme, and
			// nothing tried again for the rest of the session.
			currentThemeName = previous;
			// warn, not debug. The user asked for automatic theme switching, it just
			// did not happen, and the colours on screen are now wrong in a way they
			// cannot explain from anything they did.
			logger.warn(`Theme switch on ${debugLabel} failed; keeping the current theme`, {
				from: previous,
				to: resolved,
				error: String(err),
			});
		});
}

// ============================================================================
// macOS Appearance Fallback Observer
// ============================================================================

var macObserver: { stop(): void } | undefined;

type MacAppearanceObserverStarter = (callback: (err: Error | null, appearance: string) => void) => { stop(): void };

/**
 * Seam over `MacAppearanceObserver.start`. The native export is a lazy Proxy
 * whose property access loads the platform addon, so tests can neither spy on
 * it (`defineProperty` lands on the proxy's dummy target while `get` keeps
 * returning the real binding) nor run where the darwin addon does not exist.
 * Production always uses the real native class; tests install a fake starter.
 */
let macAppearanceObserverStarter: MacAppearanceObserverStarter | undefined;

/** Install (or with undefined, remove) a fake observer starter. Test-only. */
export function setMacAppearanceObserverStarterForTest(starter: MacAppearanceObserverStarter | undefined): void {
	macAppearanceObserverStarter = starter;
}

function startMacAppearanceObserver(): void {
	stopMacAppearanceObserver();
	if (!shouldUseMacOSAppearanceFallback()) return;
	try {
		macOSReportedAppearance = detectMacOSAppearance() ?? undefined;
		const start = macAppearanceObserverStarter ?? (cb => MacAppearanceObserver.start(cb));
		macObserver = start((err, appearance) => {
			if (!err && (appearance === "dark" || appearance === "light")) {
				macOSReportedAppearance = appearance;
				reevaluateAutoTheme("macOS fallback");
			}
		});
	} catch (err) {
		logger.warn("Failed to start macOS appearance observer", { err });
	}
}

function stopMacAppearanceObserver(): void {
	if (macObserver) {
		macObserver.stop();
		macObserver = undefined;
	}
	macOSReportedAppearance = undefined;
}

// ============================================================================
// SIGWINCH Listener
// ============================================================================

/** Re-check appearance on SIGWINCH and switch dark/light when using auto-detected theme. */
function startSigwinchListener(): void {
	stopSigwinchListener();
	sigwinchHandler = () => {
		reevaluateAutoTheme("SIGWINCH");
	};
	process.on("SIGWINCH", sigwinchHandler);
	startMacAppearanceObserver();
}

function stopSigwinchListener(): void {
	if (sigwinchHandler) {
		process.removeListener("SIGWINCH", sigwinchHandler);
		sigwinchHandler = undefined;
	}
	stopMacAppearanceObserver();
}

/**
 * Whether a custom-theme file watcher is currently attached. `startThemeWatcher`
 * returns early for built-in themes and for names with no file on disk, so this
 * is how a caller tells "watching" apart from "declined to watch".
 */
export function isThemeWatcherActive(): boolean {
	return themeWatcher !== undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
	stopSigwinchListener();
	terminalReportedAppearance = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

function getHtmlDefaultTextForSurface(surface: string | number | undefined): string {
	const luminance = surface === undefined ? undefined : colorLuma(surface);
	return luminance !== undefined && luminance > 0.5 ? "#000000" : "#e5e5e7";
}

function resolveThemeExportColors(themeJson: ThemeJson): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const exportSection = themeJson.export;
	if (!exportSection) return {};

	const vars = themeJson.vars ?? {};
	const resolve = (value: string | number | undefined): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value === "number") return ansi256ToHex(value);
		if (value === "" || value.startsWith("#")) return value;
		const varName = value.startsWith("$") ? value.slice(1) : value;
		if (varName in vars) {
			const resolved = resolveVarRefs(varName, vars);
			return typeof resolved === "number" ? ansi256ToHex(resolved) : resolved;
		}
		return value;
	};

	return {
		pageBg: resolve(exportSection.pageBg),
		cardBg: resolve(exportSection.cardBg),
		infoBg: resolve(exportSection.infoBg),
	};
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export async function getResolvedThemeColors(themeName?: string): Promise<Record<string, string>> {
	const name = themeName ?? getDefaultTheme();
	const themeJson = await loadThemeJson(name);
	const exportColors = resolveThemeExportColors(themeJson);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Empty foreground tokens use the terminal default color. In HTML export,
	// that default must contrast the export surface, not the TUI status line:
	// custom light themes can still export dark transcript cards when they omit
	// `export`, because generateThemeVars derives those cards from userMessageBg.
	const defaultText = getHtmlDefaultTextForSurface(
		exportColors.cardBg ?? exportColors.pageBg ?? resolved.userMessageBg,
	);

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export async function getThemeExportColors(themeName?: string): Promise<{
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
}> {
	const name = themeName ?? getDefaultTheme();
	try {
		const themeJson = await loadThemeJson(name);
		return resolveThemeExportColors(themeJson);
	} catch (error) {
		// An empty object means "this theme sets no explicit export colors", which is a normal answer and
		// the reason the caller falls back to its own defaults. A theme file that could not be READ gives
		// the same answer for a different reason, so it is logged: an export that silently comes out in
		// default colors, when the theme does define them, is otherwise indistinguishable from a theme
		// that never set any.
		logger.warn("Theme could not be read for export colors; the export will use default colors", {
			theme: name,
			error: errorMessage(error),
		});
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

/**
 * The symbol reader lives in `./symbol-theme`, a leaf beside the theme binding, and is re-exported here so
 * the modules that already reach this engine keep taking it from one place.
 *
 * It moved because `./markdown-theme` took it from here for one field, and this module is 144 marginal
 * modules on that graph: the whole presentation layer arrived in every rendered code cell and, through
 * `tools/read.ts`, in every file read. `symbol-theme.ts` needs the live binding and a type.
 */
export { getSymbolTheme } from "./symbol-theme";

/**
 * The pointer band, at a strength an animation decided.
 *
 * At full strength this is the selection background, byte for byte what a switched
 * band always was. Below it the band color is mixed out of the ground the row sits
 * on — the same ground a card unfolds out of — so the band arrives from the page
 * instead of appearing on it.
 *
 * A theme running in 256-color mode gets the switched band at half strength instead of a mix. It
 * cannot show one: every intermediate color quantizes onto the nearest palette entry, which reads
 * as the band changing hue rather than fading in. The band still tracks the pointer, exactly as it
 * did before there was a fade. The mode is the THEME's, not the terminal's reported capability —
 * the theme is what decides which color space it paints in, and a mix computed for a space the
 * theme is not using is quantized right back.
 */
export function hoverBand(text: string, strength: number): string {
	if (strength >= 1) return theme.bg("selectedBg", text);
	if (theme.getColorMode() !== "truecolor") return strength >= 0.5 ? theme.bg("selectedBg", text) : text;
	return theme.bgHex(blendHex(theme.getResolvedGroundHex(), theme.getBgColorHex("selectedBg"), strength), text);
}

export function getSelectListTheme(): SelectListTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
			symbols: getSymbolTheme(),
			hovered: (text: string) => text,
		};
	}
	return {
		// The selection cursor is a LIVE warm-arc glyph, so it runs molten
		// (lava heat cycle) on truecolor terminals and static borderAccent
		// ember otherwise — the design system's "the one live thing".
		selectedPrefix: (text: string) => lavaText(text, theme, TERMINAL.trueColor),
		selectedText: (text: string) => theme.bold(theme.fg("accent", text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
		hovered: hoverBand,
		// The found thing is gold: filter-hit characters paint matchHighlight.
		matchHighlight: (text: string) => theme.fg("matchHighlight", text),
		// Category headers per the approved / menu design: an ember uppercase
		// label with a short rule tail, so the list reads as a map of sections.
		groupHeader: (name: string) =>
			theme.fg("borderAccent", `  ${name.toUpperCase()} ${"─".repeat(Math.max(4, 30 - name.length))}`),
	};
}

export function getEditorTheme(): EditorTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			borderColor: (text: string) => text,
			selectList: getSelectListTheme(),
			symbols: getSymbolTheme(),
			hintStyle: (text: string) => text,
		};
	}
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		symbols: getSymbolTheme(),
		hintStyle: (text: string) => theme.fg("dim", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	// Plugins (e.g. pi-rtk-optimizer) may call this before `initTheme()` assigns
	// the global `theme`, or from a separate module instance under npm-global
	// installs where the live binding was never initialized. Fall back to plain
	// text so the call returns a usable (unstyled) theme instead of crashing with
	// "undefined is not an object (evaluating 'theme.fg')". See #2998.
	if (typeof theme === "undefined") {
		return {
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: "> ",
			hint: (text: string) => text,
			heading: (text: string) => `◆ ${text}`,
			section: (text: string) => text,
			hovered: (text: string) => text,
		};
	}
	return {
		label: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : text,
		value: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : theme.fg("muted", text),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", `${theme.nav.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
		heading: (text: string, dimmed: boolean) =>
			dimmed
				? theme.fg("dim", theme.underline(text))
				: // Section headers carry a small ember diamond — the settings kicker.
					`${theme.fg("accent", "◆")} ${theme.fg("muted", theme.bold(text))}`,
		section: (text: string, active: boolean) =>
			active ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text),
		hovered: hoverBand,
	};
}
