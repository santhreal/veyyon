import type { ThinkingLevel } from "@veyyon/agent-core/thinking";

export const AUTO_THINKING = "auto" as const;

export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;
