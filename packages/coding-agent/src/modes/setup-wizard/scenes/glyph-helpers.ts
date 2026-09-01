import type { SelectItem } from "@veyyon/tui";
import { type SymbolPreset, theme } from "../../theme/theme";

export const GLYPH_PRESETS = ["nerd", "unicode", "ascii"] as const satisfies readonly SymbolPreset[];

export const GLYPH_LABELS: Readonly<Record<SymbolPreset, string>> = {
	nerd: "Nerd Font",
	unicode: "Unicode",
	ascii: "ASCII",
};

export const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	nerd: "      󰉋  ",
	unicode: "    F  ⬢  ╭─╮  ├─  •  ⠋  →",
	ascii: "[ok]  [x]  >  +  [D]  +-+  |--  *  ->",
};

export const GLYPH_ITEMS: readonly SelectItem[] = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: preset === "nerd" ? `${GLYPH_SAMPLES.nerd}  ╭─╮  ├─  ◆    ` : GLYPH_SAMPLES[preset],
}));

export function renderGlyphPreview(rows = Number.POSITIVE_INFINITY): string[] {
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
