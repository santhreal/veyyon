import { truncateToWidth, visibleWidth } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";
import { shimmerText } from "../../modes/theme/shimmer";
import { theme as currentTheme, type Theme } from "../../modes/theme/theme";

/** Format a millisecond duration as a coarse-grained human label. */
// Coarse, single-unit duration for compact status lines: rounds to the nearest
// one of s/m/h/d and shows only that unit ("3m", "5h", "2d"). This is a
// deliberately different contract from @veyyon/utils formatDuration, which is
// fine-grained and compound ("3m20s", "2h15m", "5d3h") and floors. Keep the
// names distinct so a reader never confuses the two at a call site.
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

/**
 * Render an ASCII progress bar with a trailing percent label.
 * `fraction` is clamped to `[0, 1]`. `undefined` renders a dotted placeholder.
 */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	if (fraction === undefined) return `[${shimmerText("·".repeat(width), progressBarTheme)}]`;
	const clamped = clamp01(fraction);
	const filled = Math.round(clamped * width);
	const pct = Math.round(clamped * 100);
	const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
	return `[${shimmerText(bar, progressBarTheme)}] ${pct}%`;
}

/**
 * Narrowest column the window label occupies before its bar, so stacked windows line their bars up.
 *
 * Sized for the labels providers ACTUALLY send. Both account surfaces started at 4, which fits the
 * `5h` / `7d` shorthand a fixture invents and nothing a provider returns: Anthropic sends
 * `5 Hour` and `7 Day`, Antigravity `Daily`, Codex `7 days`. At 4 the pad was a no-op, so the bar
 * butted straight against the label (`5 Hour[████░░░░░░]`) and two windows of different label
 * lengths started their bars in different columns.
 */
export const USAGE_WINDOW_LABEL_COLUMN = 8;

/**
 * Longest window label rendered before it is clipped; past this the label would eat the bar.
 *
 * Wide enough for a qualified label (`Daily · Anthropic`), because the qualifier is the ONLY thing
 * telling two bars of one account apart. At 12 the three Antigravity counters clipped to
 * `Daily · Ant…`, `Daily · Goo…`, `Daily · Ope…` — an ellipsis exactly where the identity is.
 */
export const USAGE_WINDOW_LABEL_MAX = 20;

/**
 * The column a group of windows shares, so their bars align without padding a short group out to
 * the maximum. One account's windows are laid out together; two accounts need not agree.
 */
export function usageWindowLabelColumn(labels: readonly string[]): number {
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, visibleWidth(truncateToWidth(label, USAGE_WINDOW_LABEL_MAX)));
	return Math.max(USAGE_WINDOW_LABEL_COLUMN, widest + 1);
}

/**
 * One usage window as both account surfaces print it: `7 Day    [███░░░░░░░] 34%   resets in 4h`.
 *
 * ONE owner for the layout, because the two surfaces have to agree: they sit next to each other in
 * the same session, and a bar that starts one column further left in `/account` than on the card
 * reads as a rendering bug in whichever one you saw second.
 */
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

/**
 * Vendor spellings for the slug segments whose mechanical title case is factually wrong.
 *
 * Every value here is the spelling this repo already uses for that vendor, so the account card and
 * the usage surfaces cannot disagree with the catalog and the CLI help about how a name is written:
 * `catalogDiscovery.label` in `packages/catalog/src/provider-models/descriptors.ts` ("AIML API",
 * "CoreWeave Serverless Inference", "DeepSeek", "Hugging Face", "NanoGPT", "NVIDIA", "OpenRouter",
 * "ZenMux", "xAI Grok OAuth"), the discovery display names ("GitHub Copilot" in
 * `discovery/github.ts`, "OpenCode" in `discovery/opencode.ts`), and the env-var help in
 * `cli/args.ts` ("xAI Grok models", "MiniMax models", "z.ai models"). A segment is listed only when
 * a vendor writes it in a way title case cannot reach; anything else keeps the mechanical rule, so
 * a new provider slug still renders without an entry here.
 *
 * The catalog descriptor is the authority when two in-repo spellings differ, which is why `zai`
 * resolves to "zAI" (`catalogDiscovery.label`) and not to the "z.ai" of the env-var help: that keeps
 * one name for one provider, and it matches how `xai` already renders.
 *
 * A Map, not an object literal: these keys come from a provider id a user can type into config, and
 * a plain record answers `constructor` with a function.
 */
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

/**
 * Render a provider slug the way a person writes it: `openai-codex` becomes `OpenAI Codex`.
 *
 * Three surfaces showed the same provider name (the `/usage` report, the usage CLI, and the command
 * controller's status line) and each had its own copy of this, so a change to how a provider reads
 * would have landed in one of the three. The account manager card joined them, which is where the
 * mechanical rule became visible as a defect: a card listing every provider read `Openai Codex`,
 * `Github Copilot`, `Cloudflare Ai Gateway` and `Deepseek`, none of which is how the vendor spells
 * its own name. Segments the table below knows get that spelling; the rest keep title case.
 */
export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part =>
			part ? (PROVIDER_NAME_SEGMENTS.get(part.toLowerCase()) ?? part[0].toUpperCase() + part.slice(1)) : "",
		)
		.join(" ");
}
