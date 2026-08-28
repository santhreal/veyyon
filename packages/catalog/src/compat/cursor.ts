import type { ModelSpec, ResolvedCursorCompat } from "../types";

export function buildCursorCompat(_spec: ModelSpec<"cursor-agent">): ResolvedCursorCompat {
	return { trustExplicitThinkingOnly: true };
}
