import type { ComponentType } from "react";

export interface ToolResultText {
	type: "text";
	text: string;
}

export interface ToolResultImage {
	type: "image";
	data: string;
	mimeType: string;
}

export type ToolResultBlock = ToolResultText | ToolResultImage | { type: string };

export interface ToolResultLike {
	content: readonly ToolResultBlock[];
	details?: unknown;
	isError?: boolean;
}

export interface ToolRenderHost {
	hasAgent?(id: string): boolean;
	openAgent?(id: string): void;
}

export interface ToolRenderProps {
	name: string;
	args: Record<string, unknown>;
	result?: ToolResultLike;
	running?: boolean;
	host?: ToolRenderHost;
}

export interface ToolRenderer {
	Summary: ComponentType<ToolRenderProps>;
	Body?: ComponentType<ToolRenderProps>;
}
