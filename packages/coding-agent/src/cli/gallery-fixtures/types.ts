/** Types for `veyyon gallery` sample data. See {@link ./index} for the aggregated fixture registry and the contract each fixture must satisfy. */
import type { EditMode } from "../../edit";

/** A tool result snapshot, matching the shape `ToolExecutionComponent` consumes. */
export interface GalleryResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

export type GalleryFixtureState = "streaming" | "progress" | "success" | "error";

export interface GalleryFixture {
	/** Display label for the tool header (defaults to the tool name). */
	label?: string;
	/** Edit mode for edit-like tools so the streaming preview dispatches correctly. */
	editMode?: EditMode;
	/** Custom gallery-only renderer for fixtures that are not one ToolExecutionComponent (for example the read-group transcript component). */
	renderState?: (
		state: GalleryFixtureState,
		width: number,
		expanded: boolean,
	) => readonly string[] | Promise<readonly string[]>;
	/** Set for tools whose real `AgentTool` attaches `renderCall`/`renderResult` directly on the instance (e.g. `task`). The harness then attaches */
	customRendered?: boolean;
	/** Renderer-registry key to use when the fixture key is a variant of a tool (e.g. `irc_wait` → `irc`). Defaults to the fixture key. */
	renderer?: string;
	/** Arguments shown during the streaming state — a partial view of {@link args} as if the tool-call JSON were still arriving. May include `__partialJson` */
	streamingArgs?: unknown;
	/** Complete arguments shown for the in-progress, success, and error states. */
	args: unknown;
	/** Successful result. */
	result: GalleryResult;
	/** Failed result. Falls back to a generic error when omitted. */
	errorResult?: GalleryResult;
}
