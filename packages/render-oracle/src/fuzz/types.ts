import type { OverlayAnchor, OverlayHandle, OverlayOptions } from "@veyyon/tui/tui";
import type { JsonValue } from "@veyyon/utils";
import type { StressModel } from "./model";
import type { StressComponent, StressOverlayComponent, StressOverlayModel } from "./overlay-model";

export type TestPlatform = "darwin" | "linux" | "win32";
export type TerminalMode = "normal" | "unknown" | "intermittentUnknown" | "staleBottom";
export type GeometryMode = "small" | "large";
export type EnvMode = "plain" | "tmux" | "termux" | "appleTerminal" | "iterm2" | "wsl" | "vteNoSync" | "ghostty";
export type ScenarioTag =
	| "small"
	| "large"
	| "tmux"
	| "strictScrollback"
	| "unknownViewport"
	| "foregroundStream"
	| "ed3Risk";
export const ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"TERMUX_VERSION",
	"WEZTERM_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"ALACRITTY_WINDOW_ID",
	"VTE_VERSION",
	"VEYYON_NO_SYNC_OUTPUT",
	"TERM_PROGRAM",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];
// JSON comes from `@veyyon/utils`, which owns the declaration. This harness had its own
// identical copy, so a change to what the repository means by JSON would have reached it
// only if somebody remembered this file.
export type JsonObject = { [key: string]: JsonValue };

export type OperationKind =
	| "appendSmall"
	| "appendExactWidth"
	| "appendBulk"
	| "streamOne"
	| "editVisibleLine"
	| "editOffscreenLine"
	| "offscreenEditAppendRepeatedTail"
	| "insertOffscreen"
	| "insertMiddle"
	| "deleteTrailing"
	| "deleteMiddle"
	| "replaceAll"
	| "toggleCollapsible"
	| "tickStatusHeader"
	| "appendRepeatedTail"
	| "injectBlankCluster"
	| "appendDuplicateOfExisting"
	| "highWaterPreviewCollapse"
	| "eagerStreamingMutation"
	| "scrollUp"
	| "scrollToBottom"
	| "scrollPartial"
	| "resizeWidth"
	| "resizeHeight"
	| "resizeWithAppend"
	| "forceRender"
	| "toggleFocusInput"
	| "moveCursorVisible"
	| "moveCursorOffscreen"
	| "showOverlay"
	| "hideOverlay"
	| "toggleOverlayHidden"
	| "editOverlay"
	| "moveOverlayCursor"
	| "coalescedBurst"
	| "rotateUp"
	| "collapseToFew"
	| "swapOffscreenRows"
	| "resizeBoth"
	| "resizeNoop"
	| "forceRenderAllowUnknown"
	| "forceRenderClearScrollback"
	| "forceRenderAfterEmptyOverflow"
	| "attachChild"
	| "detachChild"
	| "reorderChildren"
	| "mutateChild";

export const OPERATION_KINDS = [
	"appendSmall",
	"appendExactWidth",
	"appendBulk",
	"streamOne",
	"editVisibleLine",
	"editOffscreenLine",
	"offscreenEditAppendRepeatedTail",
	"insertOffscreen",
	"insertMiddle",
	"deleteTrailing",
	"deleteMiddle",
	"replaceAll",
	"toggleCollapsible",
	"tickStatusHeader",
	"appendRepeatedTail",
	"injectBlankCluster",
	"appendDuplicateOfExisting",
	"highWaterPreviewCollapse",
	"eagerStreamingMutation",
	"scrollUp",
	"scrollToBottom",
	"scrollPartial",
	"resizeWidth",
	"resizeHeight",
	"resizeWithAppend",
	"forceRender",
	"toggleFocusInput",
	"moveCursorVisible",
	"moveCursorOffscreen",
	"showOverlay",
	"hideOverlay",
	"toggleOverlayHidden",
	"editOverlay",
	"moveOverlayCursor",
	"coalescedBurst",
	"rotateUp",
	"collapseToFew",
	"swapOffscreenRows",
	"resizeBoth",
	"resizeNoop",
	"forceRenderAllowUnknown",
	"forceRenderClearScrollback",
	"forceRenderAfterEmptyOverflow",
	"attachChild",
	"detachChild",
	"reorderChildren",
	"mutateChild",
] as const satisfies readonly OperationKind[];
export const OPERATION_KIND_SET = new Set<string>(OPERATION_KINDS);

export function isOperationKind(value: unknown): value is OperationKind {
	return typeof value === "string" && OPERATION_KIND_SET.has(value);
}

export const BURST_STEP_KINDS = [
	"appendSmall",
	"streamOne",
	"appendRepeatedTail",
	"injectBlankCluster",
	"editVisibleLine",
	"editOffscreenLine",
	"tickStatusHeader",
	"resizeWidth",
	"resizeHeight",
	"scrollPartial",
	"scrollToBottom",
	"forceRender",
] as const;
export type BurstStepKind = (typeof BURST_STEP_KINDS)[number];
export const OVERLAY_ANCHORS = [
	"center",
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"top-center",
	"bottom-center",
	"left-center",
	"right-center",
] as const satisfies readonly OverlayAnchor[];
export const CURSOR_MODES = ["start", "middle", "end", "wideBoundary"] as const;
export type CursorMode = (typeof CURSOR_MODES)[number];

export interface ExpectedCursor {
	row: number;
	col: number;
}

export interface ExpectedFrame {
	frame: string[];
	cursor: ExpectedCursor | null;
	// Frame columns whose logical content carries background SGR. Only these
	// cells may have non-default background in the terminal; background outside
	// these column ranges is BCE bleed from stale SGR state painting erased cells.
	backgroundColumns: number[][];
}

export interface StressOverlayEntry {
	id: number;
	sentinel: string;
	model: StressOverlayModel;
	component: StressOverlayComponent;
	handle: OverlayHandle;
	options: OverlayOptions;
	hidden: boolean;
	detail: JsonObject;
}

export interface StressChildEntry {
	id: number;
	model: StressModel;
	component: StressComponent;
	active: boolean;
}

export interface LogicalLine {
	id: number;
	text: string;
}

export interface Scenario {
	name: string;
	seed: number;
	platform: TestPlatform;
	terminalMode: TerminalMode;
	envMode: EnvMode;
	geometryMode: GeometryMode;
	columns: number;
	rows: number;
	widthChoices: readonly number[];
	heightChoices: readonly number[];
	iterations: number;
	bulkMax: number;
	scrollback: number;
	strictScrollback: boolean;
	timeoutMs: number;
	uniqueContent: boolean;
	// Models a foreground tool actively streaming output: content frames are
	// re-rendered with a plain (non-forced) `requestRender()`, so offscreen-edit
	// growth flows through `viewportRepaint` (which advances the rendered line
	// count without committing the overflow to native history). The default
	// content-frame path instead forces a render and never exercises that
	// lagging-high-water state.
	foregroundStream: boolean;
	// Renders each logical line wrapped to the viewport width, so a width resize
	// changes the physical line COUNT (reflow), not just per-row truncation —
	// exercising the geometry-change + line-count-change interaction the
	// fixed-line components never produced. Wrapped content must agree with the
	// real Ghostty-backed terminal's cell widths.
	reflow: boolean;
	tags: readonly ScenarioTag[];
	replayOperations?: readonly OperationKind[];
}

export type ViewportProbeTrait = "known" | "unknown" | "intermittentUnknown" | "staleBottom";

export interface TerminalStressTraits {
	readonly preservesPaneHistory: boolean;
	readonly strictNativeScrollback: boolean;
	readonly syncOutputDisabled: boolean;
	readonly viewportProbe: ViewportProbeTrait;
	readonly ed3ScrollbackEraseRisk: boolean;
	readonly conptyHostScrollbackUnobservable: boolean;
	readonly foregroundStreaming: boolean;
}

export interface Snapshot {
	buffer: string[];
	view: string[];
	viewBackgroundColumns: number[][];
	frameBackgroundColumns: number[][];
	position: { baseY: number; viewportY: number };
	cursor: { row: number; col: number };
	expectedCursor: ExpectedCursor | null;
	redraws: number;
	width: number;
	height: number;
	frame: string[];
	atBottom: boolean;
	shadowTapeLength: number;
}
