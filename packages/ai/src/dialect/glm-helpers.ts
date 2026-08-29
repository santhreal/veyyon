import {
	ARG_KEY_CLOSE,
	ARG_KEY_OPEN,
	ARG_VALUE_CLOSE,
	ARG_VALUE_OPEN,
	THINK_CLOSE,
	THINK_OPEN,
	TOOL_CALL_CLOSE,
	TOOL_CALL_OPEN,
	TOOL_RESPONSE_CLOSE,
	TOOL_RESPONSE_OPEN,
} from "./wire-tags";

export const OUTSIDE_TAGS = [
	TOOL_CALL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	TOOL_RESPONSE_OPEN,
	TOOL_RESPONSE_CLOSE,
	THINK_OPEN,
	THINK_CLOSE,
] as const;
export const OUTSIDE_TAGS_NO_THINK = [
	TOOL_CALL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	TOOL_RESPONSE_OPEN,
	TOOL_RESPONSE_CLOSE,
] as const;
export const BODY_TAGS = [ARG_KEY_OPEN, TOOL_CALL_CLOSE] as const;

export type State = "outside" | "thinking" | "name" | "body" | "key" | "afterkey" | "value";

export interface OpenCall {
	id: string;
	name: string;
	stringArgs: ReadonlySet<string>;
	arguments: Record<string, unknown>;
	key: string | null;
	valueRaw: string;
	rawBlock: string;
}

export interface TagMatch {
	index: number;
	tag: string;
}
