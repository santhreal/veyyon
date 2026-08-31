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
 * Is this an effort level?
 *
 * The guard lives beside {@link THINKING_EFFORTS} because that list is the one
 * owner of the values, and a guard that spells them again is a second owner.
 * That is not hypothetical: both OpenAI-compatible servers in `@veyyon/ai` had a
 * hand-written chain of six `value === "..."` comparisons, so adding a level to
 * the ladder left every one of them silently rejecting it, and a request that
 * named the new effort was answered as if it had named none.
 */
export function isEffort(value: unknown): value is Effort {
	return typeof value === "string" && THINKING_EFFORTS.includes(value as Effort);
}

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
