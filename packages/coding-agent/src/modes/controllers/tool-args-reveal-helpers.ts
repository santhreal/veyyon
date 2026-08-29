import type { Component } from "@veyyon/tui";

export type ToolArgsRevealComponent = Component & {
	updateArgs(args: unknown, toolCallId?: string): void;
};

export const EDIT_RENDERER_STREAMING_KEYS: readonly string[] = ["path", "file_path", "input", "_input"];

export const STREAMING_STRING_KEYS_BY_TOOL: Record<string, readonly string[]> = {
	write: ["path", "file_path", "content"],
	edit: EDIT_RENDERER_STREAMING_KEYS,
	apply_patch: EDIT_RENDERER_STREAMING_KEYS,
	eval: ["code"],
	launch: ["op", "name", "application", "text", "pattern", "signal"],
};

export function streamingStringKeysForTool(toolName: string, rawInput: boolean): readonly string[] | undefined {
	if (rawInput) return undefined;
	return STREAMING_STRING_KEYS_BY_TOOL[toolName];
}

export type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	requestRender(component: Component): void;
};

export type StreamingJsonStringExtractorResult = {
	values: Record<string, string>;
	changed: boolean;
};

export function decodeJsonStringEscape(ch: string): string {
	switch (ch) {
		case '"':
		case "\\":
		case "/":
			return ch;
		case "b":
			return "\b";
		case "f":
			return "\f";
		case "n":
			return "\n";
		case "r":
			return "\r";
		case "t":
			return "\t";
		default:
			return ch;
	}
}

export function isHexDigit(ch: string): boolean {
	return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

export type StreamingJsonStringExtractorState = "scan" | "candidate" | "afterCandidate" | "beforeValue" | "target";
