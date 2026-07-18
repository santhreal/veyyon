import { estimateTokensFromText } from "@veyyon/utils";

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
