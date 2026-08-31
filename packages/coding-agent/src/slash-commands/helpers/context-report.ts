import { errorMessage, formatNumber } from "@veyyon/utils";
import { computeContextBreakdown } from "../../session/context-usage";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "./format";

/**
 * Build the `/context` ACP-mode text: the model's window, what is in it by
 * category, and how much room is left.
 *
 * The header reports room LEFT as well as used, because that is the number the
 * next decision is made against, and it names the window as the window — the
 * status-line gauge measures against the auto-compaction trigger, which is a
 * smaller number, and the two must never be presented as the same thing.
 *
 * If the breakdown helper throws, the minimal window/used lines are printed WITH
 * the reason: a degraded report that looks like a normal one hides that the
 * categories were never computed.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeContextBreakdown(runtime.session);
		if (breakdown.contextWindow <= 0) {
			return "Context usage is unavailable: no model is selected for this session.";
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const left = Math.max(0, breakdown.contextWindow - breakdown.usedTokens);
		const lines = [
			`Context window: ${formatNumber(breakdown.contextWindow)} tokens`,
			`Used: ${formatNumber(breakdown.usedTokens)} (${usedPct}%) · Left: ${formatNumber(left)} (${100 - usedPct}%)`,
		];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(
				`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${formatNumber(category.tokens)} tokens`,
			);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${formatNumber(breakdown.autoCompactBufferTokens)} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${formatNumber(breakdown.freeTokens)} tokens`);
		}
		return lines.join("\n");
	} catch (error) {
		const reason = errorMessage(error);
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return `Context usage is unavailable: ${reason}`;
		const window = fallback.contextWindow ?? 0;
		const used = fallback.tokens ?? 0;
		return [
			`Context (breakdown by category unavailable: ${reason})`,
			`Window: ${formatNumber(window)}`,
			`Used: ${formatNumber(used)}`,
			window > 0 ? `Left: ${formatNumber(Math.max(0, window - used))}` : "Left: unknown",
		].join("\n");
	}
}
