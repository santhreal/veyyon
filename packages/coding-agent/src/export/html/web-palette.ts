/**
 * Web/export palette — the veyyon brand identity shared by the collab-web live
 * client (`share.veyyon.dev/`) and every public HTML export / share viewer (`/s/<id>`).
 *
 * Why this exists separately from `modes/theme/dark.json`: the `dark` theme is
 * the **default TUI theme** — its amber accent (`#febc38`) drives the terminal
 * status line, syntax highlighting, thinking levels, and bash/python mode
 * colors for every veyyon user. The public web artifacts want the collab-web
 * black/silver/ember identity instead (pitch-black ground, silver structure,
 * the single ember-sun accent), so they pin this palette rather than inheriting
 * the TUI's. Editing `dark.json` to repurpose it for the web would repaint
 * every terminal; this file keeps the two surfaces decoupled.
 *
 * Token layout — emitted as CSS custom properties on `:root`:
 *   • Legacy export names consumed by `template.css` / `template.js`
 *     (`--text`, `--body-bg`, `--container-bg`, `--info-bg`, `--accent`,
 *      `--border`, `--success`, `--error`, `--warning`, `--muted`, `--dim`,
 *      `--borderAccent`, `--selectedBg`, `--userMessageBg`, `--customMessageBg`,
 *      `--customMessageLabel`, `--mdHeading`, `--mdLink`, `--mdCode`,
 *      `--mdListBullet`, `--toolOutput`, `--thinkingText`, syntax*, …).
 *   • collab-web-native aliases consumed by the `tv-` tool-render bridge
 *     (`tool-render.css`: `var(--bg-inset, …)`, `var(--fg, …)`, …) so embedded
 *     tool cards resolve to the *real* collab-web tokens and render
 *     pixel-identical to the live client.
 *
 * Alpha-bearing tokens (`--border`, `--ring`, `--accent-muted`, …) keep their
 * `oklch(… / N%)` form — flattening them to opaque hex would produce harsh
 * white borders and non-matching translucent focus rings. Opaque surfaces are
 * sRGB hex (the collab-web `tokens.css` OKLCH dark-theme tokens converted via
 * the standard OKLab→linear-sRGB→gamma path); if the live client palette
 * changes, regenerate those from there.
 */
export const WEB_EXPORT_PALETTE = {
	// --- collab-web-native aliases (tv- bridge) ---
	// Pitch-black ground everywhere; hierarchy comes from silver hairlines,
	// text weight, and the ember accent — never tinted/raised fills.
	"--bg": "#000000",
	"--bg-raised": "#000000",
	"--bg-inset": "#000000",
	"--bg-overlay": "#000000",
	"--fg": "#f6f7f9",
	"--fg-muted": "#b4bac4",
	"--fg-faint": "#7c828d",
	"--accent": "#f0862e", // ember sun
	"--accent-muted": "oklch(0.705 0.163 52 / 16%)",
	"--ok": "#7fb98a",
	"--err": "#c96f6e",
	"--warn": "#c9a24b",
	"--ring": "oklch(0.705 0.163 52 / 70%)", // ember focus ring
	"--font-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',

	// --- legacy export names (template.css / template.js) ---
	// surfaces — all pitch black, matching the collab-web tokens
	"--body-bg": "#000000", // = --bg
	"--container-bg": "#000000", // = --bg-raised
	"--info-bg": "#000000", // = --bg-inset (recessed wells: code blocks, tool output)
	// text
	"--text": "#f6f7f9", // = --fg
	"--muted": "#b4bac4", // = --fg-muted
	"--dim": "#7c828d", // = --fg-faint
	"--thinkingText": "#b4bac4",
	// hairlines — silver-alpha, matching collab-web's --border/--border-strong
	"--border": "rgba(198, 203, 212, 0.12)",
	"--borderMuted": "rgba(198, 203, 212, 0.08)",
	// accent border + the one permitted tinted surface (ember glow selection)
	"--borderAccent": "#f0862e", // ember
	"--selectedBg": "#241510", // ember glow
	// status — semantic, used sparingly (cancelled / exit-code / success dots)
	"--success": "#7fb98a", // = --ok
	"--error": "#c96f6e", // = --err
	"--warning": "#c9a24b", // = --warn
	// message bubbles
	"--userMessageBg": "oklch(0.705 0.163 52 / 6%)", // faint ember tint distinguishes user turns
	"--userMessageText": "#f6f7f9",
	"--customMessageBg": "#000000", // = --bg-overlay
	"--customMessageText": "#b4bac4", // = --fg-muted
	"--customMessageLabel": "#c6cbd4", // silver — labels are structure
	// tool surfaces
	"--toolPendingBg": "#000000",
	"--toolSuccessBg": "#000000",
	"--toolErrorBg": "oklch(0.62 0.12 25 / 14%)", // faint red error well
	"--toolTitle": "#f6f7f9",
	"--toolOutput": "#b4bac4", // = --fg-muted
	// markdown
	"--mdHeading": "#e6e9ee", // silver-hi — headings are structure
	"--mdLink": "#f0862e", // ember — links carry the accent
	"--mdLinkUrl": "#7c828d", // = --fg-faint
	"--mdCode": "#f6f7f9",
	"--mdCodeBlock": "#f6f7f9",
	"--mdCodeBlockBorder": "rgba(198, 203, 212, 0.12)",
	"--mdQuote": "#b4bac4",
	"--mdQuoteBorder": "rgba(198, 203, 212, 0.21)",
	"--mdHr": "rgba(198, 203, 212, 0.12)",
	"--mdListBullet": "#f0862e", // ember — bullets carry the accent
	// diff
	"--toolDiffAdded": "#7fb98a",
	"--toolDiffRemoved": "#c96f6e",
	"--toolDiffContext": "#7c828d",
	// syntax — silver-neutral base with ember/amber/green accents (no cyan/purple)
	"--syntaxComment": "#7c828d", // = --fg-faint
	"--syntaxKeyword": "#f0862e", // ember
	"--syntaxFunction": "#c9a24b", // amber
	"--syntaxVariable": "#c6cbd4", // silver
	"--syntaxString": "#7fb98a", // green
	"--syntaxNumber": "#fb9e44", // ember-hi
	"--syntaxType": "#e6e9ee", // silver-hi
	"--syntaxOperator": "#f6f7f9",
	"--syntaxPunctuation": "#b4bac4",
	// thinking-level ramp — escalates dim → silver → amber → ember → ember-hi
	"--thinkingOff": "#7c828d",
	"--thinkingMinimal": "#7c828d",
	"--thinkingLow": "#b4bac4",
	"--thinkingMedium": "#c9a24b",
	"--thinkingHigh": "#f0862e",
	"--thinkingXhigh": "#fb9e44",
	// mode tints (sidebar/role tags) — not surfaced in the export tree but
	// emitted for completeness so template.js role classes resolve cleanly
	"--bashMode": "#7fb98a", // green
	"--pythonMode": "#c9a24b", // amber
	// status-line tokens are TUI-only; not consumed by the export template, but
	// emitted so any future surface that reads them inherits the brand.
	"--statusLineBg": "#000000",
	"--statusLineSep": "#7c828d",
	"--statusLineModel": "#f0862e", // ember
	"--statusLinePath": "#c6cbd4", // silver
	"--statusLineGitClean": "#7fb98a", // green
	"--statusLineGitDirty": "#c9a24b", // amber
	"--statusLineContext": "#b4bac4",
	"--statusLineSpend": "#c6cbd4", // silver
	"--statusLineStaged": "#7fb98a", // green
	"--statusLineDirty": "#c9a24b", // amber
	"--statusLineUntracked": "#c96f6e", // red
	"--statusLineOutput": "#b4bac4",
	"--statusLineCost": "#c6cbd4", // silver
	"--statusLineSubagents": "#f0862e", // ember
} as const satisfies Record<string, string>;

/** Serialize the palette as `--key: value;` declarations for `:root { … }`. */
export function webExportThemeVars(): string {
	let out = "";
	for (const k in WEB_EXPORT_PALETTE) {
		out += `${k}: ${WEB_EXPORT_PALETTE[k as keyof typeof WEB_EXPORT_PALETTE]}; `;
	}
	return out.trimEnd();
}
