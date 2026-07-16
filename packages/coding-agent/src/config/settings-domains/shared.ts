import type { ModelTagsSettings } from "../settings-schema";

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
export const EMPTY_STRING_ARRAY: string[] = [];
export const EMPTY_STRING_RECORD: Record<string, string> = {};
export const EMPTY_NUMBER_RECORD: Record<string, number> = {};
export const DEFAULT_CYCLE_ORDER: string[] = ["smol", "slow"];
export const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["job", "irc"];
export const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
export const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
