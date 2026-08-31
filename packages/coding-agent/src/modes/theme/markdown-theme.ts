/**
 * The markdown renderer's view of the active theme.
 *
 * WHY IT IS NOT IN `theme.ts`. `getMarkdownTheme` builds an adapter: it maps the palette onto the
 * roles `@veyyon/tui`'s `Markdown` component asks for, and it binds a mermaid renderer to those
 * colours. That last part is the reason for this file. `./mermaid-cache` reaches 36 modules of
 * diagram machinery, and while this function lived in `theme.ts` every consumer of a palette paid
 * for them: 291 test files import that module, and the great majority never render a diagram. Ask
 * for a colour, get an ASCII diagram engine.
 *
 * So the rule is the same one applied to the `@veyyon/ai` barrel imports recorded in
 * `test/architecture/leveraged-imports-stay-cut.test.ts`: import the value from the module that owns
 * it. A component that renders markdown imports this file and pays the mermaid cost, which is a cost
 * it was always going to pay. A module that wants `theme.fg(...)` imports `./theme` and does not.
 *
 * The memoisation is per active `Theme` INSTANCE, not per call: `Markdown` asks for the theme on
 * every construction and a fresh object each time would defeat the component's own comparisons.
 * `cachedMarkdownThemeRef` is what makes a theme switch rebuild it, since every switch reassigns the
 * binding.
 */

import { supportsLanguage as nativeSupportsLanguage } from "@veyyon/natives";
import type { MarkdownTheme } from "@veyyon/tui";
// The slot leaf, not the store: this file only REGISTERS teardown, which is a `Set.add`.
import { registerSettingsTestResetHook } from "../../config/settings-instance";
import { highlightCached } from "./highlight";
import { resolveMermaidAscii } from "./mermaid-cache";
// The leaf, not `./theme`: the engine is 144 marginal modules on this graph and this file needs one
// symbol set. `./theme-binding` and `./symbol-theme` are the two leaves that answer "what is active now".
import { getSymbolTheme } from "./symbol-theme";
import { theme } from "./theme-binding";
import type { Theme } from "./theme-class";

let cachedMarkdownTheme: MarkdownTheme | undefined;
let cachedMarkdownThemeRef: Theme | undefined;
let markdownMermaidRendering = true;

export function setMarkdownMermaidRendering(enabled: boolean): void {
	if (markdownMermaidRendering === enabled) return;
	markdownMermaidRendering = enabled;
	cachedMarkdownTheme = undefined;
}

export function getMarkdownTheme(): MarkdownTheme {
	if (cachedMarkdownTheme !== undefined && cachedMarkdownThemeRef === theme) {
		return cachedMarkdownTheme;
	}
	const mermaid = markdownMermaidRendering
		? (() => {
				// Mermaid ASCII diagrams render with the active palette so they read as
				// content rather than raw monochrome. Roles mirror the SVG renderer's
				// mapping; `text`/`muted`/`border`/`borderMuted`/`accent` exist in every theme.
				const mermaidColorMode =
					theme.getColorMode() === "truecolor" ? ("truecolor" as const) : ("ansi256" as const);
				const mermaidTheme = {
					fg: theme.getColorHex("text"),
					border: theme.getColorHex("border"),
					line: theme.getColorHex("muted"),
					arrow: theme.getColorHex("accent"),
					corner: theme.getColorHex("muted"),
					junction: theme.getColorHex("borderMuted"),
				};
				return { mermaidColorMode, mermaidTheme };
			})()
		: undefined;
	const markdownTheme: MarkdownTheme = {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		// Designed fence rows: literal ``` markers read as UNRENDERED markdown
		// (the "this is rendering raw" report), so fenced blocks open with a
		// short rule + language tag and close with the bare rule — the same
		// dim-rule section language the transcript already speaks (compaction
		// marker, cache-miss marker). Chrome stays quiet: one dim token, no
		// motion, no backticks.
		codeBlockFence: (lang, pos) =>
			theme.fg(
				"mdCodeBlockBorder",
				pos === "open" && lang
					? `${theme.boxSharp.horizontal.repeat(2)}╴${lang}`
					: theme.boxSharp.horizontal.repeat(2),
			),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => theme.strikethrough(text),
		symbols: getSymbolTheme(),
		resolveMermaidAscii: mermaid
			? (source, maxWidth) =>
					resolveMermaidAscii(source, {
						maxWidth,
						theme: mermaid.mermaidTheme,
						colorMode: mermaid.mermaidColorMode,
					})
			: undefined,
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
			const highlighted = highlightCached(code, validLang, theme);
			if (highlighted !== null) return highlighted.split("\n");
			return code.split("\n").map(line => theme.fg("mdCodeBlock", line));
		},
	};
	cachedMarkdownTheme = markdownTheme;
	cachedMarkdownThemeRef = theme;
	return markdownTheme;
}
/**
 * Put `markdownMermaidRendering` back to what a freshly started process has.
 *
 * WHY IT EXISTS. The flag is module scope and survives `resetSettingsForTest`, so ANY suite driving
 * `SelectorController.handleSettingChange("tui.renderMermaid", false)` turned diagram rendering off
 * for the rest of the process. Every later mermaid assertion then measured the fenced-source fallback
 * (a dim rule plus verbatim source) instead of a diagram, which reads as "the renderer produced
 * nothing" rather than as "someone else switched it off", and it looked timing-dependent because the
 * hook fires asynchronously off a settings signal.
 *
 * Restoring through the SETTER rather than by assigning the variable, because the setter also drops
 * the memoised `cachedMarkdownTheme`, and that cache is what actually carries a disabled renderer
 * into the next suite.
 *
 * Registered here rather than in `theme.ts`, which is where it used to live: a module owns the reset
 * of its own ambient state, and a suite that never loads this file has no such state to restore.
 */
registerSettingsTestResetHook(() => {
	setMarkdownMermaidRendering(true);
});
