import type { ModelSpec, ResolvedCursorCompat } from "../types";

/**
 * Resolve cursor-agent compat. Cursor's transport has no wire reasoning/effort
 * field; effort is selected by routing to a tier-suffixed sibling model id (the
 * `thinking.effortRouting` baked by variant-collapse), exactly like Cascade.
 * So the thinking deriver must never fabricate an effort ladder from identity
 * for these models; only explicit routed metadata counts. An uncollapsed
 * Cursor row (a tier SKU discovery could not fold into a family, or a model
 * with no tier siblings) exposes no effort control at all.
 */
export function buildCursorCompat(_spec: ModelSpec<"cursor-agent">): ResolvedCursorCompat {
	return { trustExplicitThinkingOnly: true };
}
