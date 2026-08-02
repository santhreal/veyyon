/**
 * "+Nk" turn token-budget directive.
 *
 * A standalone `+<number><k|m>` token in the user's message sets a per-turn
 * output-token budget surfaced by the `eval` `budget` helper. By default it is
 * ADVISORY — the model self-limits via `budget.remaining()`. Append `!`
 * (`+500k!`) to make it a HARD ceiling: eval `agent()` refuses to spawn once the
 * turn's spend reaches it.
 *
 * THE UNIT IS MANDATORY, AND THAT IS THE POINT. An earlier form accepted a bare
 * `+N`, and `+` followed by digits is everywhere in ordinary prose: a pasted
 * diff stat (`the diff is +42 -13 lines`), an agreement (`+1 to that idea`), a
 * count (`bump it to +2 workers`), a delta (`score went +5 today`). Each of
 * those silently armed a ceiling of a few dozen output tokens, which reads as
 * already exhausted — `budget.remaining()` reports nothing left and the hard
 * form makes `agent()` refuse to spawn. Requiring `k` or `m` costs the operator
 * one character and removes the entire class of false positive, because nobody
 * writes `+42k` meaning "forty-two more lines".
 *
 * It is also OFF BY DEFAULT, behind `magicKeywords.turnBudget`. Parsing is only
 * ever reached through `parseTurnBudgetDirective`, which consults the setting
 * first; unarmed, `+500k` is ordinary text.
 */
import type { Settings } from "../config/settings";

// Number, REQUIRED k/m multiplier, optional `!` hard marker, bounded by whitespace/string edges.
const TURN_BUDGET = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])(!)?(?=\s|$)/i;

export interface TurnBudget {
	/** Output-token ceiling for the turn. */
	total: number;
	/** Whether the ceiling is enforced (eval `agent()` throws past it) vs advisory. */
	hard: boolean;
}

/**
 * Parse a `+Nk`/`+Nm`(`!`) turn-budget directive from `text`, or null when absent.
 *
 * Ignores the setting gate: call `parseTurnBudgetDirective` unless you have
 * already established that the operator armed the directive.
 */
export function parseTurnBudget(text: string): TurnBudget | null {
	const match = TURN_BUDGET.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2]!.toLowerCase();
	const multiplier = unit === "k" ? 1_000 : 1_000_000;
	return { total: Math.round(value * multiplier), hard: match[3] === "!" };
}

/**
 * Parse the directive only when the operator armed it.
 *
 * The master `magicKeywords.enabled` switch turns off every in-message
 * directive, and `magicKeywords.turnBudget` (default false) arms this one.
 */
export function parseTurnBudgetDirective(settings: Settings, text: string): TurnBudget | null {
	if (!settings.get("magicKeywords.enabled") || !settings.get("magicKeywords.turnBudget")) return null;
	return parseTurnBudget(text);
}
