import { THINK_CLOSE, THINK_OPEN, TOOL_CALL_OPEN } from "./wire-tags";

export const TOOL_START_TAGS = [TOOL_CALL_OPEN] as const;
export const START_TAGS = [TOOL_CALL_OPEN, THINK_OPEN] as const;
export const THINK_CLOSE_TAGS = [THINK_CLOSE] as const;
export const COMPLETE_NAME = /^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/;

export type State = "outside" | "thinking" | "tool";
