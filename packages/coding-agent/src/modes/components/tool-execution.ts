import { type AnyAgentTool, type SyntheticToolResultDetails, toolResultNeverRan } from "@veyyon/agent-core";
import type { SnapshotStore } from "@veyyon/hashline";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	type ImageFallbackReason,
	ImageProtocol,
	imageFallback,
	type NativeScrollbackLiveRegion,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@veyyon/tui";
import { clampLow, formatMoreLines, getProjectDir, logger, sanitizeText } from "@veyyon/utils";
import { EDIT_MODE_STRATEGIES, type EditMode, type PerFileDiffPreview } from "../../edit";
import { transitionsEnabled } from "../../modes/theme/shimmer";
import type { Theme } from "../../modes/theme/theme";
import { getThemeEpoch, theme } from "../../modes/theme/theme";
import { recordImageDisplay } from "../../session/image-visibility";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
import { EVAL_DEFAULT_PREVIEW_LINES } from "../../tools/eval-render";
import { isWaitingPollDetails } from "../../tools/job";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../../tools/json-tree";
import {
	formatExpandHint,
	formatStatusIcon,
	replaceTabs,
	resolveImageOptions,
	shortenPath,
	truncateToWidth,
} from "../../tools/render-utils";
import { type FirstResultViewportRepaint, toolRenderers } from "../../tools/renderers";
import type { TodoToolDetails } from "../../tools/todo";
import { renderStatusLine, WidthAwareText } from "../../tui";
import {
	CachedOutputBlock,
	isFramedBlockComponent,
	markFramedBlockComponent,
	outputBlockContentWidth,
} from "../../tui/output-block";
import {
	paintRailMotion,
	RAIL_IDLE_STEP_MS,
	RAIL_SETTLE_FRAME_MS,
	RAIL_SETTLE_FRAMES,
	type RailMotion,
	railClockMs,
	railIdleHeadAtMs,
	railRowCount,
	railStreamHeadAtRow,
} from "../../tui/rail-motion";
import { sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { asyncToolState } from "../utils/async-tool-state";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { renderDiff } from "./diff";
import { reportRendererFailure } from "./renderer-failure";

function stripTrailingUnbalancedRemoval(diff: string | undefined): string | undefined {
	if (!diff) return diff;
	let lastAddIdx = -1;
	for (let i = diff.length - 1; i >= 0; i--) {
		if (diff.charCodeAt(i) === 10 && i + 1 < diff.length && diff[i + 1] === "+") {
			lastAddIdx = i + 1;
			break;
		}
		if (i === 0 && diff[0] === "+") {
			lastAddIdx = 0;
			break;
		}
	}
	let hasTrailingUnbalanced = false;
	let pos = lastAddIdx === -1 ? 0 : diff.indexOf("\n", lastAddIdx) + 1;
	while (pos < diff.length) {
		const nextNl = diff.indexOf("\n", pos);
		const lineEnd = nextNl === -1 ? diff.length : nextNl;
		const ch = diff[pos];
		if (ch === "-" || (ch === "@" && diff[pos + 1] === "@")) {
			hasTrailingUnbalanced = true;
			break;
		}
		pos = lineEnd + 1;
	}
	if (!hasTrailingUnbalanced) return diff;
	if (lastAddIdx === -1) return "";
	const lineEnd = diff.indexOf("\n", lastAddIdx);
	return diff.slice(0, lineEnd === -1 ? diff.length : lineEnd);
}

type DisplaceableToolName = "job" | "todo";

function isTodoToolDetails(details: unknown): details is TodoToolDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"phases" in details &&
		Array.isArray((details as { phases?: unknown }).phases)
	);
}

function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean },
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (result.isError === true) return undefined;
	if (toolName === "job" && isWaitingPollDetails(result.details)) return "job";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

function stabilizeStreamingPreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next: PerFileDiffPreview[] = new Array(previews.length);
	for (let pi = 0; pi < previews.length; pi++) {
		const preview = previews[pi]!;
		if (!preview.diff) {
			next[pi] = preview;
			continue;
		}
		const trimmed = stripTrailingUnbalancedRemoval(preview.diff);
		if (trimmed === preview.diff) {
			next[pi] = preview;
			continue;
		}
		changed = true;
		next[pi] = { ...preview, diff: trimmed ?? "" };
	}
	return changed ? next : previews;
}

function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

const ROW_INDENT_PATTERN = /^((?:\x1b\[[0-9;]*m)*)( *)/;

function dedent(rows: readonly string[]): string[] {
	let shared = Number.POSITIVE_INFINITY;
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		if (row.trim() === "") continue;
		shared = Math.min(shared, ROW_INDENT_PATTERN.exec(row)?.[2]?.length ?? 0);
		if (shared === 0) return rows.slice();
	}
	if (!Number.isFinite(shared) || shared === 0) return rows.slice();
	const result = new Array<string>(rows.length);
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		result[ri] =
			row.trim() === ""
				? row
				: row.replace(ROW_INDENT_PATTERN, (_, color: string, indent: string) => color + indent.slice(shared));
	}
	return result;
}

function resolveEditModeForTool(toolName: string, tool: AnyAgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

function rawTextInputFromPartialJson(partialJson: unknown): string | undefined {
	if (typeof partialJson !== "string") return undefined;
	if (partialJson.length === 0) return undefined;
	const trimmed = partialJson.trimStart();
	if (trimmed.length === 0) return undefined;
	const first = trimmed[0];
	if (first === "{" || first === '"') return undefined;
	return partialJson;
}

function partialJsonOf(args: unknown): string | undefined {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = args.__partialJson;
	return typeof value === "string" ? value : undefined;
}

function getArgsWithStreamedTextInput(args: unknown): unknown {
	if (args == null || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	if (typeof record.input === "string") return args;
	const input = rawTextInputFromPartialJson(record.__partialJson);
	return input === undefined ? args : { ...record, input };
}

interface ImagePlaceholder {
	readonly block: { data?: string; mimeType?: string };
	readonly reason: ImageFallbackReason;
}

export interface TranscriptLiveRegionProbe {
	isBlockInLiveRegion(component: Component): boolean;
}

export interface ToolExecutionOptions {
	snapshots?: SnapshotStore;
	showImages?: boolean; // default: true (only used if terminal supports images)
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;
	liveRegion?: TranscriptLiveRegionProbe;
}

export interface ToolExecutionHandle extends Component {
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	seal(): void;
}

export const SPINNER_RENDER_INTERVAL_MS = 80;
export const SPINNER_GLYPH_ADVANCE_MS = 80;

export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	return frameCount > 0 ? Math.floor(now / SPINNER_GLYPH_ADVANCE_MS) % frameCount : 0;
}

let toolExecutionInstanceSeq = 0;

export function turnFailedToolResult(errorMessage: string): {
	content: Array<{ type: string; text: string }>;
	isError: true;
	details: SyntheticToolResultDetails;
} {
	return {
		content: [{ type: "text", text: errorMessage }],
		isError: true,
		details: { __synthetic: true, source: "assistant_stop_error", executed: false, upstreamError: errorMessage },
	};
}

function notExecutedReason(result: { details?: unknown } | undefined, sealed: boolean): string | undefined {
	if (result === undefined) {
		return sealed ? "no result recorded: this call was cut off before it reported back" : undefined;
	}
	const details = result.details;
	if (details == null || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	if (record.__skipped === true) {
		return record.entered === true
			? "cut off while running: side effects may be partial"
			: "not executed: an interrupt cut the batch short before this call ran";
	}
	if (record.__synthetic !== true || record.executed !== false) return undefined;
	const upstream = typeof record.upstreamError === "string" ? record.upstreamError.trim() : "";
	const detail = upstream.length > 0 && record.batchLedger !== undefined ? `: ${upstream}` : "";
	switch (record.source) {
		case "assistant_stop_aborted":
			return "not executed: the turn was interrupted before this call ran";
		case "assistant_stop_skipped":
			return "not executed: the assistant ended its turn before this call ran";
		case "assistant_stop_length":
			return "not executed: the assistant hit its output limit before the arguments finished";
		case "assistant_stop_error":
			return `not executed: the provider stream failed before this call ran${detail}`;
		default:
			return "not executed";
	}
}

function isNeverRanResult(result: { details?: unknown } | undefined): boolean {
	return toolResultNeverRan(result?.details);
}

export class ToolExecutionComponent extends Container implements NativeScrollbackLiveRegion {
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#contentText: WidthAwareText; // Generic fallback (no custom/built-in renderer)
	#multiFileBoxes: (Box | Spacer)[] = []; // Extra boxes for multi-file edit results
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	#notExecutedNotice: Text | undefined;
	readonly #instanceId = ++toolExecutionInstanceSeq;
	#toolName: string;
	#toolLabel: string;
	#args: unknown;
	#expanded = false;
	#showImages: boolean;
	#editFuzzyThreshold: number | undefined;
	#editAllowFuzzy: boolean | undefined;
	#snapshots?: SnapshotStore;
	#isPartial = true;
	#resultVersion = 0;
	#lastDisplayKey: string | undefined;
	#displayInputVersion = 0;
	#displayBuilt = false;
	#renderedImageCount = 0;
	#tool?: AnyAgentTool;
	#ui: TUI;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: unknown;
	};
	#editMode?: EditMode;
	#editDiffPreview?: PerFileDiffPreview[];
	#editDiffAbort?: AbortController;
	#editDiffLastArgsKey?: string;
	#editDiffInFlight?: Promise<void>;
	#editDiffDirty = false;
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	#imageConversionFailures: Set<number> = new Set();
	#toolCallId?: string;
	#spinnerFrame?: number;
	#spinnerInterval?: NodeJS.Timeout;
	#railIdleLive = false;
	#railIdleInterval?: NodeJS.Timeout;
	#railSettleFrame?: number;
	#railSettleInterval?: NodeJS.Timeout;
	#railWasLive = false;
	#railSettled = false;
	#railRowsPresent?: boolean;
	#argsComplete = false;
	#sealed = false;
	#displaceableByToolName: DisplaceableToolName | undefined;
	#liveRegion?: TranscriptLiveRegionProbe;
	#backgroundTaskFrozen = false;
	#firstResultViewportRepaintShapePainted = false;
	#partialResultShapePainted = false;
	#renderState: {
		spinnerFrame?: number;
		expanded: boolean;
		isPartial: boolean;
		renderContext?: Record<string, unknown>;
	} = {
		expanded: false,
		isPartial: true,
	};

	constructor(
		toolName: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		tool: AnyAgentTool | undefined,
		ui: TUI,
		cwd: string = getProjectDir(),
		toolCallId?: string,
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#showImages = options.showImages ?? true;
		this.#editFuzzyThreshold = options.editFuzzyThreshold;
		this.#editAllowFuzzy = options.editAllowFuzzy;
		this.#snapshots = options.snapshots;
		this.#liveRegion = options.liveRegion;
		this.#tool = tool;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#args = args;
		this.#toolCallId = toolCallId;
		this.#editMode = resolveEditModeForTool(toolName, tool);

		this.#contentBox = new Box(COMPOSER_INSET_COLS, 1);
		this.#contentText = new WidthAwareText(contentWidth => this.#formatToolExecution(contentWidth), 0, 0);

		this.addChild(this.#contentBox);
		this.setIgnoreTight(true);

		this.#updateSpinnerAnimation();
		this.#updateRailMotion();
		this.#updateDisplay();
		this.#schedulePreviewDiff();
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		if (toolCallId) this.#toolCallId = toolCallId;
		if (args === this.#args) return;
		this.#args = args;
		this.#displayInputVersion++;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
		this.#updateDisplay();
	}

	setArgsComplete(toolCallId?: string): void {
		if (toolCallId) this.#toolCallId = toolCallId;
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
	}

	async whenPreviewSettled(): Promise<void> {
		await this.#editDiffInFlight;
	}

	#schedulePreviewDiff(): void {
		this.#editDiffDirty = true;
		if (this.#editDiffInFlight) return;
		this.#editDiffInFlight = this.#drainPreviewDiff().finally(() => {
			this.#editDiffInFlight = undefined;
		});
	}

	async #drainPreviewDiff(): Promise<void> {
		while (this.#editDiffDirty) {
			this.#editDiffDirty = false;
			await this.#computePreviewDiff();
		}
	}

	async #computePreviewDiff(): Promise<void> {
		const editMode = this.#editMode;
		if (!editMode) return;
		const strategy = EDIT_MODE_STRATEGIES[editMode];
		if (!strategy) return;

		const args = this.#args;
		if (args == null || typeof args !== "object") return;

		const previewArgs = getArgsWithStreamedTextInput(args);
		const partialJson = partialJsonOf(previewArgs);
		let effectiveArgs: unknown;
		try {
			effectiveArgs = strategy.extractCompleteEdits(previewArgs, partialJson);
		} catch {
			effectiveArgs = previewArgs;
		}

		const streamingState = this.#argsComplete ? "final" : "stream";
		let argsKey: string;
		try {
			argsKey = `${streamingState}:${Bun.hash(JSON.stringify(effectiveArgs))}`;
		} catch {
			argsKey = `${streamingState}:partial:${Bun.hash(partialJson ?? "")}`;
		}
		if (argsKey === this.#editDiffLastArgsKey) return;
		this.#editDiffLastArgsKey = argsKey;

		const controller = new AbortController();
		this.#editDiffAbort = controller;

		try {
			const isStreaming = !this.#argsComplete;
			if (editMode === "hashline" && !this.#snapshots) return;
			const previews = await strategy.computeDiffPreview(effectiveArgs, {
				cwd: this.#cwd,
				signal: controller.signal,
				snapshots: this.#snapshots!,
				fuzzyThreshold: this.#editFuzzyThreshold,
				allowFuzzy: this.#editAllowFuzzy,
				isStreaming,
			});
			if (controller.signal.aborted) return;
			if (previews) {
				this.#editDiffPreview = isStreaming ? stabilizeStreamingPreviews(previews) : previews;
				this.#displayInputVersion++;
				this.#updateDisplay();
				this.#ui.requestRender();
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			logger.warn("Edit preview diff failed", { tool: this.#toolName, error: String(err) });
		}
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial = false,
		toolCallId?: string,
	): void {
		if (toolCallId) this.#toolCallId = toolCallId;
		if (isPartial && this.#toolName === "task" && this.#maybeFreezeBackgroundTask()) {
			return;
		}
		const hadNoResult = this.#result === undefined;
		const wasPartialResult = this.#result !== undefined && this.#isPartial;
		const firstResultRepaintShapePainted = this.#firstResultViewportRepaintShapePainted;
		const partialResultPainted = this.#partialResultShapePainted;
		this.#firstResultViewportRepaintShapePainted = false;
		this.#partialResultShapePainted = false;
		this.#result = result;
		this.#resultVersion++;
		this.#isPartial = isPartial;
		this.#displaceableByToolName = displaceableToolName(this.#toolName, result, isPartial);
		if (!isPartial) {
			this.#argsComplete = true;
		}
		this.#updateSpinnerAnimation();
		this.#updateRailMotion();
		this.#updateDisplay();
		this.#resetDisplayForResultTopologyChange(
			hadNoResult && firstResultRepaintShapePainted,
			wasPartialResult && partialResultPainted,
			isPartial,
		);
		this.#maybeConvertImagesForKitty();
	}

	#getAllImageBlocks(): Array<{ data?: string; mimeType?: string }> {
		if (!this.#result) return [];
		const blocks = this.#result.content;
		const detailImages =
			(this.#result.details as { images?: Array<{ data?: string; mimeType?: string }> } | undefined)?.images ?? [];
		const out: Array<{ data?: string; mimeType?: string }> = new Array(
			(blocks ? blocks.length : 0) + detailImages.length,
		);
		let oi = 0;
		if (blocks) {
			for (let bi = 0; bi < blocks.length; bi++) {
				if (blocks[bi]!.type === "image") out[oi++] = blocks[bi]!;
			}
		}
		for (let di = 0; di < detailImages.length; di++) out[oi++] = detailImages[di]!;
		out.length = oi;
		return out;
	}

	#imageSourceName(): string | undefined {
		const details = this.#result?.details as { resolvedPath?: unknown; sourcePath?: unknown } | undefined;
		const args = this.#args && typeof this.#args === "object" ? (this.#args as Record<string, unknown>) : undefined;
		const candidates = [details?.resolvedPath, details?.sourcePath, args?.file_path, args?.path];
		for (let ci = 0; ci < candidates.length; ci++) {
			const candidate = candidates[ci];
			if (typeof candidate === "string" && candidate.trim().length > 0) return shortenPath(candidate);
		}
		return undefined;
	}

	#imagePlaceholderRows(placeholders: readonly ImagePlaceholder[]): string {
		const filename = this.#imageSourceName();
		return placeholders
			.map(({ block, reason }) => {
				const mimeType = block.mimeType ?? "image";
				const dimensions = block.data ? (getImageDimensions(block.data, mimeType) ?? undefined) : undefined;
				return imageFallback({ mimeType, dimensions, filename, reason });
			})
			.join("\n");
	}

	#reportImageDisplay(index: number, fallback: ImageFallbackReason | undefined): void {
		if (!this.#toolCallId) return;
		recordImageDisplay(this.#toolCallId, index, fallback);
	}

	#maybeConvertImagesForKitty(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;
			if (this.#imageConversionFailures.has(i)) continue;

			const index = i;
			new Bun.Image(Buffer.from(img.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#convertedImages.set(index, { data, mimeType: "image/png" });
					this.#displayInputVersion++;
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {
					this.#imageConversionFailures.add(index);
					this.#displayInputVersion++;
					this.#updateDisplay();
					this.#ui.requestRender();
				});
		}
	}

	#updateSpinnerAnimation(): void {
		const isStreamingArgs = !this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write");
		const isBackgroundAsyncRunning = asyncToolState(this.#result?.details) === "running";
		const renderer = toolRenderers[this.#toolName] as
			| {
					animatedPendingPreview?: boolean | ((args: unknown) => boolean);
					animatedPartialResult?: boolean | ((args: unknown) => boolean);
			  }
			| undefined;
		const pendingAnimation = renderer?.animatedPendingPreview;
		const partialAnimation = renderer?.animatedPartialResult;
		const pendingCallConsumesSpinner =
			this.#result === undefined &&
			(renderer === undefined
				? // Only the generic #formatToolExecution fallback consumes the frame;
					!this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof pendingAnimation === "function"
					? pendingAnimation(this.#args)
					: pendingAnimation === true);
		const partialResultConsumesSpinner =
			this.#result !== undefined &&
			(renderer === undefined
				? !this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof partialAnimation === "function"
					? partialAnimation(this.#args)
					: partialAnimation === true);
		const isLivePartialTool =
			this.#isPartial &&
			this.#toolName !== "todo" &&
			!isBackgroundAsyncRunning &&
			(pendingCallConsumesSpinner || partialResultConsumesSpinner);
		const needsSpinner = isStreamingArgs || isLivePartialTool || this.#displaceableByToolName === "job";
		if (needsSpinner && !this.#spinnerInterval) {
			const frameCount = theme.spinnerFrames.length;
			const frame = sharedSpinnerFrame(frameCount);
			this.#spinnerFrame = frame;
			this.#renderState.spinnerFrame = frame;
			this.#spinnerInterval = setInterval(() => {
				if (this.#maybeFreezeBackgroundTask()) return;
				const now = performance.now();
				if (!Array.isArray(theme?.spinnerFrames)) {
					logger.warn("Spinner stopped: the active theme has no spinner frames", {
						tool: this.#toolName,
						theme: theme === undefined ? "unset" : "no spinnerFrames",
					});
					this.stopAnimation();
					return;
				}
				const frameCount = theme.spinnerFrames.length;
				this.#spinnerFrame = sharedSpinnerFrame(frameCount, now);
				this.#renderState.spinnerFrame = this.#spinnerFrame;
				this.#requestScopedRender();
			}, SPINNER_RENDER_INTERVAL_MS);
		} else if (!needsSpinner && this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
	}

	#maybeFreezeBackgroundTask(): boolean {
		if (this.#backgroundTaskFrozen) return true;
		if (this.#toolName !== "task" || this.#liveRegion === undefined) return false;
		const asyncState = asyncToolState(this.#result?.details);
		if (asyncState !== "running") return false;
		if (this.#liveRegion.isBlockInLiveRegion(this)) return false;
		this.#backgroundTaskFrozen = true;
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		this.#requestScopedRender();
		return true;
	}

	#updateRailMotion(): void {
		if (!transitionsEnabled()) {
			this.#stopRailMotion();
			return;
		}
		const live = !this.#sealed && !this.#backgroundTaskFrozen && (this.#result === undefined || this.#isPartial);
		if (live) {
			this.#stopRailSettle();
			if (this.#railIdleInterval) return;
			this.#railIdleLive = true;
			this.#railIdleInterval = setInterval(() => {
				if (this.#railRowsPresent !== true) return;
				this.#requestScopedRender();
			}, RAIL_IDLE_STEP_MS);
			return;
		}
		this.#stopRailIdle();
		if (this.#sealed || this.#backgroundTaskFrozen || this.#result === undefined) {
			this.#stopRailSettle();
			return;
		}
		if (this.#railSettled || !this.#railWasLive) return;
		this.#railSettled = true;
		this.#railSettleFrame = 1;
		this.#railSettleInterval = setInterval(() => {
			const next = (this.#railSettleFrame ?? 0) + 1;
			if (next > RAIL_SETTLE_FRAMES) {
				this.#stopRailSettle();
			} else {
				this.#railSettleFrame = next;
			}
			this.#requestScopedRender();
		}, RAIL_SETTLE_FRAME_MS);
	}

	#stopRailIdle(): void {
		if (this.#railIdleInterval) {
			clearInterval(this.#railIdleInterval);
			this.#railIdleInterval = undefined;
		}
		this.#railIdleLive = false;
	}

	#stopRailSettle(): void {
		if (this.#railSettleInterval) {
			clearInterval(this.#railSettleInterval);
			this.#railSettleInterval = undefined;
		}
		this.#railSettleFrame = undefined;
	}

	#stopRailMotion(): void {
		this.#stopRailIdle();
		this.#stopRailSettle();
	}

	#onRail(component: Component): Component {
		if (isFramedBlockComponent(component)) return component;
		const block = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const inner = component.render(outputBlockContentWidth(width, 0));
				const first = inner.findIndex(line => line.trim() !== "");
				if (first === -1) return [];
				const rows = dedent(inner.slice(first));
				const body = rows.slice(1);
				return block.render(
					{
						header: rows[0],
						state: this.#result === undefined ? "running" : this.#result.isError ? "error" : "success",
						sections: body.length > 0 ? [{ lines: body }] : [],
						contentPaddingLeft: 0,
						width,
					},
					theme,
				);
			},
			invalidate: () => {
				block.invalidate();
				component.invalidate?.();
			},
		});
	}

	#railMotion(railRows: number): RailMotion | undefined {
		if (this.#railSettleFrame !== undefined) return { kind: "settle", frame: this.#railSettleFrame };
		if (!this.#railIdleLive) return undefined;
		if (!this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write")) {
			return { kind: "idle", head: railStreamHeadAtRow(railRows) };
		}
		return { kind: "idle", head: railIdleHeadAtMs(railClockMs()) };
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		if (!this.isTranscriptBlockFinalized()) return 0;
		if (this.#railSettleFrame !== undefined) return 0;
		return undefined;
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (this.#result === undefined) return false;
		if (this.#displaceableByToolName) return false;
		if (!this.#isPartial) return true;
		return asyncToolState(this.#result.details) === "running";
	}

	#requestScopedRender(): void {
		if (typeof this.#ui.requestComponentRender === "function") {
			this.#ui.requestComponentRender(this);
			return;
		}
		this.#ui.requestRender();
	}

	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.#displaceableByToolName = undefined;
		this.#backgroundTaskFrozen = true;
		this.stopAnimation();
		this.#updateDisplay();
		this.#requestScopedRender();
	}

	isDisplaceableBlock(): boolean {
		return this.#displaceableByToolName !== undefined && !this.#sealed;
	}

	canBeDisplacedBy(nextToolName: string | undefined): boolean {
		return (
			this.#displaceableByToolName !== undefined && this.#displaceableByToolName === nextToolName && !this.#sealed
		);
	}

	stopAnimation(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
		this.#stopRailMotion();
		this.#editDiffAbort?.abort();
		this.#editDiffAbort = undefined;
		this.#editDiffDirty = false;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const key = `${this.#resultVersion}|${this.#expanded}|${this.#isPartial}|${this.#spinnerFrame ?? "-"}|${this.#showImages}|${getThemeEpoch()}|${this.#displayInputVersion}|${this.#backgroundTaskFrozen}|${this.#sealed}|${TERMINAL.imageProtocol ?? "-"}|${this.#imageSizeKey()}`;
		if (key === this.#lastDisplayKey && this.#displayBuilt) return;
		this.#lastDisplayKey = key;

		this.#rebuildDisplay();
		this.#displayBuilt = true;
	}

	#rendererFlag(name: "forceResultViewportRepaintOnSettle"): boolean {
		const toolValue = (this.#tool as Record<string, unknown> | undefined)?.[name];
		const rendererValue = toolRenderers[this.#toolName]?.[name];
		return toolValue === true || (toolValue === undefined && rendererValue === true);
	}

	#needsFirstResultViewportRepaintAtRender(): boolean {
		if (this.#result !== undefined) return false;
		const toolValue = (this.#tool as { forceFirstResultViewportRepaint?: FirstResultViewportRepaint } | undefined)
			?.forceFirstResultViewportRepaint;
		const value =
			toolValue !== undefined ? toolValue : toolRenderers[this.#toolName]?.forceFirstResultViewportRepaint;
		if (typeof value === "function") return value(this.#args, this.#renderState);
		return value === true;
	}

	#resetDisplayForResultTopologyChange(
		firstResultAfterRepaintShapePaint: boolean,
		partialResultPaintedBeforeSettle: boolean,
		isPartial: boolean,
	): void {
		const provisionalResultSettled =
			partialResultPaintedBeforeSettle && !isPartial && this.#rendererFlag("forceResultViewportRepaintOnSettle");
		if (firstResultAfterRepaintShapePaint || provisionalResultSettled) {
			this.#ui.resetDisplay();
		}
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		this.#firstResultViewportRepaintShapePainted = this.#needsFirstResultViewportRepaintAtRender();
		this.#partialResultShapePainted = this.#result !== undefined && this.#isPartial;
		if (this.#railSettleFrame === undefined && !this.#railIdleLive) return lines;
		const railRows = railRowCount(lines, theme.symbol("block.rail"));
		this.#railRowsPresent = railRows > 0;
		if (railRows === 0) return lines;
		const motion = this.#railMotion(railRows);
		if (!motion) return lines;
		if (motion.kind === "idle") this.#railWasLive = true;
		return paintRailMotion(lines, motion, theme);
	}

	#imageSizeKey(): string {
		if (this.#renderedImageCount === 0) return "-";
		const o = resolveImageOptions();
		return `${o.maxWidthCells}:${o.maxHeightCells ?? "-"}`;
	}

	#rebuildDisplay(): void {
		this.#railRowsPresent = undefined;
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.spinnerFrame = this.#spinnerFrame;
		const neverRan = isNeverRanResult(this.#result);
		const renderableResult = neverRan ? undefined : this.#result;

		if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			const tool = this.#tool;
			const mergeCallAndResult = Boolean((tool as { mergeCallAndResult?: boolean }).mergeCallAndResult);
			this.#contentBox.setBgFn(undefined);
			this.#contentBox.clear();
			this.#renderState.renderContext = this.#buildRenderContext();

			const suppressMergedWidget = neverRan && Boolean((tool as { callIsLiveWidget?: boolean }).callIsLiveWidget);
			const shouldRenderCall = !renderableResult || !mergeCallAndResult;
			if (shouldRenderCall) {
				if (tool.renderCall && !suppressMergedWidget) {
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = tool.renderCall(callArgs, this.#renderState, theme);
						if (callComponent) this.#contentBox.addChild(this.#onRail(callComponent as Component));
					} catch (err) {
						this.#contentBox.addChild(
							reportRendererFailure(this.#rendererSubject("call"), err, "showing the tool name only"),
						);
						this.#contentBox.addChild(
							this.#onRail(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0)),
						);
					}
				} else {
					this.#contentBox.addChild(
						this.#onRail(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0)),
					);
				}
			}

			if (renderableResult && tool.renderResult) {
				try {
					const renderResult = tool.renderResult as (
						result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
						options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number },
						theme: Theme,
						args?: unknown,
					) => Component;
					const resultComponent = renderResult(
						{
							content: renderableResult.content,
							details: renderableResult.details,
							isError: renderableResult.isError,
						},
						this.#renderState,
						theme,
						this.#args,
					);
					if (resultComponent) this.#contentBox.addChild(this.#onRail(resultComponent));
				} catch (err) {
					const output = this.#getTextOutput();
					this.#contentBox.addChild(
						reportRendererFailure(
							this.#rendererSubject("result"),
							err,
							output ? "showing raw output" : "there is no raw output to show instead",
						),
					);
					if (output) {
						this.#contentBox.addChild(this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0)));
					}
				}
			} else if (renderableResult) {
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0)));
				}
			}
			this.#contentBox.setPaddingX(COMPOSER_INSET_COLS);
			this.#contentBox.setBgFn(undefined);
		} else if (this.#toolName in toolRenderers) {
			const renderer = toolRenderers[this.#toolName];

			for (let bi = 0; bi < this.#multiFileBoxes.length; bi++) {
				this.removeChild(this.#multiFileBoxes[bi]!);
			}
			this.#multiFileBoxes = [];

			const perFileResults = (
				renderableResult?.details as { perFileResults?: Array<{ path: string; isError?: boolean }> } | undefined
			)?.perFileResults;
			if (perFileResults && perFileResults.length > 1) {
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				for (let i = 0; i < perFileResults.length; i++) {
					const fileResult = perFileResults[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBox = new Box(COMPOSER_INSET_COLS, 0);
					try {
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							this.#renderState,
							theme,
						);
						if (resultComponent) fileBox.addChild(this.#onRail(resultComponent));
					} catch (err) {
						fileBox.addChild(
							reportRendererFailure(
								this.#rendererSubject("result"),
								err,
								`no result is shown for ${fileResult.path}`,
							),
						);
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				const argEdits = (this.#args as { edits?: Array<{ path?: unknown }> } | undefined)?.edits;
				const seenPaths = new Set<string>();
				if (argEdits) {
					for (let ei = 0; ei < argEdits.length; ei++) {
						const p = argEdits[ei]?.path;
						if (typeof p === "string" && p.length > 0) seenPaths.add(p);
					}
				}
				const totalFiles = seenPaths.size;
				const remaining = Math.max(0, totalFiles - perFileResults.length);
				if (remaining > 0 && this.#isPartial) {
					const pendingSpacer = new Spacer(1);
					this.#multiFileBoxes.push(pendingSpacer);
					this.addChild(pendingSpacer);
					const pendingBox = new Box(COMPOSER_INSET_COLS, 0);
					const spinner =
						this.#spinnerFrame !== undefined ? formatStatusIcon("running", theme, this.#spinnerFrame) : "";
					const pendingText = renderStatusLine(
						{
							iconOverride: spinner,
							title: "Edit",
							description: theme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						theme,
					);
					pendingBox.addChild(this.#onRail(new Text(pendingText, 0, 0)));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else {
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				const suppressMergedWidget = neverRan && Boolean(renderer.callIsLiveWidget);
				const shouldRenderCall = !renderableResult || !renderer.mergeCallAndResult;
				if (shouldRenderCall) {
					if (suppressMergedWidget) {
						this.#contentBox.addChild(
							this.#onRail(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0)),
						);
					} else {
						try {
							const callArgs = this.#getCallArgsForRender();
							const callComponent = renderer.renderCall(callArgs, this.#renderState, theme);
							if (callComponent) this.#contentBox.addChild(this.#onRail(callComponent));
						} catch (err) {
							this.#contentBox.addChild(
								reportRendererFailure(this.#rendererSubject("call"), err, "showing the tool name only"),
							);
							this.#contentBox.addChild(
								this.#onRail(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0)),
							);
						}
					}
				}

				if (renderableResult) {
					try {
						const resultComponent = renderer.renderResult(
							{
								content: renderableResult.content,
								details: renderableResult.details,
								isError: renderableResult.isError,
							},
							this.#renderState,
							theme,
							this.#getCallArgsForRender(),
						);
						if (resultComponent) this.#contentBox.addChild(this.#onRail(resultComponent));
					} catch (err) {
						const output = this.#getTextOutput();
						this.#contentBox.addChild(
							reportRendererFailure(
								this.#rendererSubject("result"),
								err,
								output ? "showing raw output" : "there is no raw output to show instead",
							),
						);
						if (output) {
							this.#contentBox.addChild(
								this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0)),
							);
						}
					}
				}
			}
		} else {
			this.#contentBox.setBgFn(undefined);
			this.#contentBox.clear();
			this.#contentBox.addChild(this.#onRail(this.#contentText));
			this.#contentText.setCustomBgFn(undefined);
			this.#contentText.invalidate();
		}

		for (let ii = 0; ii < this.#imageComponents.length; ii++) {
			this.removeChild(this.#imageComponents[ii]!);
		}
		this.#imageComponents = [];
		for (let si = 0; si < this.#imageSpacers.length; si++) {
			this.removeChild(this.#imageSpacers[si]!);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();
			const canDraw = Boolean(TERMINAL.imageProtocol) && this.#showImages;
			const undrawable: ImagePlaceholder[] = [];

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (!canDraw) {
					const reason = TERMINAL.imageProtocol ? "images-off" : "no-protocol";
					undrawable.push({ block: img, reason });
					this.#reportImageDisplay(i, reason);
					continue;
				}
				if (!img.data || !img.mimeType) continue;

				const converted = this.#convertedImages.get(i);
				const imageData = converted?.data ?? img.data;
				const imageMimeType = converted?.mimeType ?? img.mimeType;

				if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
					if (this.#imageConversionFailures.has(i)) {
						undrawable.push({ block: img, reason: "unsupported-format" });
						this.#reportImageDisplay(i, "unsupported-format");
					}
					continue;
				}

				const spacer = new Spacer(1);
				this.addChild(spacer);
				this.#imageSpacers.push(spacer);
				this.#reportImageDisplay(i, undefined);
				const imageComponent = new Image(
					imageData,
					imageMimeType,
					{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
					{
						...resolveImageOptions(),
						budget: this.#ui.imageBudget,
						imageKey: `te${this.#instanceId}:${i}`,
						onDisplayed: fallback => this.#reportImageDisplay(i, fallback),
					},
				);
				this.#imageComponents.push(imageComponent);
				this.addChild(imageComponent);
			}

			if (undrawable.length > 0) {
				const rows = this.#imagePlaceholderRows(undrawable);
				this.#contentBox.addChild(this.#onRail(new Text(theme.fg("dim", rows), 0, 0)));
			}
		}

		if (this.#notExecutedNotice) {
			this.removeChild(this.#notExecutedNotice);
			this.#notExecutedNotice = undefined;
		}
		const reason = notExecutedReason(this.#result, this.#sealed);
		if (reason !== undefined) {
			this.#notExecutedNotice = new Text(
				theme.fg("warning", `${theme.status.warning} ${reason}`),
				COMPOSER_INSET_COLS,
				0,
			);
			this.addChild(this.#notExecutedNotice);
		}
		this.#renderedImageCount = this.#imageComponents.length;
	}

	#rendererSubject(phase: "call" | "result"): string {
		return `tool "${this.#toolName}" ${phase}`;
	}

	#getCallArgsForRender(): unknown {
		const renderArgs = getArgsWithStreamedTextInput(this.#args);
		if (!isEditLikeToolName(this.#toolName)) {
			return renderArgs;
		}
		const previews = this.#editDiffPreview;
		if (!previews || previews.length === 0) {
			return renderArgs;
		}
		const first = previews[0];
		if (!first?.diff) {
			return renderArgs;
		}
		return { ...(renderArgs as Record<string, unknown>), previewDiff: first.diff };
	}

	#hasArgs(args: Record<string, unknown>): boolean {
		for (const _ in args) return true;
		return false;
	}

	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return clampLow(value, 1, maxSeconds);
		};

		if (this.#toolName === "bash") {
			if (this.#result) {
				const output = this.#getTextOutput().trimEnd();
				context.output = output;
			}
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds((this.#args as { timeout?: unknown } | undefined)?.timeout, 3600);
		} else if (this.#toolName === "eval" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = EVAL_DEFAULT_PREVIEW_LINES;
		} else if (this.#toolName === "task") {
			context.hasResult = Boolean(this.#result);
			context.frozen = this.#backgroundTaskFrozen;
		} else if (isEditLikeToolName(this.#toolName)) {
			context.editMode = this.#editMode;
			const previews = this.#editDiffPreview;
			if (previews && previews.length > 0) {
				const first = previews[0];
				if (first?.diff || first?.error) {
					context.editDiffPreview = first.error
						? { error: first.error }
						: { diff: first.diff ?? "", firstChangedLine: first.firstChangedLine };
				}
				if (previews.length > 1) {
					context.perFileDiffPreview = previews;
				}
			}
			let hasDiff = false;
			if (previews) {
				for (let pi = 0; pi < previews.length; pi++) {
					if (previews[pi]!.diff) {
						hasDiff = true;
						break;
					}
				}
			}
			if (!hasDiff) {
				const editMode = this.#editMode;
				const strategy = editMode ? EDIT_MODE_STRATEGIES[editMode] : undefined;
				const fallback = strategy?.renderStreamingFallback(getArgsWithStreamedTextInput(this.#args), theme);
				if (fallback) context.editStreamingFallback = fallback;
			}
			context.renderDiff = renderDiff;
		}

		return context;
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const blocks = this.#result.content;
		if (!blocks) return "";
		let out = "";
		for (let bi = 0; bi < blocks.length; bi++) {
			const block = blocks[bi]!;
			if (block.type !== "text") continue;
			const sanitized = sanitizeWithOptionalSixelPassthrough(block.text || "", sanitizeText);
			out = out ? `${out}\n${sanitized}` : sanitized;
		}
		return out;
	}

	#formatToolExecution(contentWidth: number): string {
		const lines: string[] = [];
		const result = isNeverRanResult(this.#result) ? undefined : this.#result;
		const icon = this.#isPartial
			? this.#spinnerFrame !== undefined
				? "running"
				: "pending"
			: result?.isError
				? "error"
				: "done";
		lines.push(renderStatusLine({ icon, spinnerFrame: this.#spinnerFrame, title: this.#toolLabel }, theme));

		const argsObject = this.#args && typeof this.#args === "object" ? (this.#args as Record<string, unknown>) : null;
		if (!this.#expanded && argsObject && this.#hasArgs(argsObject)) {
			const inlineBudget = Math.max(20, contentWidth - 2);
			const preview = formatArgsInline(argsObject, inlineBudget);
			if (preview) {
				lines.push(` ${theme.fg("dim", preview)}`);
			}
		}

		if (this.#expanded && this.#args !== undefined) {
			lines.push("");
			lines.push(theme.fg("dim", "Args"));
			const tree = renderJsonTreeLines(
				this.#args,
				theme,
				JSON_TREE_MAX_DEPTH_EXPANDED,
				JSON_TREE_MAX_LINES_EXPANDED,
				JSON_TREE_SCALAR_LEN_EXPANDED,
			);
			for (let j = 0; j < tree.lines.length; j++) lines.push(tree.lines[j]);
			if (tree.truncated) {
				lines.push(theme.fg("dim", "…"));
			}
			lines.push("");
		}

		if (!result) {
			return lines.join("\n");
		}

		const textContent = this.#getTextOutput().trimEnd();
		if (!textContent) {
			lines.push(theme.fg("dim", "(no output)"));
			return lines.join("\n");
		}

		if (textContent.startsWith("{") || textContent.startsWith("[")) {
			try {
				const parsed = JSON.parse(textContent);
				const maxDepth = this.#expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = this.#expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = this.#expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);

				if (tree.lines.length > 0) {
					for (let j = 0; j < tree.lines.length; j++) lines.push(tree.lines[j]);
					if (!this.#expanded) {
						lines.push(formatExpandHint(theme, this.#expanded, true));
					} else if (tree.truncated) {
						lines.push(theme.fg("dim", "…"));
					}
					return lines.join("\n");
				}
			} catch {}
		}

		const outputLines = textContent.split("\n");
		const maxOutputLines = this.#expanded ? 12 : 4;
		const displayLines = outputLines.slice(0, maxOutputLines);

		for (let di = 0; di < displayLines.length; di++) {
			lines.push(theme.fg("toolOutput", truncateToWidth(replaceTabs(displayLines[di]!), contentWidth)));
		}

		if (outputLines.length > maxOutputLines) {
			const remaining = outputLines.length - maxOutputLines;
			lines.push(
				`${theme.fg("dim", `… ${formatMoreLines(remaining)}`)} ${formatExpandHint(theme, this.#expanded, true)}`,
			);
		} else if (!this.#expanded) {
			lines.push(formatExpandHint(theme, this.#expanded, true));
		}

		return lines.join("\n");
	}
}
