import type { AgentToolResult, AnyAgentTool } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import type { SnapshotStore } from "@veyyon/hashline";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	type NativeScrollbackLiveRegion,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@veyyon/tui";
import { formatMoreLines, logger } from "@veyyon/utils";
import type { ImageFallbackReason } from "@veyyon/utils/image-fallback";
import { isRecord } from "@veyyon/utils/type-guards";
import type { ToolExecutionBlock } from "@veyyon/wire/presentation";
import type { RenderResultOptions } from "../../../../extensibility/custom-tools/types";
import {
	buildToolRenderContext,
	createToolExecutionProducer,
	notExecutedReason,
	type ToolExecutionProducer,
} from "../../../../presentation/tool-execution";
import { recordImageDisplay } from "../../../../session/image-visibility";
import { transitionsEnabled } from "../../../../theme/shimmer";
import type { Theme } from "../../../../theme/theme";
import { getThemeEpoch, theme } from "../../../../theme/theme";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../../../../tools/core/json-tree-render";
import {
	formatExpandHint,
	formatStatusIcon,
	replaceTabs,
	resolveImageOptions,
	shortenEmbeddedPaths,
	truncateToWidth,
} from "../../../../tools/core/render-utils";
import { toolViewDefinitions } from "../../../../tools/view-registry";
import { drawToolView } from "../../draw/draw-tool-view";
import {
	CachedOutputBlock,
	isFramedBlockComponent,
	markFramedBlockComponent,
	outputBlockContentWidth,
} from "../../draw/output-block";
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
} from "../../draw/rail-motion";
import { renderStatusLine } from "../../draw/status-line";
import { WidthAwareText } from "../../draw/width-aware-text";
import { asyncToolState } from "../../utils/async-tool-state";
import { COMPOSER_INSET_COLS } from "../composer/composer-chrome";
import { reportRendererFailure } from "./renderer-failure";

export { turnFailedToolResult } from "../../../../presentation/tool-execution";

export type DisplaceableToolName = "job" | "todo";

const ROW_INDENT_PATTERN = /^((?:\x1b\[[0-9;]*m)*)( *)/;

function dedent(rows: readonly string[]): string[] {
	let shared = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		if (row.trim() === "") continue;
		shared = Math.min(shared, ROW_INDENT_PATTERN.exec(row)?.[2]?.length ?? 0);
		if (shared === 0) return [...rows];
	}
	if (!Number.isFinite(shared) || shared === 0) return [...rows];
	return rows.map(row =>
		row.trim() === ""
			? row
			: row.replace(ROW_INDENT_PATTERN, (_, color: string, indent: string) => color + indent.slice(shared)),
	);
}

interface ImagePlaceholder {
	readonly block: { data?: string; mimeType?: string };
	readonly reason: ImageFallbackReason;
}

function isAgentToolLike(value: unknown): value is AnyAgentTool {
	return (
		isRecord(value) && ("execute" in value || "renderCall" in value || "renderResult" in value || "view" in value)
	);
}

export interface TranscriptLiveRegionProbe {
	isBlockInLiveRegion(component: Component): boolean;
}

export interface ToolExecutionOptions {
	snapshots?: SnapshotStore;
	showImages?: boolean;
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;
	liveRegion?: TranscriptLiveRegionProbe;
	ui?: TUI;
	expanded?: boolean;
	cwd?: string;
	tool?: AnyAgentTool;
	dataSource?: ToolExecutionProducer;
	customRenderer?: {
		renderCall?: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
		renderResult?: (
			result: AgentToolResult<unknown>,
			options: RenderResultOptions & { renderContext?: Record<string, unknown> },
			theme: Theme,
			args?: unknown,
		) => Component;
	};
}

export interface ToolExecutionHandle extends Component {
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(
		result: {
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> | string;
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

export class ToolExecutionComponent extends Container implements NativeScrollbackLiveRegion, ToolExecutionHandle {
	#contentBox: Box;
	#contentText: WidthAwareText;
	#railWrappers = new WeakMap<Component, Component>();
	#multiFileBoxes: (Box | Spacer)[] = [];
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	#notExecutedNotice: Text | undefined;
	readonly #instanceId = ++toolExecutionInstanceSeq;
	#block: ToolExecutionBlock;
	#options: ToolExecutionOptions;
	#producer?: ToolExecutionProducer;
	#ui?: TUI;
	#expanded = false;
	#showImages: boolean;
	#isPartial = true;
	#resultVersion = 1;
	#lastDisplayKey: string | undefined;
	#displayInputVersion = 0;
	#displayBuilt = false;
	#renderedImageCount = 0;
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	#imageConversionFailures: Set<number> = new Set();
	#spinnerFrame?: number;
	#spinnerInterval?: NodeJS.Timeout;
	#railIdleLive = false;
	#railIdleInterval?: NodeJS.Timeout;
	#railSettleFrame?: number;
	#railSettleInterval?: NodeJS.Timeout;
	#railWasLive = false;
	#railSettled = false;
	#railRowsPresent?: boolean;
	#sealed = false;
	#backgroundTaskFrozen = false;
	#firstResultViewportRepaintShapePainted = false;
	#partialResultShapePainted = false;
	#rawArgs: unknown;
	#producerUnsubscribe?: () => void;
	#inSyncUpdate = false;

	constructor(
		blockOrToolName: ToolExecutionBlock | string,
		argsOrOptions: unknown = {},
		optionsOrTool: ToolExecutionOptions | AnyAgentTool = {},
		toolOrUi?: AnyAgentTool | TUI,
		uiOrCwd?: TUI | string,
		cwdOrToolCallId?: string,
		toolCallIdArg?: string,
	) {
		super();

		let options: ToolExecutionOptions;
		let tool: AnyAgentTool | undefined;
		let ui: TUI | undefined;
		let cwd: string | undefined;
		let toolCallId: string | undefined;

		if (typeof blockOrToolName === "string") {
			// (toolName, args, options, tool, ui, cwd, toolCallId)
			const toolName = blockOrToolName;
			const args = argsOrOptions;
			options = (
				isRecord(optionsOrTool) && !isAgentToolLike(optionsOrTool) ? optionsOrTool : {}
			) as ToolExecutionOptions;
			tool = (isAgentToolLike(optionsOrTool) ? optionsOrTool : toolOrUi) as AnyAgentTool | undefined;
			ui = (
				toolOrUi && isRecord(toolOrUi) && ("requestRender" in toolOrUi || "requestComponentRender" in toolOrUi)
					? toolOrUi
					: uiOrCwd && isRecord(uiOrCwd) && ("requestRender" in uiOrCwd || "requestComponentRender" in uiOrCwd)
						? uiOrCwd
						: undefined
			) as TUI | undefined;
			cwd =
				typeof uiOrCwd === "string" ? uiOrCwd : typeof cwdOrToolCallId === "string" ? cwdOrToolCallId : undefined;
			toolCallId =
				typeof cwdOrToolCallId === "string" && typeof uiOrCwd === "string" ? cwdOrToolCallId : toolCallIdArg;

			this.#options = { ...options };
			if (tool) this.#options.tool = tool;
			if (ui) this.#options.ui = ui;
			if (cwd) this.#options.cwd = cwd;
			this.#ui = this.#options.ui;
			this.#showImages = this.#options.showImages ?? true;
			this.#expanded = this.#options.expanded ?? false;

			this.#producer = createToolExecutionProducer({
				toolName,
				args,
				options: this.#options,
				tool: this.#options.tool,
				toolCallId,
				cwd: this.#options.cwd,
			});
			this.#block = this.#producer.block;
		} else {
			// (block, options)
			this.#block = blockOrToolName;
			this.#options = (argsOrOptions as ToolExecutionOptions) ?? {};
			if (isAgentToolLike(optionsOrTool)) {
				this.#options.tool = optionsOrTool;
			}
			if (toolOrUi && isRecord(toolOrUi) && ("requestRender" in toolOrUi || "requestComponentRender" in toolOrUi)) {
				this.#options.ui = toolOrUi as TUI;
			}
			this.#ui = this.#options.ui;
			this.#showImages = this.#options.showImages ?? true;
			this.#expanded = this.#options.expanded ?? false;

			if (this.#options.dataSource) {
				this.#producer = this.#options.dataSource;
			} else if (this.#options.tool || !this.#block.display) {
				this.#applyRawBlock(this.#block);
			}
		}
		this.#isPartial = this.#block.status === "pending" || this.#block.status === "running";
		this.#sealed =
			this.#block.display?.policies?.sealed ??
			(this.#block.status !== "pending" && this.#block.status !== "running");
		this.#backgroundTaskFrozen = this.#block.display?.policies?.backgroundTaskFrozen ?? false;

		this.#contentBox = new Box(COMPOSER_INSET_COLS, 1);
		this.#contentText = new WidthAwareText(contentWidth => this.#formatGenericFallback(contentWidth), 0, 0);

		this.addChild(this.#contentBox);
		this.setIgnoreTight(true);

		this.#updateSpinnerAnimation();
		this.#updateRailMotion();
		if (this.#producer) {
			this.#setupProducerSubscription();
		}
		this.#updateDisplay();
	}

	#setupProducerSubscription(): void {
		if (!this.#producer) return;
		this.#producerUnsubscribe?.();
		this.#producerUnsubscribe = this.#producer.subscribe(block => {
			this.#block = block;
			// A synchronous update (args, result, seal) bumps its own version and rebuilds once it has
			// finished. A recompute the producer started itself (a streaming diff preview settling)
			// changes no input the display key reads, so the key moves here or the settled preview
			// waits for the next spinner tick to be drawn.
			if (this.#inSyncUpdate) return;
			this.#displayInputVersion++;
			this.#updateDisplay();
			this.#requestScopedRender();
		});
	}

	/**
	 * The block, rebuilt for the expansion, spinner frame and freeze this component is on. A card
	 * reads `context.frame` inside its view (the composer caret blinks on it), so the block is
	 * rebuilt wherever the frame moves: the tick, the spinner starting, and the spinner stopping. The
	 * producer memoizes on the three inputs, so a call that changed none of them costs a comparison.
	 */
	#syncBlock(): void {
		if (!this.#producer) return;
		this.#block = this.#producer.produceBlock({
			expanded: this.#expanded,
			frame: this.#spinnerFrame,
			frozen: this.#backgroundTaskFrozen,
		});
	}

	#parseInputArgs(input: string): unknown {
		if (!input) return undefined;
		try {
			return JSON.parse(input);
		} catch {
			return input;
		}
	}

	#applyRawBlock(block: ToolExecutionBlock): void {
		const args = this.#parseInputArgs(block.input);
		this.#producer ??= createToolExecutionProducer({
			toolName: block.toolName,
			args,
			options: this.#options,
			tool: this.#options.tool,
			toolCallId: block.toolCallId,
			id: block.id,
			cwd: this.#options.cwd,
		});
		this.#producer.updateArgs(args, block.toolCallId);
		if (block.output !== undefined || block.error !== undefined) {
			this.#producer.updateResult(
				{
					content: [{ type: "text", text: block.error ?? block.output ?? "" }],
					isError: block.status === "failed" || block.status === "rejected" || block.status === "aborted",
				},
				block.status === "running" || block.status === "pending",
				block.toolCallId,
			);
		}
		this.#syncBlock();
	}

	getTranscriptBlockVersion(): number {
		return this.#resultVersion + this.#displayInputVersion;
	}

	set(block: ToolExecutionBlock): void {
		this.#rawArgs = undefined;
		if (!block.display) {
			const previousProducer = this.#producer;
			this.#inSyncUpdate = true;
			try {
				this.#applyRawBlock(block);
			} finally {
				this.#inSyncUpdate = false;
			}
			if (this.#producer !== previousProducer) this.#setupProducerSubscription();
		} else {
			this.#producerUnsubscribe?.();
			this.#producerUnsubscribe = undefined;
			if (this.#producer !== this.#options.dataSource) this.#producer?.seal();
			this.#producer = undefined;
			this.#block = block;
		}
		this.#isPartial = this.#block.status === "pending" || this.#block.status === "running";
		this.#sealed = this.#block.display?.policies?.sealed ?? !this.#isPartial;
		this.#backgroundTaskFrozen = this.#block.display?.policies?.backgroundTaskFrozen ?? false;
		this.#resultVersion++;
		this.#displayInputVersion++;
		this.#updateSpinnerAnimation();
		this.#updateRailMotion();
		this.#updateDisplay();
		this.#requestScopedRender();
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		if (toolCallId) this.#block.toolCallId = toolCallId;
		if (this.#rawArgs === args) return;
		this.#rawArgs = args;
		this.#inSyncUpdate = true;
		try {
			if (!this.#producer) {
				this.#producer = createToolExecutionProducer({
					toolName: this.#block.toolName,
					args,
					options: this.#options,
					tool: this.#options.tool,
					toolCallId: this.#block.toolCallId,
					id: this.#block.id,
					cwd: this.#options.cwd,
				});
				this.#setupProducerSubscription();
			}
			this.#producer.updateArgs(args, toolCallId);
			this.#syncBlock();
			this.#displayInputVersion++;
			this.#updateSpinnerAnimation();
			this.#updateDisplay();
		} finally {
			this.#inSyncUpdate = false;
		}
	}

	setArgsComplete(toolCallId?: string): void {
		if (toolCallId) this.#block.toolCallId = toolCallId;
		this.#inSyncUpdate = true;
		try {
			this.#producer?.setArgsComplete(toolCallId);
			this.#syncBlock();
			this.#updateSpinnerAnimation();
			this.#updateDisplay();
		} finally {
			this.#inSyncUpdate = false;
		}
	}

	async whenPreviewSettled(): Promise<void> {
		if (this.#producer) {
			await this.#producer.whenSettled();
		}
	}

	updateResult(
		result: {
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> | string;
			details?: unknown;
			isError?: boolean;
		},
		isPartial = false,
		toolCallId?: string,
	): void {
		if (toolCallId) this.#block.toolCallId = toolCallId;
		if (isPartial && this.#block.toolName === "task" && this.#maybeFreezeBackgroundTask()) {
			return;
		}
		const hadNoResult = this.#isPartial && this.#block.output === undefined && this.#block.error === undefined;
		const wasPartialResult = this.#isPartial;
		const firstResultRepaintShapePainted = this.#firstResultViewportRepaintShapePainted;
		const partialResultPainted = this.#partialResultShapePainted;
		this.#firstResultViewportRepaintShapePainted = false;
		this.#partialResultShapePainted = false;

		this.#inSyncUpdate = true;
		try {
			if (!this.#producer) {
				this.#producer = createToolExecutionProducer({
					toolName: this.#block.toolName,
					args: this.#parseInputArgs(this.#block.input),
					options: this.#options,
					tool: this.#options.tool,
					toolCallId: this.#block.toolCallId,
					id: this.#block.id,
					cwd: this.#options.cwd,
				});
				this.#setupProducerSubscription();
			}
			this.#producer.updateResult(result, isPartial, toolCallId);
			this.#syncBlock();
			this.#isPartial = isPartial;
			this.#resultVersion++;
			this.#updateSpinnerAnimation();
			this.#updateRailMotion();
			this.#updateDisplay();
			this.#resetDisplayForResultTopologyChange(
				hadNoResult && firstResultRepaintShapePainted,
				wasPartialResult && partialResultPainted,
				isPartial,
			);
			this.#maybeConvertImagesForKitty();
		} finally {
			this.#inSyncUpdate = false;
		}
	}

	#imageSourceName(): string | undefined {
		return this.#block.display?.imageSourcePath;
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
		if (!this.#block.toolCallId) return;
		recordImageDisplay(this.#block.toolCallId, index, fallback);
	}

	#maybeConvertImagesForKitty(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		const images = this.#block.display?.images;
		if (!images || images.length === 0) return;

		for (let i = 0; i < images.length; i++) {
			const img = images[i];
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
					if (typeof this.#ui?.requestRender === "function") this.#ui.requestRender();
				})
				.catch(() => {
					this.#imageConversionFailures.add(index);
					this.#displayInputVersion++;
					this.#updateDisplay();
					if (typeof this.#ui?.requestRender === "function") this.#ui.requestRender();
				});
		}
	}

	#updateSpinnerAnimation(): void {
		const policies = this.#block.display?.policies;
		const isStreamingArgs =
			!this.#sealed &&
			this.#isPartial &&
			(this.#block.toolName === "edit" ||
				this.#block.toolName === "apply_patch" ||
				this.#block.toolName === "write");
		const isBackgroundAsyncRunning = policies?.backgroundTaskFrozen === true;
		const pendingCallConsumesSpinner = this.#isPartial && policies?.animatedPendingPreview === true;
		const partialResultConsumesSpinner = this.#isPartial && policies?.animatedPartialResult === true;
		const isLivePartialTool =
			this.#isPartial &&
			!isBackgroundAsyncRunning &&
			(pendingCallConsumesSpinner || partialResultConsumesSpinner || policies?.displaceable === "job");
		const needsSpinner = isStreamingArgs || isLivePartialTool;

		if (needsSpinner && !this.#spinnerInterval) {
			const frameCount = theme.spinnerFrames.length;
			const frame = sharedSpinnerFrame(frameCount);
			this.#spinnerFrame = frame;
			this.#spinnerInterval = setInterval(() => {
				if (this.#maybeFreezeBackgroundTask()) return;
				if (!Array.isArray(theme?.spinnerFrames)) {
					logger.warn("Spinner stopped: the active theme has no spinner frames", {
						tool: this.#block.toolName,
						theme: theme === undefined ? "unset" : "no spinnerFrames",
					});
					this.stopAnimation();
					return;
				}
				const fCount = theme.spinnerFrames.length;
				this.#spinnerFrame = sharedSpinnerFrame(fCount, performance.now());
				this.#syncBlock();
				this.#updateDisplay();
				this.#requestScopedRender();
			}, SPINNER_RENDER_INTERVAL_MS);
		} else if (!needsSpinner && this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			this.#spinnerFrame = undefined;
		}
		this.#syncBlock();
	}

	#maybeFreezeBackgroundTask(): boolean {
		if (this.#backgroundTaskFrozen) return true;
		if (this.#block.toolName !== "task" || this.#options.liveRegion === undefined) return false;
		if (!this.#options.liveRegion.isBlockInLiveRegion(this)) {
			this.#backgroundTaskFrozen = true;
			this.#syncBlock();
			this.#updateSpinnerAnimation();
			this.#updateDisplay();
			this.#requestScopedRender();
			return true;
		}
		return false;
	}

	#updateRailMotion(): void {
		if (!transitionsEnabled()) {
			this.#stopRailMotion();
			return;
		}
		const live = !this.#sealed && !this.#backgroundTaskFrozen && this.#isPartial;
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
		if (this.#sealed || this.#backgroundTaskFrozen || !this.#isPartial) {
			if (!this.#railSettled && this.#railWasLive && !this.#sealed && !this.#backgroundTaskFrozen) {
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
				return;
			}
			this.#stopRailSettle();
		}
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
		const cached = this.#railWrappers.get(component);
		if (cached) return cached;
		const block = new CachedOutputBlock();
		const framed = markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const inner = component.render(outputBlockContentWidth(width, 0));
				const first = inner.findIndex(line => line.trim() !== "");
				if (first === -1) return [];
				const rows = dedent(inner.slice(first));
				const body = rows.slice(1);
				return block.render(
					{
						header: rows[0],
						state: this.#isPartial
							? "running"
							: this.#block.status === "failed" ||
									this.#block.status === "rejected" ||
									this.#block.status === "aborted"
								? "error"
								: "success",
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
			dispose: () => component.dispose?.(),
		});
		this.#railWrappers.set(component, framed);
		return framed;
	}

	#railMotion(railRows: number): RailMotion | undefined {
		if (this.#railSettleFrame !== undefined) return { kind: "settle", frame: this.#railSettleFrame };
		if (!this.#railIdleLive) return undefined;
		if (
			this.#isPartial &&
			(this.#block.toolName === "edit" || this.#block.toolName === "apply_patch" || this.#block.toolName === "write")
		) {
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
		// A displaceable snapshot stays live: its rows are kept out of native scrollback so a
		// follow-up tool call can remove the block.
		if (this.#block.display?.policies?.displaceable) return false;
		if (!this.#isPartial) return true;
		// Partial result: a background async tool is accepted to freeze (the agent continues while
		// it runs and would otherwise pin an unbounded live region); a foreground tool streaming
		// partial output stays live until it finishes.
		return this.#backgroundTaskFrozen || asyncToolState(this.#producer?.result?.details) === "running";
	}

	#requestScopedRender(): void {
		if (this.#ui && typeof this.#ui.requestComponentRender === "function") {
			this.#ui.requestComponentRender(this);
			return;
		}
		if (this.#ui && typeof this.#ui.requestRender === "function") {
			this.#ui.requestRender();
		}
	}

	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.#backgroundTaskFrozen = true;
		this.stopAnimation();
		this.#syncBlock();
		this.#updateDisplay();
		this.#requestScopedRender();
	}

	isDisplaceableBlock(): boolean {
		return Boolean(this.#block.display?.policies?.displaceable) && !this.#sealed;
	}

	canBeDisplacedBy(nextToolName: string | undefined): boolean {
		return (
			Boolean(this.#block.display?.policies?.displaceable) &&
			this.#block.display?.policies?.displaceable === nextToolName &&
			!this.#sealed
		);
	}

	stopAnimation(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			this.#spinnerFrame = undefined;
			this.#syncBlock();
		}
		this.#stopRailMotion();
		this.#producerUnsubscribe?.();
		this.#producerUnsubscribe = undefined;
		this.#producer?.seal();
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#syncBlock();
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

	#needsFirstResultViewportRepaintAtRender(): boolean {
		return this.#block.display?.policies?.forceFirstResultViewportRepaint === true;
	}

	#resetDisplayForResultTopologyChange(
		firstResultAfterRepaintShapePaint: boolean,
		partialResultPaintedBeforeSettle: boolean,
		isPartial: boolean,
	): void {
		const provisionalResultSettled =
			partialResultPaintedBeforeSettle &&
			!isPartial &&
			this.#block.display?.policies?.forceResultViewportRepaintOnSettle === true;
		if (firstResultAfterRepaintShapePaint || provisionalResultSettled) {
			if (typeof this.#ui?.resetDisplay === "function") {
				this.#ui.resetDisplay();
			}
		}
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		this.#firstResultViewportRepaintShapePainted = this.#needsFirstResultViewportRepaintAtRender();
		this.#partialResultShapePainted = this.#isPartial;

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
		const display = this.#block.display;
		const callFailure = display?.failures?.call;
		const resultFailure = display?.failures?.result;

		// Clean up previous multi-file boxes
		for (const box of this.#multiFileBoxes) {
			this.removeChild(box);
		}
		this.#multiFileBoxes = [];

		this.#contentBox.setBgFn(undefined);
		const previousChildren = this.#contentBox.children;
		this.#contentBox.clear();

		const tool = this.#options.tool;
		const custom = this.#options.customRenderer;
		const customCall = custom?.renderCall ?? tool?.renderCall;
		const customResult = custom?.renderResult ?? tool?.renderResult;

		const fallbackText = this.#block.error ?? this.#block.output ?? "";
		const renderState = {
			expanded: this.#expanded,
			isPartial: this.#isPartial,
			spinnerFrame: this.#spinnerFrame,
			renderContext: buildToolRenderContext(
				this.#block.toolName,
				this.#parseInputArgs(this.#block.input),
				{
					content: this.#producer?.result?.content ?? [{ type: "text", text: fallbackText }],
					details: this.#producer?.result?.details,
					isError: this.#producer?.result?.isError ?? Boolean(this.#block.error),
				},
				{ expanded: this.#expanded, frozen: this.#backgroundTaskFrozen },
			),
		};

		const hasResult =
			!display?.neverRan &&
			(!this.#isPartial || this.#block.output !== undefined || this.#block.error !== undefined);
		const mergeCallAndResult =
			display?.policies?.mergeCallAndResult ??
			Boolean(toolViewDefinitions[this.#block.toolName]?.mergeCallAndResult);
		const shouldRenderCall = !hasResult || !mergeCallAndResult;
		// A call render that IS a live widget (`callIsLiveWidget`, today only `ask`) is replaced by
		// the plain label once the call is known never to have run, so an unasked question is not
		// left looking answerable.
		const suppressMergedWidget = display?.neverRan === true && display.policies?.callIsLiveWidget === true;
		const callArgs = this.#producer ? this.#producer.callPreview.arguments : this.#parseInputArgs(this.#block.input);

		// Call Phase
		let callRendered = false;
		if (shouldRenderCall) {
			if (suppressMergedWidget) {
				this.#contentBox.addChild(
					this.#onRail(
						new Text(theme.fg("toolTitle", theme.bold(display?.toolLabel ?? this.#block.toolName)), 0, 0),
					),
				);
				callRendered = true;
			} else if (customCall) {
				try {
					const comp = customCall.call(custom?.renderCall ? custom : tool, callArgs, renderState, theme) as
						| Component
						| undefined;
					if (comp) {
						this.#contentBox.addChild(this.#onRail(comp));
						callRendered = true;
					}
				} catch (err) {
					this.#contentBox.addChild(
						reportRendererFailure(`tool "${this.#block.toolName}" call`, err, "showing the tool name only"),
					);
					this.#contentBox.addChild(
						this.#onRail(
							new Text(theme.fg("toolTitle", theme.bold(display?.toolLabel ?? this.#block.toolName)), 0, 0),
						),
					);
					callRendered = true;
				}
			} else if (callFailure) {
				this.#contentBox.addChild(
					reportRendererFailure(
						`tool "${this.#block.toolName}" call`,
						new Error(callFailure.error),
						"showing the tool name only",
					),
				);
				this.#contentBox.addChild(
					this.#onRail(
						new Text(theme.fg("toolTitle", theme.bold(display?.toolLabel ?? this.#block.toolName)), 0, 0),
					),
				);
				callRendered = true;
			} else if (display?.callView) {
				try {
					const callComp = drawToolView(display.callView, theme, this.#spinnerFrame);
					this.#contentBox.addChild(this.#onRail(callComp));
					callRendered = true;
				} catch (err) {
					this.#contentBox.addChild(
						reportRendererFailure(`tool "${this.#block.toolName}" call`, err, "showing the tool name only"),
					);
					this.#contentBox.addChild(
						this.#onRail(
							new Text(theme.fg("toolTitle", theme.bold(display?.toolLabel ?? this.#block.toolName)), 0, 0),
						),
					);
					callRendered = true;
				}
			} else if (!hasResult && !display?.generic) {
				this.#contentBox.addChild(
					this.#onRail(
						new Text(theme.fg("toolTitle", theme.bold(display?.toolLabel ?? this.#block.toolName)), 0, 0),
					),
				);
				callRendered = true;
			}
		}

		// Result Phase / Generic Display
		if (hasResult) {
			if (customResult) {
				const fallbackText = this.#block.error ?? this.#block.output ?? "";
				const rawContent = this.#producer?.result?.content;
				const content: (TextContent | ImageContent)[] = Array.isArray(rawContent)
					? (rawContent as (TextContent | ImageContent)[])
					: typeof rawContent === "string"
						? [{ type: "text", text: rawContent }]
						: [{ type: "text", text: fallbackText }];
				const resultPayload: AgentToolResult<unknown> = {
					content,
					details: this.#producer?.result?.details,
					isError: this.#producer?.result?.isError ?? Boolean(this.#block.error),
				};
				try {
					const comp = (
						custom?.renderResult
							? custom.renderResult(resultPayload, renderState, theme, callArgs)
							: tool?.renderResult?.(resultPayload, renderState, theme, callArgs)
					) as Component | undefined;
					if (comp) this.#contentBox.addChild(this.#onRail(comp));
				} catch (err) {
					const raw = this.#block.error ?? this.#block.output;
					const fallback = raw ? "showing raw output" : "there is no raw output to show instead";
					this.#contentBox.addChild(reportRendererFailure(`tool "${this.#block.toolName}" result`, err, fallback));
					if (raw) {
						this.#contentBox.addChild(
							this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(shortenEmbeddedPaths(raw))), 0, 0)),
						);
					}
				}
			} else if (resultFailure) {
				const raw = resultFailure.fallbackText ?? this.#block.error ?? this.#block.output;
				const fallback = raw ? "showing raw output" : "there is no raw output to show instead";
				this.#contentBox.addChild(
					reportRendererFailure(`tool "${this.#block.toolName}" result`, new Error(resultFailure.error), fallback),
				);
				if (raw) {
					this.#contentBox.addChild(
						this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(shortenEmbeddedPaths(raw))), 0, 0)),
					);
				}
			} else if (display?.multiFileViews && display.multiFileViews.length > 1) {
				for (let i = 0; i < display.multiFileViews.length; i++) {
					const item = display.multiFileViews[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBox = new Box(COMPOSER_INSET_COLS, 0);
					if (item.view) {
						try {
							const itemComp = drawToolView(item.view, theme, this.#spinnerFrame);
							fileBox.addChild(this.#onRail(itemComp));
						} catch (err) {
							fileBox.addChild(
								reportRendererFailure(
									`tool "${this.#block.toolName}" result`,
									err,
									`no result is shown for ${item.path}`,
								),
							);
						}
					} else if (item.errorNotice) {
						fileBox.addChild(
							reportRendererFailure(
								`tool "${this.#block.toolName}" result`,
								new Error(item.errorNotice),
								`no result is shown for ${item.path}`,
							),
						);
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				if (display.remainingPendingFiles && display.remainingPendingFiles > 0 && this.#isPartial) {
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
							description: theme.fg(
								"dim",
								`${display.remainingPendingFiles} more file${display.remainingPendingFiles > 1 ? "s" : ""} pending…`,
							),
						},
						theme,
					);
					pendingBox.addChild(this.#onRail(new Text(pendingText, 0, 0)));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else if (display?.resultView) {
				try {
					const resultComp = drawToolView(display.resultView, theme, this.#spinnerFrame);
					this.#contentBox.addChild(this.#onRail(resultComp));
				} catch (err) {
					const raw = this.#block.error ?? this.#block.output;
					const fallback = raw ? "showing raw output" : "there is no raw output to show instead";
					this.#contentBox.addChild(reportRendererFailure(`tool "${this.#block.toolName}" result`, err, fallback));
					if (raw) {
						this.#contentBox.addChild(
							this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(shortenEmbeddedPaths(raw))), 0, 0)),
						);
					}
				}
			} else if (display?.generic) {
				this.#contentBox.addChild(this.#onRail(this.#contentText));
				this.#contentText.invalidate();
			} else {
				const raw = this.#block.error ?? this.#block.output;
				if (raw) {
					this.#contentBox.addChild(
						this.#onRail(new Text(theme.fg("toolOutput", replaceTabs(shortenEmbeddedPaths(raw))), 0, 0)),
					);
				}
			}
		} else if (!callRendered && display?.generic) {
			this.#contentBox.addChild(this.#onRail(this.#contentText));
			this.#contentText.invalidate();
		}

		// Images
		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		const images = display?.images;
		if (images && images.length > 0) {
			const canDraw = Boolean(TERMINAL.imageProtocol) && this.#showImages;
			const undrawable: ImagePlaceholder[] = [];

			for (let i = 0; i < images.length; i++) {
				const img = images[i];
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
						budget: this.#ui?.imageBudget,
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

		// Not executed notice
		if (this.#notExecutedNotice) {
			this.removeChild(this.#notExecutedNotice);
			this.#notExecutedNotice = undefined;
		}
		const reason =
			display?.notExecutedReason ??
			notExecutedReason(
				this.#block.output !== undefined || this.#block.error !== undefined ? { details: undefined } : undefined,
				this.#sealed,
			);
		if (reason !== undefined) {
			this.#notExecutedNotice = new Text(
				theme.fg("warning", `${theme.status.warning} ${reason}`),
				COMPOSER_INSET_COLS,
				0,
			);
			this.addChild(this.#notExecutedNotice);
		}
		if (previousChildren.length > 0) {
			const retained = new Set(this.#contentBox.children);
			for (const child of previousChildren) {
				if (!retained.has(child)) child.dispose?.();
			}
		}
		this.#renderedImageCount = this.#imageComponents.length;
	}

	#formatGenericFallback(contentWidth: number): string {
		const lines: string[] = [];
		const display = this.#block.display;
		const generic = display?.generic;
		const icon =
			generic?.icon ??
			(this.#isPartial
				? this.#spinnerFrame !== undefined
					? "running"
					: "pending"
				: this.#block.status === "failed"
					? "error"
					: "done");
		lines.push(
			renderStatusLine(
				{ icon, spinnerFrame: this.#spinnerFrame, title: display?.toolLabel ?? this.#block.toolName },
				theme,
			),
		);

		const args = this.#parseInputArgs(this.#block.input);
		const argsObject = args && typeof args === "object" ? (args as Record<string, unknown>) : null;

		if (!this.#expanded && argsObject && Object.keys(argsObject).length > 0) {
			const inlineBudget = Math.max(20, contentWidth - 2);
			const preview = generic?.argsPreview ?? formatArgsInline(argsObject, inlineBudget, shortenEmbeddedPaths);
			if (preview) {
				lines.push(` ${theme.fg("dim", replaceTabs(shortenEmbeddedPaths(preview)))}`);
			}
		}

		if (this.#expanded && args !== undefined) {
			lines.push("");
			lines.push(theme.fg("dim", "Args"));
			const tree = renderJsonTreeLines(
				args,
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

		const output = this.#block.error ?? this.#block.output;
		if (!output) {
			return lines.join("\n");
		}

		const textContent = replaceTabs(shortenEmbeddedPaths(output.trimEnd()));
		if (!textContent) {
			lines.push(theme.fg("dim", "(no output)"));
			return lines.join("\n");
		}

		if (generic?.isJson || textContent.startsWith("{") || textContent.startsWith("[")) {
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

		for (const line of displayLines) {
			lines.push(theme.fg("toolOutput", truncateToWidth(replaceTabs(shortenEmbeddedPaths(line)), contentWidth)));
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
