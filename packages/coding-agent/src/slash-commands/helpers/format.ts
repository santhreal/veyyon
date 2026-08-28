import { SUB_CELL_BAR_RAMP, subCellBar, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";
import { shimmerText } from "../../modes/theme/shimmer";
import { theme as currentTheme, type Theme } from "../../modes/theme/theme";

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

export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	if (fraction === undefined) return `[${shimmerText("·".repeat(width), progressBarTheme)}]`;
	const clamped = clamp01(fraction);
	const pct = Math.round(clamped * 100);
	const ramp = typeof currentTheme === "undefined" ? SUB_CELL_BAR_RAMP : currentTheme.getBarRamp();
	return `[${shimmerText(subCellBar(clamped, width, { ramp }), progressBarTheme)}] ${pct}%`;
}

export const USAGE_WINDOW_LABEL_COLUMN = 8;

export const USAGE_WINDOW_LABEL_MAX = 20;

export function usageWindowLabelColumn(labels: readonly string[]): number {
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, visibleWidth(truncateToWidth(label, USAGE_WINDOW_LABEL_MAX)));
	return Math.max(USAGE_WINDOW_LABEL_COLUMN, widest + 1);
}

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

export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part =>
			part ? (PROVIDER_NAME_SEGMENTS.get(part.toLowerCase()) ?? part[0].toUpperCase() + part.slice(1)) : "",
		)
		.join(" ");
}
