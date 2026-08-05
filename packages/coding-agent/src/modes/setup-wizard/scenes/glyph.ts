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
 *
 * `rows` caps its height; see the trimming note below.
 */
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
	// Trimmed from the tail on a short terminal, and dropped whole rather than
	// left as a "Preview" heading over nothing. The three picker rows carry live
	// sample glyphs of their own, so the sample is what this scene can afford to
	// lose; the rows that choose the preset are not.
	if (rows < 2) return [];
	return sample.slice(0, rows);
}

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the preset that renders cleanly — boxes or tofu mean try another.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	/** The preset the step found, put back when it ends without a choice. */
	readonly #originalPreset: SymbolPreset;
	/**
	 * The most recent preview still in flight, so the restore on the way out
	 * cannot land BEFORE the preview it is undoing and be overwritten by it.
	 */
	#previewSettled: Promise<void> = Promise.resolve();
	/** Render line where the select list begins. */
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
		// Unreachable through the wizard, which owns Esc and ctrl+c and only hands
		// Esc to a scene that claims it. Kept so the list is complete on its own
		// terms; leaving the step, and the restore that goes with it, is
		// `onUnmount`'s job for every route out.
		this.#selectList.onCancel = () => host.finish("skipped");
	}

	/**
	 * Put the glyph preset back when the step ends without a choice.
	 *
	 * Moving the highlight applies the preset to the WHOLE running UI, which is
	 * the point: you judge a preset by whether the real chrome renders. But Esc,
	 * `→` and `←` all left the last-hovered preset in force for the rest of the
	 * session while `symbolPreset` in the config still said something else, so a
	 * user who arrowed past ASCII and skipped the step ran the session in ASCII
	 * with no setting on screen that explained it.
	 *
	 * Returns the restore so a caller can await it; the wizard does not.
	 */
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

	/**
	 * Three presets never overflow three rows, so this list is not searchable
	 * today and this returns nothing. It is wired anyway: every scene that mounts
	 * a list answers Esc the same way, so adding a preset cannot quietly turn Esc
	 * back into "end the run" the way it did on the theme step.
	 */
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

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#committing) return;
		routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number, rows?: number): readonly string[] {
		// The three preset rows are the step; the sample above them is how you
		// judge them. At 80x24 the body budget is eight rows and preview plus
		// blank plus list wanted nine, so the wizard's overflow notice ate a
		// preset row: the scene asked you to pick between three options and
		// showed one. The sample yields its rows instead.
		const preview = renderGlyphPreview(rows === undefined ? undefined : rows - GLYPH_ITEMS.length - 1);
		const lines = preview.length > 0 ? [...preview, ""] : [];
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
		// Chained, not launched beside the previous one: each call mutates the one
		// global preset, so two in flight leave the terminal in whichever finished
		// last. It is also what lets `onUnmount`'s restore be the LAST thing
		// applied rather than racing the hover that prompted it.
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
