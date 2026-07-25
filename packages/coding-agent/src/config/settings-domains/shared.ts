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

/**
 * Default for `tools.inlineOutputFloor`, and the compiled fallback
 * `inlineCapForTurn` uses when no caller supplies one.
 *
 * It lives here rather than beside `inlineCapForTurn` because that function is
 * in `session/streaming-output`, which reaches `config/settings` through
 * `tools/render-utils`; importing it from a settings domain would close a cycle
 * back onto the schema. This module is a leaf, so both sides can read the value
 * from one owner instead of writing 0.25 down twice and letting the schema
 * default and the code default drift the first time either is tuned.
 */
export const DEFAULT_INLINE_FLOOR_FRACTION = 0.25;
