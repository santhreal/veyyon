import { estimateTokensFromText } from "@veyyon/utils";

/**
 * Default per-file token budget for the commit map-reduce pipeline. A single
 * file's diff above this is truncated before it is handed to the map phase.
 * This is the single owner: both the pipeline entry (`index.ts`) and the map
 * phase (`map-phase.ts`) fall back to it when no `maxFileTokens` override is
 * supplied, so their defaults cannot drift apart.
 */
export const MAX_FILE_TOKENS = 50_000;

export function estimateTokens(text: string): number {
	return estimateTokensFromText(text);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
	const tokens = estimateTokens(text);
	if (tokens <= maxTokens) return text;
	// Scale by the text's actual byte density so CJK-heavy content still lands
	// under the budget instead of overshooting a chars*4 slice by ~3x.
	const keep = Math.max(0, Math.floor((text.length * maxTokens) / tokens));
	return `${text.slice(0, keep)}\n[…${text.length - keep}ch elided…]`;
}
