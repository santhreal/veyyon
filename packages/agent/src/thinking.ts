// The owner, not the `@veyyon/ai` barrel: `@veyyon/catalog/effort` imports nothing, and the barrel is the
// whole streaming engine. This module is a six-entry table and one clamp; it must stay a leaf, because
// `ThinkingLevel` is read by config, by the CLI and by `packages/coding-agent/src/thinking.ts`.
import { Effort } from "@veyyon/catalog/effort";

/**
 * Agent-local thinking selector.
 *
 * `off` disables reasoning, while `inherit` defers to a higher-level selector.
 */
export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: Effort.Minimal,
	Low: Effort.Low,
	Medium: Effort.Medium,
	High: Effort.High,
	XHigh: Effort.XHigh,
	Max: Effort.Max,
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ResolvedThinkingLevel = Exclude<ThinkingLevel, "inherit">;
