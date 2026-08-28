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

/** Default for `tools.inlineOutputFloor`, and the compiled fallback `inlineCapForTurn` uses when no caller supplies one. */
export const DEFAULT_INLINE_FLOOR_FRACTION = 0.25;

/** Default for `tools.artifactSpillThreshold`, in KILOBYTES, which is the unit that setting is in. */
export const DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB = 50;

/** The same threshold in BYTES: the compiled inline budget every tool result is priced against when a session has no settings to read. */
export const DEFAULT_INLINE_OUTPUT_MAX_BYTES = DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB * 1024;
