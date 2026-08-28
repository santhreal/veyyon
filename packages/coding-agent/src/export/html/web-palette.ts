export const EXPORT_FALLBACK_BASE_BG = "#000000";

export const WEB_EXPORT_PALETTE = {
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

	"--body-bg": "#000000", // = --bg
	"--container-bg": "#000000", // = --bg-raised
	"--info-bg": "#000000", // = --bg-inset (recessed wells: code blocks, tool output)
	"--text": "#f6f7f9", // = --fg
	"--muted": "#b4bac4", // = --fg-muted
	"--dim": "#7c828d", // = --fg-faint
	"--thinkingText": "#b4bac4",
	"--border": "rgba(198, 203, 212, 0.12)",
	"--borderMuted": "rgba(198, 203, 212, 0.08)",
	"--borderAccent": "#f0862e", // ember
	"--selectedBg": "#241510", // ember glow
	"--success": "#7fb98a", // = --ok
	"--error": "#c96f6e", // = --err
	"--warning": "#c9a24b", // = --warn
	"--userMessageBg": "oklch(0.705 0.163 52 / 6%)", // faint ember tint distinguishes user turns
	"--userMessageText": "#f6f7f9",
	"--customMessageBg": "#000000", // = --bg-overlay
	"--customMessageText": "#b4bac4", // = --fg-muted
	"--customMessageLabel": "#c6cbd4", // silver — labels are structure
	"--toolPendingBg": "#000000",
	"--toolSuccessBg": "#000000",
	"--toolErrorBg": "oklch(0.62 0.12 25 / 14%)", // faint red error well
	"--toolTitle": "#f6f7f9",
	"--toolOutput": "#b4bac4", // = --fg-muted
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
	"--toolDiffAdded": "#7fb98a",
	"--toolDiffRemoved": "#c96f6e",
	"--toolDiffContext": "#7c828d",
	"--syntaxComment": "#7c828d", // = --fg-faint
	"--syntaxKeyword": "#f0862e", // ember
	"--syntaxFunction": "#c9a24b", // amber
	"--syntaxVariable": "#c6cbd4", // silver
	"--syntaxString": "#7fb98a", // green
	"--syntaxNumber": "#fb9e44", // ember-hi
	"--syntaxType": "#e6e9ee", // silver-hi
	"--syntaxOperator": "#f6f7f9",
	"--syntaxPunctuation": "#b4bac4",
	"--thinkingOff": "#7c828d",
	"--thinkingMinimal": "#7c828d",
	"--thinkingLow": "#b4bac4",
	"--thinkingMedium": "#c9a24b",
	"--thinkingHigh": "#f0862e",
	"--thinkingXhigh": "#fb9e44",
	"--bashMode": "#7fb98a", // green
	"--pythonMode": "#c9a24b", // amber
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

export function webExportThemeVars(): string {
	let out = "";
	for (const k in WEB_EXPORT_PALETTE) {
		out += `${k}: ${WEB_EXPORT_PALETTE[k as keyof typeof WEB_EXPORT_PALETTE]}; `;
	}
	return out.trimEnd();
}
