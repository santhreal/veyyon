import type { EditMode } from "../../edit";

export interface GalleryResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

export type GalleryFixtureState = "streaming" | "progress" | "success" | "error";

export interface GalleryFixture {
	label?: string;
	editMode?: EditMode;
	renderState?: (
		state: GalleryFixtureState,
		width: number,
		expanded: boolean,
	) => readonly string[] | Promise<readonly string[]>;
	customRendered?: boolean;
	renderer?: string;
	streamingArgs?: unknown;
	args: unknown;
	result: GalleryResult;
	errorResult?: GalleryResult;
}
