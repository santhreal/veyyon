import { routeSelectListMouse, type SelectItem, type SelectList, type SgrMouseEvent } from "@veyyon/tui";
import { type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

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

const GLYPH_ITEMS: readonly SelectItem[] = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: preset === "nerd" ? `${GLYPH_SAMPLES.nerd}  ╭─╮  ├─  ◆    ` : GLYPH_SAMPLES[preset],
}));

function renderGlyphPreview(rows = Number.POSITIVE_INFINITY): string[] {
	const spinner = theme.getSpinnerFrames("activity")[0] ?? "-";
	const sep = theme.fg("dim", theme.sep.pipe);
	const sample = [
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
	if (rows < 2) return [];
	return sample.slice(0, rows);
}

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the preset that renders cleanly — boxes or tofu mean try another.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	readonly #originalPreset: SymbolPreset;
	#previewSettled: Promise<void> = Promise.resolve();
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		this.#selectList = createWizardList(GLYPH_ITEMS, GLYPH_ITEMS.length);
		const current = theme.getSymbolPreset();
		this.#originalPreset = current;
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

	onUnmount(): Promise<void> {
		if (this.#committing) return Promise.resolve();
		this.#previewRequest += 1;
		this.#previewSettled = this.#previewSettled.then(async () => {
			await setSymbolPreset(this.#originalPreset);
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
		return this.#previewSettled;
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#selectList);
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

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#committing) return;
		routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number, rows?: number): readonly string[] {
		const preview = renderGlyphPreview(rows === undefined ? undefined : rows - GLYPH_ITEMS.length - 1);
		const lines = preview.length > 0 ? preview.concat("") : [];
		this.#listRowStart = lines.length;
		const sl = this.#selectList.render(width);
		for (let li = 0; li < sl.length; li++) lines.push(sl[li]!);
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
		this.#previewSettled = this.#previewSettled.then(async () => {
			await setSymbolPreset(preset);
			if (request !== this.#previewRequest || this.#committing) return;
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
	}
}

export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	stepLabel: "Glyphs",
	title: "Choose glyph mode",
	minVersion: 1,
	mount: host => new GlyphSceneController(host),
};
