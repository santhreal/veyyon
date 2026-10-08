import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { THINKING_EFFORTS } from "@veyyon/catalog/effort";

export const AUTO_THINKING = "auto" as const;

export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;

/**
 * The complete configuration vocabulary.
 *
 * Model pickers narrow this vocabulary to the variants the active model
 * actually exposes. This follows OpenCode's variant contract: one mechanism,
 * model-specific valid names, and no silently clamped choices.
 */
export const CONFIGURED_THINKING_LEVELS: readonly ConfiguredThinkingLevel[] = [
	ThinkingLevel.Off,
	AUTO_THINKING,
	...THINKING_EFFORTS,
];
