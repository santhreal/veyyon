import type { ToolArgShape } from "./coercion";

export const PI_CALL_OPEN = "<call:";
export const PI_CALL_CLOSE_PREFIX = "</call:";

export type State = "outside" | "thinking" | "opentag" | "body";

export interface OpenCall {
	id: string;
	name: string;
	closer: string;
	shape: ToolArgShape | undefined;
	attrs: Record<string, unknown>;
	rawBlock: string;
	body: string;
	bodyMode: "unknown" | "inline" | "elements";
	inlineKey: string | null;
	streamedInline: number;
}
