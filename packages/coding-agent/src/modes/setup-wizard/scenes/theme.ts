import {
	padding,
	routeSelectListMouse,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clampLow, errorMessage } from "@veyyon/utils";
import { withIcon } from "../../theme/icon-label";
import {
	enableAutoTheme,
	getAvailableThemes,
	getCurrentThemeName,
	getSelectListTheme,
	isLightTheme,
	previewTheme,
	type SymbolPreset,
	setColorBlindMode,
	setSymbolPreset,
	theme,
} from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

type ThemeMode = "curated" | "all";

/**
 * The rows that pick a theme. Choosing one ends the scene.
 *
 * The two modifiers, colorblind colours and ASCII glyphs, are NOT here. They
 * used to sit in this list as if they were alternatives to a theme, and
 * selecting one finished the scene without a theme ever being chosen: picking
 * "Colorblind colors" wrote `colorBlindMode: true` and left `theme.dark` at
 * whatever it already was, and "ANSI-safe" forced `dark-terminal` on you. A
 * user who wanted colourblind-safe LIGHT had no way to say so. They compose
 * with a theme, so they are toggles.
 */
const THEME_ITEMS: readonly SelectItem[] = [
	{ value: "auto", label: "Match terminal", description: "Titanium in dark terminals, Light in light terminals" },
	{ value: "theme:titanium", label: "Titanium", description: "Default dark theme" },
	{ value: "theme:light", label: "Light", description: "Default light theme" },
	{ value: "browse", label: "Browse all…", description: "Show every built-in and custom theme" },
];

/** The `value` of each toggle row, so the select handler can recognise them. */
const COLORBLIND_TOGGLE = "toggle:colorblind";
const ASCII_TOGGLE = "toggle:ascii";

function fitLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function fillStyledLine(content: string, width: number): string {
	return content + padding(Math.max(0, width - visibleWidth(content)));
}

function renderMockStatusLine(width: number): string {
	const sep = theme.fg("statusLineSep", ` ${theme.sep.pipe} `);
	const left = [
		theme.fg("statusLineModel", withIcon(theme.icon.model, "sonnet")),
		theme.fg("statusLinePath", "~/project"),
		theme.fg("statusLineGitDirty", withIcon(theme.icon.git, "main +2")),
	].join(sep);
	const right = [
		theme.fg("statusLineContext", withIcon(theme.icon.context, "42%")),
		theme.fg("statusLineCost", withIcon(theme.icon.cost, "0.18")),
	].join(sep);
	const innerWidth = Math.max(1, width - 2);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = padding(Math.max(1, innerWidth - leftWidth - rightWidth - 2));
	return theme.bg("statusLineBg", fitLine(` ${left}${gap}${right} `, width));
}

function renderMockEditor(width: number): string[] {
	const box = theme.boxSharp;
	const innerWidth = Math.max(1, width - 2);
	const horizontal = box.horizontal.repeat(innerWidth);
	const top = theme.fg("borderAccent", `${box.topLeft}${horizontal}${box.topRight}`);
	const bottom = theme.fg("borderMuted", `${box.bottomLeft}${horizontal}${box.bottomRight}`);
	const prompt = `${theme.fg("accent", ">")} ${theme.fg("text", "Ask anything, edit files, run tools")}${theme.inverse(" ")}`;
	const hint = theme.fg("dim", "enter send · shift+enter newline · / commands");
	return [
		top,
		`${theme.fg("borderAccent", box.vertical)}${fitLine(prompt, innerWidth)}${theme.fg("borderAccent", box.vertical)}`,
		`${theme.fg("borderMuted", box.vertical)}${fillStyledLine(hint, innerWidth)}${theme.fg("borderMuted", box.vertical)}`,
		bottom,
	];
}

function renderThemePreview(width: number): string[] {
	const previewWidth = clampLow(width, 24, 88);
	return [
		theme.bold("Preview"),
		`${theme.fg("success", `${theme.status.success} success`)}  ${theme.fg("warning", `${theme.status.warning} warning`)}  ${theme.fg("error", `${theme.status.error} error`)}  ${theme.fg("accent", "accent")}`,
		"",
		theme.fg("muted", "Status line"),
		renderMockStatusLine(previewWidth),
		theme.fg("muted", "Editor"),
		...renderMockEditor(previewWidth),
	];
}

class ThemeSceneController implements SetupSceneController {
	title = "Pick a theme";
	subtitle = "Themes preview live as you move; nothing saves until you confirm.";
	#mode: ThemeMode = "curated";
	#selectList: SelectList;
	/** Live modifier state, applied to the preview and written on commit. */
	#colorBlindMode: boolean;
	#symbolPreset: SymbolPreset;
	#loadingAllThemes = false;
	#message: string | undefined;
	#previewRequest = 0;
	#disposed = false;
	/** Render line where the select list began, or -1 while it is not shown. */
	#listRowStart = -1;
	readonly #originalTheme = getCurrentThemeName();
	readonly #originalSymbolPreset: SymbolPreset;
	readonly #originalColorBlindMode: boolean;

	constructor(private readonly host: SetupSceneHost) {
		this.#originalSymbolPreset = host.ctx.settings.get("symbolPreset");
		this.#originalColorBlindMode = host.ctx.settings.get("colorBlindMode");
		this.#symbolPreset = this.#originalSymbolPreset;
		this.#colorBlindMode = this.#originalColorBlindMode;
		this.#selectList = this.#createSelectList(this.#curatedItems(), this.#currentCuratedIndex());
	}

	/**
	 * The curated rows: the themes, then the two modifiers with their state in
	 * the label. A toggle reads as a toggle because it says what it currently is,
	 * which is also what tells you that selecting it will not end the scene.
	 */
	#curatedItems(): readonly SelectItem[] {
		const mark = (on: boolean) => (on ? theme.checkbox.checked : theme.checkbox.unchecked);
		return [
			...THEME_ITEMS,
			// The descriptions are kept short on purpose. `SelectList` cuts a
			// description that does not fit its column with no ellipsis, so a long
			// one comes out ending mid-word; at 100 columns the pair that spelled
			// out "Applies to whichever theme you pick." on both rows lost its last
			// word on the second. The composing behaviour is said once, on the row
			// where it is least obvious.
			{
				value: COLORBLIND_TOGGLE,
				label: `${mark(this.#colorBlindMode)} Colorblind colors`,
				description: "Red/green contrast, on any theme",
			},
			{
				value: ASCII_TOGGLE,
				label: `${mark(this.#symbolPreset === "ascii")} ASCII glyphs`,
				description: "Plain ASCII box drawing and icons",
			},
		];
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		const quickIndex = data >= "1" && data <= "9" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#previewByIndex(quickIndex);
			return;
		}
		this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		// Mirror the pre-helper flow: wheel/motion are always processed, but a
		// hidden list (#listRowStart < 0, e.g. while loading all themes) must
		// never hit-test a row — route through a line that resolves to undefined.
		const listLine = this.#listRowStart >= 0 ? line - this.#listRowStart : Number.NEGATIVE_INFINITY;
		routeSelectListMouse(this.#selectList, event, listLine);
	}

	render(width: number): readonly string[] {
		// Curated mode has no hint row — start straight at the preview so every
		// scene keeps the same one-blank rhythm under the wizard header.
		const lines =
			this.#mode === "all" ? [theme.fg("dim", "Browsing all themes · Esc returns to curated choices"), ""] : [];
		lines.push(...renderThemePreview(width), "");
		if (this.#loadingAllThemes) {
			this.#listRowStart = -1;
			lines.push(theme.fg("dim", "Loading themes…"));
		} else {
			this.#listRowStart = lines.length;
			lines.push(...this.#selectList.render(width));
		}
		if (this.#message) {
			lines.push("", this.#message);
		}
		return lines;
	}

	#createSelectList(items: readonly SelectItem[], selectedIndex: number): SelectList {
		const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), getSelectListTheme());
		list.setSelectedIndex(selectedIndex);
		list.onSelectionChange = item => {
			void this.#preview(item.value);
		};
		list.onSelect = item => {
			void this.#select(item.value);
		};
		list.onCancel = () => {
			if (this.#mode === "all") {
				this.#mode = "curated";
				this.#selectList = this.#createSelectList(this.#curatedItems(), this.#currentCuratedIndex());
				this.host.requestRender();
				return;
			}
			this.#restorePreview();
			this.host.finish("skipped");
		};
		return list;
	}

	/** The row for the theme already in force, found by value rather than index. */
	#currentCuratedIndex(): number {
		const current = getCurrentThemeName();
		const value = current === undefined ? "auto" : `theme:${current}`;
		const index = THEME_ITEMS.findIndex(item => item.value === value);
		return index >= 0 ? index : 0;
	}

	#previewByIndex(index: number): void {
		const items = this.#mode === "curated" ? this.#curatedItems() : undefined;
		const value = items?.[index]?.value;
		if (value) void this.#preview(value);
	}

	/**
	 * Flip a modifier and stay in the scene.
	 *
	 * The preview repaints with the new combination and the row's label follows
	 * it, so the toggle is legible without a legend. The cursor is put back where
	 * it was: a list that jumps to the top under you is a list you cannot toggle
	 * twice.
	 */
	async #toggle(value: string): Promise<void> {
		if (value === COLORBLIND_TOGGLE) this.#colorBlindMode = !this.#colorBlindMode;
		if (value === ASCII_TOGGLE) this.#symbolPreset = this.#symbolPreset === "ascii" ? "unicode" : "ascii";

		// Rebuild BEFORE applying the preview. The scene's own fields are the
		// truth about what the toggles say, and repainting after an await meant a
		// preview that failed to load left the row disagreeing with the state
		// while the rejection went nowhere: `onSelect` returns void, so nothing
		// was ever going to report it.
		this.#rebuildCurated(this.#curatedIndexOf(value));
		this.#message = undefined;
		this.host.requestRender();

		try {
			await this.#applyPreviewPresentation(this.#symbolPreset, this.#colorBlindMode);
		} catch (error) {
			this.#message = theme.fg("error", `Could not preview that: ${errorMessage(error)}`);
		}
		// And rebuild AGAIN, because the marks are drawn with `theme.checkbox`,
		// which the ASCII toggle has just changed. Building them once left the two
		// rows drawing unicode boxes while everything else on screen, the preview
		// included, had switched to `[x]`, so the glyph the row used to report the
		// setting was the one glyph the setting did not apply to.
		this.#rebuildCurated(this.#curatedIndexOf(this.#selectList.getSelectedItem()?.value));
		this.host.ctx.ui.invalidate();
		this.host.requestRender();
	}

	/** Rebuild the curated rows from current state, keeping the cursor where it is. */
	#rebuildCurated(selectedIndex: number): void {
		this.#selectList = this.#createSelectList(this.#curatedItems(), selectedIndex);
	}

	/**
	 * The curated row carrying `value`, or the first row when there is none.
	 *
	 * By value rather than by index: the labels carry the toggle marks, so a
	 * rebuild replaces every row object, and the index is the only thing that
	 * survives it. The cursor is read back off the live list rather than assumed,
	 * because the rebuild after a preview happens on the far side of an await and
	 * the arrow keys keep working across it.
	 */
	#curatedIndexOf(value: string | undefined): number {
		if (value === undefined) return 0;
		return Math.max(
			0,
			this.#curatedItems().findIndex(item => item.value === value),
		);
	}

	async #select(value: string): Promise<void> {
		if (value === "browse") {
			await this.#showAllThemes();
			return;
		}
		if (value === COLORBLIND_TOGGLE || value === ASCII_TOGGLE) {
			await this.#toggle(value);
			return;
		}
		await this.#commit(value);
		this.host.finish("done");
	}

	async #showAllThemes(): Promise<void> {
		if (this.#loadingAllThemes) return;
		this.#loadingAllThemes = true;
		this.#message = undefined;
		this.host.requestRender();
		try {
			const themes = await getAvailableThemes();
			if (this.#disposed) return;
			const items = themes.map(name => ({
				value: `theme:${name}`,
				label: name,
				description: name === this.#originalTheme ? "current" : undefined,
			}));
			const selectedIndex = Math.max(0, themes.indexOf(this.#originalTheme ?? ""));
			this.#mode = "all";
			this.#selectList = this.#createSelectList(items, selectedIndex);
		} catch (error) {
			const message = errorMessage(error);
			this.#message = theme.fg("error", `Failed to load themes: ${message}`);
		} finally {
			this.#loadingAllThemes = false;
			this.host.requestRender();
		}
	}

	/**
	 * Write the chosen theme AND whatever the modifiers are set to.
	 *
	 * The modifiers are written on every commit, not only when they changed, so
	 * the config says what the wizard showed. Restoring `#originalColorBlindMode`
	 * here, which is what the theme rows used to do, silently discarded a toggle
	 * the user had just flipped.
	 */
	async #commit(value: string): Promise<void> {
		this.host.ctx.settings.set("colorBlindMode", this.#colorBlindMode);
		this.host.ctx.settings.set("symbolPreset", this.#symbolPreset);
		await this.#applyPreviewPresentation(this.#symbolPreset, this.#colorBlindMode);

		if (value === "auto") {
			this.host.ctx.settings.set("theme.dark", "titanium");
			this.host.ctx.settings.set("theme.light", "light");
			enableAutoTheme();
			return;
		}
		const themeName = this.#themeNameFromValue(value);
		if (!themeName) return;
		if (isLightTheme(themeName)) {
			this.host.ctx.settings.set("theme.light", themeName);
		} else {
			this.host.ctx.settings.set("theme.dark", themeName);
		}
		await previewTheme(themeName, { ephemeral: false });
	}

	async #preview(value: string): Promise<void> {
		const request = ++this.#previewRequest;
		this.#message = undefined;
		if (value === "browse") {
			this.host.requestRender();
			return;
		}

		// Moving onto a toggle previews the combination as it STANDS. The row says
		// what the modifier is; flipping it is what selecting it does, and a hover
		// that already flipped it would leave the label disagreeing with the paint.
		if (value === COLORBLIND_TOGGLE || value === ASCII_TOGGLE) {
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
			return;
		}

		let result: { success: boolean; error?: string } = { success: true };
		if (value === "auto") {
			await this.#applyPreviewPresentation(this.#symbolPreset, this.#colorBlindMode);
			enableAutoTheme({ ephemeral: true });
		} else {
			const themeName = this.#themeNameFromValue(value);
			if (themeName) {
				await this.#applyPreviewPresentation(this.#symbolPreset, this.#colorBlindMode);
				result = await previewTheme(themeName);
			}
		}
		if (request !== this.#previewRequest || this.#disposed) return;
		if (!result.success) {
			this.#message = theme.fg("error", result.error ?? "Theme preview failed");
		}
		this.host.ctx.ui.invalidate();
		this.host.requestRender();
	}

	async #applyPreviewPresentation(symbolPreset: SymbolPreset, colorBlindMode: boolean): Promise<void> {
		await setSymbolPreset(symbolPreset);
		await setColorBlindMode(colorBlindMode);
	}

	#restorePreview(): void {
		void (async () => {
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
			if (this.#originalTheme) {
				await previewTheme(this.#originalTheme);
			}
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		})();
	}

	#themeNameFromValue(value: string): string | undefined {
		return value.startsWith("theme:") ? value.slice("theme:".length) : undefined;
	}
}

export const themeSetupScene: SetupScene = {
	id: "theme",
	title: "Pick a theme",
	minVersion: 1,
	mount: host => new ThemeSceneController(host),
};
