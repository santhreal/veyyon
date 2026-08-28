/** The markdown renderer's view of the active theme. roles `@veyyon/tui`'s `Markdown` component asks for, and it binds a mermaid renderer to those */

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
		// Designed fence rows: literal ``` markers read as UNRENDERED markdown (the "this is rendering raw" report), so fenced blocks open with a
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
			const codeLines = code.split("\n");
			const themed: string[] = new Array<string>(codeLines.length);
			for (let ci = 0; ci < codeLines.length; ci++) themed[ci] = theme.fg("mdCodeBlock", codeLines[ci]!);
			return themed;
		},
	};
	cachedMarkdownTheme = markdownTheme;
	cachedMarkdownThemeRef = theme;
	return markdownTheme;
}
/** Put `markdownMermaidRendering` back to what a freshly started process has. `SelectorController.handleSettingChange("tui.renderMermaid", false)` turned diagram rendering off */
registerSettingsTestResetHook(() => {
	setMarkdownMermaidRendering(true);
});
