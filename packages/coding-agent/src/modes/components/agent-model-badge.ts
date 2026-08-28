/** The model badge: which model an agent runs on, and at what reasoning level. ONE owner, because it was two. The Agent Hub formatted the badge one way */
import { ThinkingLevel } from "@veyyon/agent-core";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs } from "../../tools/render-utils";
import type { Theme } from "../theme/theme";

/** `sonnet-4-6 ◒ high`: the model id, then the reasoning level in the colour the theme gives that level. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined, theme: Theme): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** The badge for a `provider/id[:level]` selector string, as the executor reports it and the registry records it. */
export function modelBadgeFromSelector(resolved: string, theme: Theme): string {
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
	return formatModelBadge(selector.slice(selector.indexOf("/") + 1), level, theme);
}
