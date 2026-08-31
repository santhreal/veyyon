/**
 * The model badge: which model an agent runs on, and at what reasoning level.
 *
 * ONE owner, because it was two. The Agent Hub formatted the badge one way
 * (provider prefix stripped, the thinking level coloured by the theme's own
 * level colours) and the task widget another (the raw `provider/id:level`
 * selector, dim, truncated at 30 columns), so the same agent read as
 * `sonnet-4-6 ◒ high` on one surface and `anthropic/sonnet-4-6:high` on the
 * next. Both now call this.
 *
 * The theme is a parameter rather than the module-global import because the
 * task renderer already threads its theme through explicitly; taking it here
 * keeps one code path instead of one-per-caller.
 */
import { ThinkingLevel } from "@veyyon/agent-core";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs } from "../../tools/render-utils";
import type { Theme } from "../theme/theme";

/**
 * `sonnet-4-6 ◒ high`: the model id, then the reasoning level in the colour the
 * theme gives that level.
 *
 * Module-private. Every caller has a `provider/id[:level]` selector rather than a
 * split pair, so {@link modelBadgeFromSelector} is the whole public surface and an
 * exported second entry point would be a way to reach the badge that skips the
 * colon-splitting rule below.
 *
 * `Off` and `Inherit` print nothing extra: they are the absence of a choice,
 * and a badge that says "inherit" spends a column to say the row is like every
 * other row.
 */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined, theme: Theme): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/**
 * The badge for a `provider/id[:level]` selector string, as the executor
 * reports it and the registry records it.
 *
 * Model ids may themselves contain colons (`qwen3:14b`), so the suffix counts
 * as a thinking level only when it parses as one. Splitting on the first colon
 * instead turned `qwen3:14b` into the model `qwen3` at an invented level.
 */
export function modelBadgeFromSelector(resolved: string, theme: Theme): string {
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
	return formatModelBadge(selector.slice(selector.indexOf("/") + 1), level, theme);
}
