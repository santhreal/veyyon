import { supportsLanguage as nativeSupportsLanguage } from "@veyyon/natives";
import type { MarkdownTheme } from "@veyyon/tui";
import { registerSettingsTestResetHook } from "../../config/settings-instance";
import { highlightCached } from "./highlight";
import { resolveMermaidAscii } from "./mermaid-cache";
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
registerSettingsTestResetHook(() => {
	setMarkdownMermaidRendering(true);
});
