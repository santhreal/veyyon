/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

/**
 * Canonicalize an effort ladder to unique {@link Effort} values in
 * least → most-intensive order.
 *
 * `ThinkingConfig.efforts` is contractually ordered least → most intensive, and
 * the clamp helpers that walk it (`clampThinkingLevelForModel`,
 * `clampAutoThinkingEffort`) break on the first entry past the request, so they
 * are correct only when the ladder honors that order. Identity-derived ladders
 * are built from this constant and are already canonical, but a hand-authored
 * model spec can declare its ladder out of order (`[high, low]`) or with
 * duplicates. Run any ladder through this before baking so the contract holds by
 * construction and every downstream consumer can trust the order. Filtering
 * {@link THINKING_EFFORTS} by membership yields the canonical order and drops
 * duplicates in a single pass; it is the one owner of "efforts in canonical
 * order".
 */
export function canonicalizeEfforts(efforts: readonly Effort[]): Effort[] {
	return THINKING_EFFORTS.filter(effort => efforts.includes(effort));
}
