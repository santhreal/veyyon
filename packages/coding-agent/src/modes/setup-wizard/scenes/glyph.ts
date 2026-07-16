import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@veyyon/pi-tui";
import { getSelectListTheme, type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const GLYPH_PRESETS = ["nerd", "unicode", "ascii"] as const satisfies readonly SymbolPreset[];

const GLYPH_LABELS: Readonly<Record<SymbolPreset, string>> = {
	nerd: "Nerd Font",
	unicode: "Unicode",
	ascii: "ASCII",
};

const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	nerd: "      󰉋  ",
	unicode: "    F  ⬢  ╭─╮  ├─  •  ⠋  →",
	ascii: "[ok]  [x]  >  +  [D]  +-+  |--  *  ->",
};

/** One picker row per preset; the description column shows live sample glyphs instead of prose. */
const GLYPH_ITEMS: readonly SelectItem[] = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: preset === "nerd" ? `${GLYPH_SAMPLES.nerd}  ╭─╮  ├─  ◆    ` : GLYPH_SAMPLES[preset],
}));

/**
 * A live sample of real Veyyon chrome — status marks, a spinner frame, tree
 * connectors, the file glyph, checkboxes and the prompt cursor — rendered with
 * the highlighted preset (which {@link GlyphSceneController.#preview} applies
 * before each render, so the panel updates in place as the highlight moves).
 * Every glyph here resolves to something meaningful in all three presets, so a
 * blank or a box reads as a genuine terminal gap rather than an intentional one.
 */
function renderGlyphPreview(): string[] {
	const spinner = theme.getSpinnerFrames("activity")[0] ?? "-";
	const sep = theme.fg("dim", theme.sep.pipe);
	return [
		theme.bold("Preview"),
		[
			theme.fg("success", `${theme.status.success} 3 formatted`),
			theme.fg("warning", `${theme.status.warning} 1 lint`),
			theme.fg("error", `${theme.status.error} 0 failed`),
		].join(sep),
		theme.fg("muted", `${theme.tree.branch} ${theme.checkbox.checked} ${theme.icon.file} src/app.ts`),
		theme.fg("muted", `${theme.tree.last} ${theme.checkbox.unchecked} ${theme.icon.file} src/app.test.ts`),
		`${theme.fg("dim", `${spinner} running tests…`)}    ${theme.fg("accent", `${theme.nav.cursor} ready`)}`,
	];
}

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the preset that renders cleanly — boxes or tofu mean try another.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	/** Render line where the select list begins. */
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		this.#selectList = new SelectList(GLYPH_ITEMS, GLYPH_ITEMS.length, getSelectListTheme());
		const current = theme.getSymbolPreset();
		const currentIndex = GLYPH_PRESETS.indexOf(current);
		this.#selectList.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value as SymbolPreset);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value as SymbolPreset);
		};
		this.#selectList.onCancel = () => host.finish("skipped");
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data >= "1" && data <= "3" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			const preset = GLYPH_PRESETS[quickIndex];
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(preset);
			return;
		}
		this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#committing) return;
		routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number): readonly string[] {
		const lines = [...renderGlyphPreview(), ""];
		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #commit(preset: SymbolPreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		this.host.ctx.settings.set("symbolPreset", preset);
		await setSymbolPreset(preset);
		this.host.ctx.ui.invalidate();
		this.host.finish("done");
	}

	#preview(preset: SymbolPreset): void {
		const request = ++this.#previewRequest;
		void setSymbolPreset(preset).then(() => {
			if (request !== this.#previewRequest || this.#committing) return;
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
	}
}

export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	minVersion: 1,
	mount: host => new GlyphSceneController(host),
};
