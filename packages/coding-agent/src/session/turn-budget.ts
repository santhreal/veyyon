/** "+Nk" turn token-budget directive. A standalone `+<number><k|m>` token in the user's message sets a per-turn */
import type { Settings } from "../config/settings";

// Number, REQUIRED k/m multiplier, optional `!` hard marker, bounded by whitespace/string edges.
const TURN_BUDGET = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])(!)?(?=\s|$)/i;

export interface TurnBudget {
	/** Output-token ceiling for the turn. */
	total: number;
	/** Whether the ceiling is enforced (eval `agent()` throws past it) vs advisory. */
	hard: boolean;
}

/** Parse a `+Nk`/`+Nm`(`!`) turn-budget directive from `text`, or null when absent. Ignores the setting gate: call `parseTurnBudgetDirective` unless you have */
export function parseTurnBudget(text: string): TurnBudget | null {
	const match = TURN_BUDGET.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2]!.toLowerCase();
	const multiplier = unit === "k" ? 1_000 : 1_000_000;
	return { total: Math.round(value * multiplier), hard: match[3] === "!" };
}

/** Parse the directive only when the operator armed it. The master `magicKeywords.enabled` switch turns off every in-message */
export function parseTurnBudgetDirective(settings: Settings, text: string): TurnBudget | null {
	if (!settings.get("magicKeywords.enabled") || !settings.get("magicKeywords.turnBudget")) return null;
	return parseTurnBudget(text);
}
