import type { ModelSpec, ResolvedDevinCompat } from "../types";

export function buildDevinCompat(_spec: ModelSpec<"devin-agent">): ResolvedDevinCompat {
	return { trustExplicitThinkingOnly: true };
}
