import * as fs from "node:fs";
import * as path from "node:path";
import { detectMacOSAppearance, MacAppearanceObserver } from "@veyyon/natives";
import type { EditorTheme, SelectListTheme, SettingsListTheme } from "@veyyon/tui";
import { blendHex, colorEnabled, parseHexColor, sliceWithWidth, TERMINAL, visibleWidth } from "@veyyon/tui";
import { adjustHsv, colorLuma } from "@veyyon/utils/color";
import { getCustomThemesDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { clamp } from "@veyyon/utils/math";
import { errorMessage } from "@veyyon/utils/type-guards";
import {
	onAutoThemeMappingChanged,
	onColorBlindModeChanged,
	onSymbolPresetChanged,
	registerSettingsTestResetHook,
} from "../../config/settings";
import { getBuiltinThemes } from "./builtin-themes";
import {
	ansi256ToHex,
	bgAnsi,
	type ColorMode,
	detectColorMode,
	fgAnsi,
	resolveThemeColors,
	resolveVarRefs,
	type ThemeBg,
	type ThemeColor,
	type ThemeJson,
	validateThemeJson,
} from "./color";
import { lavaText } from "./shimmer";
import { getSymbolTheme } from "./symbol-theme";
import { normalizeSpinnerFramesOverride, type SymbolPreset } from "./symbols";
import { setActiveTheme, theme } from "./theme-binding";
import { Theme } from "./theme-class";

export { getLanguageFromPath } from "../../utils/lang-from-path";
export { getBuiltinThemes } from "./builtin-themes";
export { isValidThemeColor } from "./color";
export { highlightCode } from "./highlight";
export type { SpinnerType, SymbolKey, SymbolPreset } from "./symbols";
export { isLightTheme, isLightThemeJson } from "./theme-luminance";
export type { ThemeBg, ThemeColor };
export { Theme };

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
	} catch {}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const result: ThemeInfo[] = [];

	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

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
	} catch {}

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
	const { missingColors, problems } = validateThemeJson(json);
	if (missingColors.length > 0 || problems.length > 0) {
		let fullErrorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			fullErrorMessage += `\nMissing required color tokens:\n`;
			fullErrorMessage += missingColors.map(c => `  - ${c}`).join("\n");
			fullErrorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			fullErrorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		if (problems.length > 0) {
			fullErrorMessage += `\n\nValidation error:\n${problems.map(problem => `  - ${problem}`).join("\n")}`;
		}
		throw new Error(fullErrorMessage);
	}
	return json as ThemeJson;
}

interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

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
	for (const [token, fallback] of Object.entries(QUIET_TOKEN_DEFAULTS) as [ThemeColor, ThemeColor][]) {
		if (fgColors[token] === undefined) {
			fgColors[token] = fgColors[fallback] ?? fgColors.accent;
		}
	}
	if (bgColors.composerBg === undefined) {
		bgColors.composerBg = "";
	}
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	const spinnerFramesOverrides = normalizeSpinnerFramesOverride(themeJson.symbols?.spinnerFrames);
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
		logger.warn("Theme could not be loaded", { theme: name, error: errorMessage(error) });
		return undefined;
	}
}

var terminalReportedAppearance: "dark" | "light" | undefined;

var macOSReportedAppearance: "dark" | "light" | undefined;

function shouldUseMacOSAppearanceFallback(): boolean {
	return process.platform === "darwin" && !!Bun.env.ZELLIJ;
}

function detectTerminalBackground(): "dark" | "light" {
	if (!shouldUseMacOSAppearanceFallback() && terminalReportedAppearance) {
		return terminalReportedAppearance;
	}

	const colorfgbg = Bun.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) return bg < 8 ? "dark" : "light";
		}
	}

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

export { theme } from "./theme-binding";

var currentThemeName: string | undefined;

export function getCurrentThemeName(): string | undefined {
	return currentThemeName;
}

export function fgOrPlain(color: ThemeColor, text: string, styledText: string = text): string {
	return typeof theme === "undefined" ? text : theme.fg(color, styledText);
}
export interface ThemeChangeEvent {
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

export const FALLBACK_THEME_NAME = "dark";

export interface ThemeLoadResult {
	success: boolean;
	error?: string;
	fellBack?: boolean;
}

interface ApplyThemeOptions {
	ephemeral?: boolean;
	enableWatcher?: boolean;
	commitName?: boolean;
	keepCurrentOnError?: boolean;
	supersededMessage?: string;
}

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

		logger.warn("Theme failed to load; falling back", {
			requested: name,
			fallback: FALLBACK_THEME_NAME,
			error: message,
		});

		if (commitName) currentThemeName = FALLBACK_THEME_NAME;
		setActiveTheme(await loadTheme(FALLBACK_THEME_NAME, getCurrentThemeOptions()));
		notifyThemeChange(event);
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

export function enableAutoTheme(event: ThemeChangeEvent = {}): void {
	autoDetectedTheme = true;
	reevaluateAutoTheme("enableAutoTheme", event);
}

export function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void {
	if (mode === "dark") autoDarkTheme = themeName;
	else autoLightTheme = themeName;
	reevaluateAutoTheme("setAutoThemeMapping");
}

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

export async function setSymbolPreset(preset: SymbolPreset): Promise<ThemeLoadResult> {
	currentSymbolPresetOverride = preset;
	if (!currentThemeName) return { success: true };
	return applyTheme(currentThemeName, { ephemeral: true });
}

export function getSymbolPresetOverride(): SymbolPreset | undefined {
	return currentSymbolPresetOverride;
}

export async function setColorBlindMode(enabled: boolean): Promise<ThemeLoadResult> {
	currentColorBlindMode = enabled;
	if (!currentThemeName) return { success: true };
	return applyTheme(currentThemeName, { ephemeral: true });
}

export function getColorBlindMode(): boolean {
	return currentColorBlindMode;
}

onAutoThemeMappingChanged(
	(slot, themeName) => {
		setAutoThemeMapping(slot, themeName);
	},
	{ permanent: true },
);

registerSettingsTestResetHook(() => {
	currentSymbolPresetOverride = undefined;
	currentColorBlindMode = false;
});

onSymbolPresetChanged(
	preset => {
		setSymbolPreset(preset)
			.then(result => {
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

export function getThemeEpoch(): number {
	return themeEpoch;
}

function notifyThemeChange(event: ThemeChangeEvent = {}): void {
	themeEpoch++;
	try {
		onThemeChangeCallback?.(event);
	} catch (error) {
		logger.warn("Theme change listener threw; the UI may not repaint until the next render", {
			error: errorMessage(error),
		});
	}
}

async function startThemeWatcher(): Promise<void> {
	stopThemeWatcher();

	if (!currentThemeName || currentThemeName in getBuiltinThemes()) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			if (currentThemeName !== watchedThemeName) {
				return;
			}

			if (!fs.existsSync(themeFile)) {
				return;
			}

			loadTheme(watchedThemeName, getCurrentThemeOptions())
				.then(loadedTheme => {
					setActiveTheme(loadedTheme);
					notifyThemeChange({ ephemeral: true });
				})
				.catch(() => {});
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
	} catch {}
}

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
			currentThemeName = previous;
			logger.warn(`Theme switch on ${debugLabel} failed; keeping the current theme`, {
				from: previous,
				to: resolved,
				error: String(err),
			});
		});
}

var macObserver: { stop(): void } | undefined;

type MacAppearanceObserverStarter = (callback: (err: Error | null, appearance: string) => void) => { stop(): void };

let macAppearanceObserverStarter: MacAppearanceObserverStarter | undefined;

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

export async function getResolvedThemeColors(themeName?: string): Promise<Record<string, string>> {
	const name = themeName ?? getDefaultTheme();
	const themeJson = await loadThemeJson(name);
	const exportColors = resolveThemeExportColors(themeJson);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	const defaultText = getHtmlDefaultTextForSurface(
		exportColors.cardBg ?? exportColors.pageBg ?? resolved.userMessageBg,
	);

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

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
		logger.warn("Theme could not be read for export colors; the export will use default colors", {
			theme: name,
			error: errorMessage(error),
		});
		return {};
	}
}

export { getSymbolTheme } from "./symbol-theme";

export function visibleGroundHex(): string {
	return theme.visibleGroundHex();
}

const BAND_COLUMNS_PER_SPAN = 8;
const BAND_MIN_SPANS = 3;
const BAND_MAX_SPANS = 10;
const BAND_TRAIL_MIX = 0.75;
const BAND_RAMP_EASE = 0.55;
const BAND_LIFT_SPAN = 1 / 3;
const BAND_LIFT = 0.4;

const BAND_ESCAPE_PATTERN = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const BAND_BG_RESET = "\x1b[49m";
const BAND_FG_RESET = "\x1b[39m";

function spliceAtColumns(text: string, inserts: ReadonlyMap<number, string>): string {
	const columns = Array.from(inserts.keys()).sort((a, b) => a - b);
	const escapes = BAND_ESCAPE_PATTERN;
	escapes.lastIndex = 0;
	let ansi = escapes.exec(text);
	let out = "";
	let column = 0;
	let cursor = 0;
	let next = 0;
	while (cursor < text.length || next < columns.length) {
		while (next < columns.length && (columns[next] as number) <= column) {
			out += inserts.get(columns[next] as number) as string;
			next += 1;
		}
		if (cursor >= text.length) break;
		while (ansi !== null && ansi.index < cursor) ansi = escapes.exec(text);
		if (ansi !== null && ansi.index === cursor) {
			out += ansi[0];
			cursor += ansi[0].length;
			continue;
		}
		const runEnd = ansi === null ? text.length : ansi.index;
		const run = text.slice(cursor, runEnd);
		const runWidth = visibleWidth(run);
		const take = next < columns.length ? (columns[next] as number) - column : Number.POSITIVE_INFINITY;
		if (take >= runWidth) {
			out += run;
			column += runWidth;
			cursor = runEnd;
			continue;
		}
		const piece = sliceWithWidth(run, 0, take, true);
		const cut = piece.text.length === 0 ? sliceWithWidth(run, 0, take + 1, false) : piece;
		out += cut.text;
		column += cut.width;
		cursor += cut.text.length;
	}
	return out;
}

export function paintBand(text: string, background: ThemeBg, strength: number): string {
	if (strength <= 0) return text;
	if (theme.getColorMode() !== "truecolor") return strength >= 0.5 ? theme.bg(background, text) : text;
	if (!colorEnabled()) return text;
	const width = visibleWidth(text);
	if (width === 0) return theme.bg(background, text);

	const mode = theme.getColorMode();
	const ground = visibleGroundHex();
	const fullStrength = strength >= 1;
	const head = theme.getBgColorHex(background);
	const inserts = new Map<number, string>();
	const accentHex = theme.getAccentColorHex();
	inserts.set(0, bgAnsi(fullStrength ? accentHex : blendHex(ground, accentHex, strength), mode));

	const bodyWidth = width - 1;
	const spans = Math.min(bodyWidth, clamp(Math.round(width / BAND_COLUMNS_PER_SPAN), BAND_MIN_SPANS, BAND_MAX_SPANS));
	for (let index = 0; index < spans; index++) {
		const t = spans === 1 ? 0 : index / (spans - 1);
		const fill =
			index === 0 && fullStrength
				? theme.getBgAnsi(background)
				: bgAnsi(
						fullStrength
							? blendHex(head, ground, BAND_TRAIL_MIX * t ** BAND_RAMP_EASE)
							: blendHex(ground, blendHex(head, ground, BAND_TRAIL_MIX * t ** BAND_RAMP_EASE), strength),
						mode,
					);
		inserts.set(1 + Math.floor((index * bodyWidth) / spans), fill);
	}

	const lifted =
		width >= 3 && !text.includes("\x1b")
			? blendHex(theme.getColorHex("text"), theme.isLight ? "#000000" : "#ffffff", BAND_LIFT * strength)
			: null;
	let tail = BAND_BG_RESET;
	if (lifted !== null) {
		const closeAt = Math.max(2, Math.round(width * BAND_LIFT_SPAN));
		inserts.set(1, `${inserts.get(1) ?? ""}${fgAnsi(lifted, mode)}`);
		if (closeAt >= width) tail = `${BAND_FG_RESET}${BAND_BG_RESET}`;
		else inserts.set(closeAt, `${inserts.get(closeAt) ?? ""}${BAND_FG_RESET}`);
	}
	return `${spliceAtColumns(text, inserts)}${tail}`;
}

export function hoverBand(text: string, strength: number): string {
	return paintBand(text, "selectedBg", strength);
}

export function getSelectListTheme(): SelectListTheme {
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
		selectedPrefix: (text: string) => lavaText(text, theme, TERMINAL.trueColor),
		selectedText: (text: string) => theme.bold(theme.fg("accent", text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
		hovered: hoverBand,
		matchHighlight: (text: string) => theme.fg("matchHighlight", text),
		groupHeader: (name: string) =>
			theme.fg("borderAccent", `  ${name.toUpperCase()} ${"─".repeat(Math.max(4, 30 - name.length))}`),
	};
}

export function getEditorTheme(): EditorTheme {
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
