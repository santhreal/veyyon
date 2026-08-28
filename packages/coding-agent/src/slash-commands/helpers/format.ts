import { SUB_CELL_BAR_RAMP, subCellBar, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";
import { shimmerText } from "../../modes/theme/shimmer";
import { theme as currentTheme, type Theme } from "../../modes/theme/theme";

/** Format a millisecond duration as a coarse-grained human label. */
// Coarse, single-unit duration for compact status lines: rounds to the nearest one of s/m/h/d and shows only that unit ("3m", "5h", "2d"). This is a
export function formatDurationCoarse(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

type ProgressBarTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;

const unstyledProgressBarTheme: ProgressBarTheme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
	getFgAnsi() {
		return "";
	},
};

function resolveProgressBarTheme(uiTheme: ProgressBarTheme | undefined): ProgressBarTheme {
	return uiTheme ?? currentTheme ?? unstyledProgressBarTheme;
}

/** Render a progress bar with a trailing percent label. `fraction` is clamped to `[0, 1]`. `undefined` renders a dotted placeholder. */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	if (fraction === undefined) return `[${shimmerText("·".repeat(width), progressBarTheme)}]`;
	const clamped = clamp01(fraction);
	const pct = Math.round(clamped * 100);
	// `typeof` rather than a nullish check: the binding is declared `Theme` and is
	// genuinely unset until a theme is applied (see `fgOrPlain` in theme.ts).
	const ramp = typeof currentTheme === "undefined" ? SUB_CELL_BAR_RAMP : currentTheme.getBarRamp();
	return `[${shimmerText(subCellBar(clamped, width, { ramp }), progressBarTheme)}] ${pct}%`;
}

/** Narrowest column the window label occupies before its bar, so stacked windows line their bars up. Sized for the labels providers ACTUALLY send. Both account surfaces started at 4, which fits the */
export const USAGE_WINDOW_LABEL_COLUMN = 8;

/** Longest window label rendered before it is clipped; past this the label would eat the bar. Wide enough for a qualified label (`Daily · Anthropic`), because the qualifier is the ONLY thing */
export const USAGE_WINDOW_LABEL_MAX = 20;

/** The column a group of windows shares, so their bars align without padding a short group out to the maximum. One account's windows are laid out together; two accounts need not agree. */
export function usageWindowLabelColumn(labels: readonly string[]): number {
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, visibleWidth(truncateToWidth(label, USAGE_WINDOW_LABEL_MAX)));
	return Math.max(USAGE_WINDOW_LABEL_COLUMN, widest + 1);
}

/** One usage window as both account surfaces print it: `7 Day [███▍░░░░░░] 34% resets in 4h`. ONE owner for the layout, because the two surfaces have to agree: they sit next to each other in */
export function formatUsageWindowLine(
	label: string,
	usedFraction: number | undefined,
	barWidth: number,
	resetsSuffix?: string,
	labelColumn: number = USAGE_WINDOW_LABEL_COLUMN,
): string {
	const clipped = truncateToWidth(label, USAGE_WINDOW_LABEL_MAX);
	const padded = clipped + " ".repeat(Math.max(1, labelColumn - visibleWidth(clipped)));
	return `${padded}${renderAsciiBar(usedFraction, barWidth)}${resetsSuffix ?? ""}`;
}

/** Vendor spellings for the slug segments whose mechanical title case is factually wrong. Every value here is the spelling this repo already uses for that vendor, so the account card and */
export const PROVIDER_NAME_SEGMENTS: ReadonlyMap<string, string> = new Map([
	["ai", "AI"],
	["aimlapi", "AIML API"],
	["ams", "AMS"],
	["cli", "CLI"],
	["cn", "CN"],
	["coreweave", "CoreWeave"],
	["deepseek", "DeepSeek"],
	["github", "GitHub"],
	["gitlab", "GitLab"],
	["huggingface", "Hugging Face"],
	["litellm", "LiteLLM"],
	["minimax", "MiniMax"],
	["nanogpt", "NanoGPT"],
	["nvidia", "NVIDIA"],
	["oauth", "OAuth"],
	["openai", "OpenAI"],
	["opencode", "OpenCode"],
	["openrouter", "OpenRouter"],
	["sgp", "SGP"],
	["vllm", "vLLM"],
	["xai", "xAI"],
	["zai", "zAI"],
	["zenmux", "ZenMux"],
]);

/** Render a provider slug the way a person writes it: `openai-codex` becomes `OpenAI Codex`. Three surfaces showed the same provider name (the `/usage` report, the usage CLI, and the command */
export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part =>
			part ? (PROVIDER_NAME_SEGMENTS.get(part.toLowerCase()) ?? part[0].toUpperCase() + part.slice(1)) : "",
		)
		.join(" ");
}
