import { routeSelectListMouse, type SelectItem, type SelectList, type SgrMouseEvent } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import {
	enableAutoTheme,
	getAvailableThemes,
	getCurrentThemeName,
	isLightTheme,
	previewTheme,
	type SymbolPreset,
	setColorBlindMode,
	setSymbolPreset,
	theme,
} from "../../theme/theme";
import type { ThemeMode } from "./theme-helpers";
import {
	ASCII_TOGGLE,
	COLORBLIND_TOGGLE,
	MIN_LIST_ROWS,
	PREVIEW_TRAILING_BLANK,
	renderThemePreview,
	THEME_ITEMS,
} from "./theme-helpers";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

class ThemeSceneController implements SetupSceneController {
	title = "Pick a theme";
	subtitle = "Themes preview live as you move; nothing saves until you confirm.";
	#mode: ThemeMode = "curated";
	#selectList: SelectList;
	#colorBlindMode: boolean;
	#symbolPreset: SymbolPreset;
	#loadingAllThemes = false;
	#message: string | undefined;
	#previewRequest = 0;
	#disposed = false;
	#committed = false;
	#previewSettled: Promise<void> = Promise.resolve();
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

	#curatedItems(): readonly SelectItem[] {
		const mark = (on: boolean) => (on ? theme.checkbox.checked : theme.checkbox.unchecked);
		return [
			...THEME_ITEMS,
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

	onUnmount(): Promise<void> {
		if (this.#committed) return Promise.resolve();
		return this.#restorePreview();
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	escapeAction(): SetupKeyHint | undefined {
		return (
			filterEscapeHint(this.#selectList) ??
			(this.#mode === "all" ? { keys: "esc", label: "back to curated" } : undefined)
		);
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

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const listLine = this.#listRowStart >= 0 ? line - this.#listRowStart : Number.NEGATIVE_INFINITY;
		routeSelectListMouse(this.#selectList, event, listLine);
	}

	render(width: number, rows?: number): readonly string[] {
		const lines =
			this.#mode === "all" ? [theme.fg("dim", "Browsing all themes · Esc returns to curated choices"), ""] : [];
		const messageRows = this.#message ? 2 : 0;
		const previewRows =
			rows === undefined
				? undefined
				: Math.max(0, rows - lines.length - messageRows - MIN_LIST_ROWS - PREVIEW_TRAILING_BLANK);
		const tp = renderThemePreview(width, previewRows);
		for (let li = 0; li < tp.length; li++) lines.push(tp[li]!);
		lines.push("");
		if (this.#loadingAllThemes) {
			this.#listRowStart = -1;
			lines.push(theme.fg("dim", "Loading themes…"));
		} else {
			this.#listRowStart = lines.length;
			if (rows !== undefined) {
				this.#selectList.setRowBudget(Math.max(1, rows - lines.length - messageRows));
			}
			const sl = this.#selectList.render(width);
			for (let li = 0; li < sl.length; li++) lines.push(sl[li]!);
		}
		if (this.#message) {
			lines.push("", this.#message);
		}
		return lines;
	}

	#createSelectList(items: readonly SelectItem[], selectedIndex: number): SelectList {
		const list = createWizardList(items, Math.min(10, Math.max(1, items.length)));
		list.setSelectedIndex(selectedIndex);
		list.onSelectionChange = item => {
			void this.#queue(() => this.#preview(item.value));
		};
		list.onSelect = item => {
			void this.#queue(() => this.#select(item.value));
		};
		list.onCancel = () => {
			if (this.#mode !== "all") return;
			this.#mode = "curated";
			this.#selectList = this.#createSelectList(this.#curatedItems(), this.#currentCuratedIndex());
			this.host.requestRender();
		};
		return list;
	}

	#currentCuratedIndex(): number {
		const current = getCurrentThemeName();
		const value = current === undefined ? "auto" : `theme:${current}`;
		const index = THEME_ITEMS.findIndex(item => item.value === value);
		return index >= 0 ? index : 0;
	}

	#previewByIndex(index: number): void {
		const items = this.#mode === "curated" ? this.#curatedItems() : undefined;
		const value = items?.[index]?.value;
		if (value) void this.#queue(() => this.#preview(value));
	}

	#queue(work: () => Promise<void>): Promise<void> {
		const next = this.#previewSettled.then(work);
		this.#previewSettled = next.catch(error => {
			this.#message = theme.fg("error", `Could not preview that: ${errorMessage(error)}`);
			this.host.requestRender();
		});
		return this.#previewSettled;
	}

	async #toggle(value: string): Promise<void> {
		if (value === COLORBLIND_TOGGLE) this.#colorBlindMode = !this.#colorBlindMode;
		if (value === ASCII_TOGGLE) this.#symbolPreset = this.#symbolPreset === "ascii" ? "unicode" : "ascii";

		this.#rebuildCurated(this.#curatedIndexOf(value));
		this.#message = undefined;
		this.host.requestRender();

		try {
			await this.#applyPreviewPresentation(this.#symbolPreset, this.#colorBlindMode);
		} catch (error) {
			this.#message = theme.fg("error", `Could not preview that: ${errorMessage(error)}`);
		}
		this.#rebuildCurated(this.#curatedIndexOf(this.#selectList.getSelectedItem()?.value));
		this.host.ctx.ui.invalidate();
		this.host.requestRender();
	}

	#rebuildCurated(selectedIndex: number): void {
		this.#selectList = this.#createSelectList(this.#curatedItems(), selectedIndex);
	}

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

	async #commit(value: string): Promise<void> {
		this.#committed = true;
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

	#restorePreview(): Promise<void> {
		this.#previewSettled = this.#previewSettled.then(async () => {
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
			if (this.#originalTheme) {
				await previewTheme(this.#originalTheme);
			} else {
				enableAutoTheme({ ephemeral: true });
			}
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
		return this.#previewSettled;
	}

	#themeNameFromValue(value: string): string | undefined {
		return value.startsWith("theme:") ? value.slice("theme:".length) : undefined;
	}
}

export const themeSetupScene: SetupScene = {
	id: "theme",
	stepLabel: "Theme",
	title: "Pick a theme",
	minVersion: 1,
	mount: host => new ThemeSceneController(host),
};
