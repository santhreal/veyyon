import { type AnyAgentTool, type SyntheticToolResultDetails, toolResultNeverRan } from "@veyyon/agent-core";
import type { SnapshotStore } from "@veyyon/hashline";
import { clampLow, getProjectDir } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import type { ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import type {
	BlockId,
	ToolExecutionBlock,
	ToolExecutionDisplay,
	ToolExecutionImageItem,
	ToolExecutionPolicies,
	ToolStatus,
} from "@veyyon/wire/presentation";
import { asyncToolState } from "../modes/terminal/utils/async-tool-state";
import { DEFAULT_TERMINAL_PREVIEW_LINES, shortenPath, showResolvedModelDefault } from "../tools/core/render-utils";
import { isWaitingPollDetails } from "../tools/shell/job-view";
import { type ToolViewDefinition, toolViewDefinitions } from "../tools/view-registry";
import type { EditMode } from "../utils/edit-mode";
import { displayArguments } from "./display-arguments";
import { toReadEntryView } from "./read-group";
import { ToolCallPreview, type ToolCallPreviewListener } from "./tool-call-preview";
import { buildGenericDisplay, getTextOutput, NO_CARD_VIEWS, renderToolCardViews } from "./tool-card-views";
import { serializeToolInput, type ToolInputMemo, withLazyInput } from "./tool-input";

export type DisplaceableToolName = "job" | "todo";

export function resolveEditModeForTool(toolName: string, tool: AnyAgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	if (isRecord(tool) && "mode" in tool && typeof tool.mode === "string") {
		return tool.mode as EditMode;
	}
	return undefined;
}

export function isTodoToolDetails(details: unknown): boolean {
	return isRecord(details) && "phases" in details && Array.isArray(details.phases);
}

export function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean } | undefined,
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (!result || result.isError === true) return undefined;
	if (toolName === "job" && isWaitingPollDetails(result.details)) return "job";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

export function notExecutedReason(result: { details?: unknown } | undefined, sealed: boolean): string | undefined {
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

export function isNeverRanResult(result: { details?: unknown } | undefined): boolean {
	return toolResultNeverRan(result?.details);
}

export function turnFailedToolResult(errorMessage: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	details: SyntheticToolResultDetails;
} {
	return {
		content: [{ type: "text", text: errorMessage }],
		isError: true,
		details: { __synthetic: true, source: "assistant_stop_error", executed: false, upstreamError: errorMessage },
	};
}

export function getAllImageBlocks(
	result: ToolExecutionBuildParams["result"],
): Array<{ data?: string; mimeType?: string }> {
	if (!result || !Array.isArray(result.content)) return [];
	const contentImages = result.content.filter(
		(c): c is { type: "image"; data?: string; mimeType?: string } => isRecord(c) && c.type === "image",
	);
	let detailImages: Array<{ data?: string; mimeType?: string }> = [];
	if (isRecord(result.details) && "images" in result.details && Array.isArray(result.details.images)) {
		detailImages = result.details.images as Array<{ data?: string; mimeType?: string }>;
	}
	return [...contentImages, ...detailImages];
}

/**
 * The images a block built from `result` shows: every image block that carries both its bytes and
 * its type. Derived from the result alone, so a card can ask for them without building its views.
 */
export function toolExecutionImages(result: ToolExecutionBuildParams["result"]): ToolExecutionImageItem[] | undefined {
	const images: ToolExecutionImageItem[] = [];
	for (const img of getAllImageBlocks(result)) {
		if (img.data && img.mimeType) images.push({ data: img.data, mimeType: img.mimeType });
	}
	return images.length > 0 ? images : undefined;
}

export function getImageSourceName(result: { details?: unknown } | undefined, args: unknown): string | undefined {
	const detailsRecord = isRecord(result?.details) ? result.details : undefined;
	const argsRecord = isRecord(args) ? args : undefined;
	const candidates = [detailsRecord?.resolvedPath, detailsRecord?.sourcePath, argsRecord?.file_path, argsRecord?.path];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) return shortenPath(candidate);
	}
	return undefined;
}

function normalizeTimeoutSeconds(value: unknown, maxSeconds: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return clampLow(value, 1, maxSeconds);
}

export function buildToolRenderContext(
	toolName: string,
	args: unknown,
	result: ToolExecutionBuildParams["result"],
	options: { expanded?: boolean; frozen?: boolean } = {},
): Record<string, unknown> {
	const context: Record<string, unknown> = {};
	if (toolName === "bash") {
		if (result) {
			// Computed when a renderer reads it. The bash card reads its result, not this, so the whole tail
			// of a streaming command is not sanitized a second time on every frame for a field nobody read.
			let output: string | undefined;
			Object.defineProperty(context, "output", {
				configurable: true,
				enumerable: true,
				get: () => (output ??= getTextOutput(result).trimEnd()),
			});
		}
		context.expanded = options.expanded ?? false;
		context.previewLines = DEFAULT_TERMINAL_PREVIEW_LINES;
		const timeoutVal = isRecord(args) && "timeout" in args ? args.timeout : undefined;
		context.timeout = normalizeTimeoutSeconds(timeoutVal, 3600);
	}
	context.hasResult = Boolean(result);
	context.frozen = options.frozen ?? false;
	context.showResolvedModel = showResolvedModelDefault();
	return context;
}

export interface ToolExecutionBuildParams {
	id?: BlockId;
	toolCallId?: string;
	toolName: string;
	toolLabel?: string;
	args?: unknown;
	result?: {
		content?: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> | string;
		details?: unknown;
		isError?: boolean;
	};
	isError?: boolean;
	isPartial?: boolean;
	durationMs?: number;
	timestamp?: number;
	sealed?: boolean;
	tool?: AnyAgentTool;
	toolViewDefinition?: ToolViewDefinition;
	expanded?: boolean;
	frame?: number;
	frozen?: boolean;
	cwd?: string;
	callPreview?: ToolCallPreview;
	snapshots?: SnapshotStore;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	/**
	 * Whether a spawned agent's card shows the model it resolved to. Omitted reads the
	 * `agent.showResolvedModelBadge` setting when a settings store is initialised and is off
	 * otherwise, which is the transcript export run without one.
	 */
	showResolvedModel?: boolean;
}

/**
 * Presentation policies for the card, read from the tool's own policy and its registry definition.
 * A predicate policy is evaluated against the call's arguments.
 */
function resolveToolExecutionPolicies(params: ToolExecutionBuildParams): ToolExecutionPolicies {
	const toolName = params.toolName;
	const args = params.args;
	const result = params.result;
	const definition = params.toolViewDefinition ?? toolViewDefinitions[toolName];
	const isPartial = params.isPartial ?? result === undefined;
	const sealed = params.sealed ?? false;
	const toolPolicy = params.tool as Partial<ToolViewDefinition> | undefined;
	const mergeCallAndResult =
		toolPolicy?.mergeCallAndResult === true ||
		(toolPolicy?.mergeCallAndResult === undefined && definition?.mergeCallAndResult === true);
	const callIsLiveWidget =
		toolPolicy?.callIsLiveWidget === true ||
		(toolPolicy?.callIsLiveWidget === undefined && definition?.callIsLiveWidget === true);
	const inline = toolPolicy?.inline === true || (toolPolicy?.inline === undefined && definition?.inline === true);

	const pendingAnimation = toolPolicy?.animatedPendingPreview ?? definition?.animatedPendingPreview;
	const animatedPendingPreview =
		typeof pendingAnimation === "function" ? pendingAnimation(args) : pendingAnimation === true;

	const partialAnimation = toolPolicy?.animatedPartialResult ?? definition?.animatedPartialResult;
	const animatedPartialResult =
		typeof partialAnimation === "function" ? partialAnimation(args) : partialAnimation === true;

	const firstResultRepaint =
		toolPolicy?.forceFirstResultViewportRepaint ?? definition?.forceFirstResultViewportRepaint;
	const forceFirstResultViewportRepaint =
		typeof firstResultRepaint === "function"
			? firstResultRepaint(args, { expanded: params.expanded ?? false, isPartial })
			: firstResultRepaint === true;

	const forceResultViewportRepaintOnSettle =
		toolPolicy?.forceResultViewportRepaintOnSettle === true ||
		definition?.forceResultViewportRepaintOnSettle === true;

	const displaceable = result ? displaceableToolName(toolName, result, isPartial) : undefined;
	const backgroundTaskFrozen =
		params.frozen ?? (params.toolName === "task" && asyncToolState(result?.details) === "running" && sealed);

	return {
		mergeCallAndResult,
		callIsLiveWidget,
		inline,
		animatedPendingPreview,
		animatedPartialResult,
		forceFirstResultViewportRepaint,
		forceResultViewportRepaintOnSettle,
		backgroundTaskFrozen,
		displaceable,
		sealed,
	};
}

/**
 * What a producer keeps from one build of its block to the next. A card rebuilds its block for a
 * spinner frame or an expansion with the same arguments.
 */
export interface ToolExecutionBuildMemo extends ToolInputMemo {
	/** Whether a view renderer of the last build read the spinner frame. */
	frameRead: boolean;
}

export function buildToolExecutionDisplay(
	params: ToolExecutionBuildParams,
	memo?: ToolExecutionBuildMemo,
): ToolExecutionDisplay {
	const toolName = params.toolName;
	const toolCallId = params.toolCallId ?? "";
	const toolLabel = params.toolLabel ?? params.tool?.label ?? toolName;
	const isPartial = params.isPartial ?? params.result === undefined;
	const sealed = params.sealed ?? false;
	const args = params.args;
	const result = params.result;

	const neverRan = isNeverRanResult(result);
	const renderableResult = neverRan
		? undefined
		: typeof result?.content === "string"
			? { ...result, content: [{ type: "text", text: result.content }] }
			: result;
	const notExecuted = notExecutedReason(result, sealed);

	// Tool view definition & policies
	const definition = params.toolViewDefinition ?? toolViewDefinitions[toolName];
	const policies = resolveToolExecutionPolicies(params);

	// Call args resolution
	const callArgs = params.callPreview ? params.callPreview.arguments : args;

	// View context. The frame is read through a getter so a producer knows whether the views it built
	// change with the spinner; a renderer that spreads the context reads it too.
	if (memo) memo.frameRead = false;
	const frame = params.frame;
	const viewContext: ToolViewContext = {
		expanded: params.expanded ?? false,
		partial: isPartial,
		get frame() {
			if (memo) memo.frameRead = true;
			return frame;
		},
		hasResult: Boolean(renderableResult),
		frozen: policies.backgroundTaskFrozen,
		showResolvedModel: params.showResolvedModel ?? showResolvedModelDefault(),
	};

	// Tool view renderer resolution (tool's own view or registry definition's view)
	const viewRenderer = params.tool?.view ?? definition?.view;
	const views = viewRenderer
		? renderToolCardViews(
				viewRenderer as ToolViewRenderer,
				params,
				renderableResult,
				neverRan,
				policies,
				viewContext,
				callArgs,
				isPartial,
			)
		: NO_CARD_VIEWS;

	// Generic fallback presentation when no renderer owns the card, and when the one that does threw:
	// the reader gets the arguments and the output, never the exception's text.
	const generic =
		(!viewRenderer && !params.tool?.renderCall && !params.tool?.renderResult) || views.failures !== undefined
			? buildGenericDisplay(args, renderableResult, isPartial, params.frame)
			: undefined;

	const imageSourcePath = getImageSourceName(result, args);

	const isError = params.isError === true || renderableResult?.isError === true;

	return {
		toolLabel,
		callView: views.callView,
		resultView: views.resultView,
		multiFileViews: views.multiFileViews,
		remainingPendingFiles: views.remainingPendingFiles,
		readEntry: toolName === "read" ? toReadEntryView(toolCallId, args, result, isPartial, isError) : undefined,
		notExecutedReason: notExecuted,
		neverRan,
		generic,
		images: toolExecutionImages(result),
		imageSourcePath,
		policies,
		failures: views.failures,
	};
}

/** The status a block built from `params` reports, derived without building the block. */
export function toolExecutionStatus(params: ToolExecutionBuildParams): ToolStatus {
	const isPartial = params.isPartial ?? params.result === undefined;
	if (isPartial) return "running";
	const result = params.result;
	if (params.isError === true || result?.isError === true) {
		if (!isNeverRanResult(result)) return "failed";
		const record = result?.details as Record<string, unknown> | undefined;
		return record?.__skipped === true ? "aborted" : "rejected";
	}
	return result === undefined ? "pending" : "succeeded";
}

export function buildToolExecutionBlock(
	params: ToolExecutionBuildParams,
	memo?: ToolExecutionBuildMemo,
): ToolExecutionBlock {
	const toolName = params.toolName;
	const toolCallId = params.toolCallId ?? "";
	const id = params.id ?? (toolCallId ? `tool:${toolCallId}` : `tool:${toolName}:${Date.now()}`);
	const timestamp = params.timestamp ?? Date.now();
	const args = params.args;
	const result = params.result;
	const neverRan = isNeverRanResult(result);
	const status = toolExecutionStatus(params);

	const display = buildToolExecutionDisplay(params, memo);
	const renderableResult = neverRan ? undefined : result;
	const isError = params.isError === true || renderableResult?.isError === true;
	const textOutput = renderableResult ? getTextOutput(renderableResult) : undefined;
	const blockOutput = isError ? undefined : textOutput;
	const blockError = isError ? textOutput : undefined;

	if (memo === undefined) {
		return {
			kind: "tool-execution",
			id,
			toolCallId,
			toolName,
			status,
			input: serializeToolInput(args),
			output: blockOutput,
			error: blockError,
			durationMs: params.durationMs,
			timestamp,
			display,
		};
	}
	return withLazyInput(
		{
			kind: "tool-execution",
			id,
			toolCallId,
			toolName,
			status,
			output: blockOutput,
			error: blockError,
			durationMs: params.durationMs,
			timestamp,
			display,
		} satisfies Omit<ToolExecutionBlock, "input">,
		args,
		memo,
	);
}

export interface ToolExecutionProducerParams {
	toolName: string;
	args?: unknown;
	options?: {
		snapshots?: SnapshotStore;
		editFuzzyThreshold?: number;
		editAllowFuzzy?: boolean;
		showImages?: boolean;
	};
	tool?: AnyAgentTool;
	toolCallId?: string;
	id?: BlockId;
	cwd?: string;
}

/** What the card drawing a producer's block is on: its expansion, spinner frame and freeze. */
export type ToolExecutionDrawContext = Pick<ToolExecutionBuildParams, "expanded" | "frame" | "frozen">;

/** What a producer notifies when its block changes. The listener reads the block when it needs it. */
export interface ToolExecutionListener {
	toolExecutionChanged(): void;
}

const NO_LISTENERS: readonly ToolExecutionListener[] = [];

/**
 * Listeners are objects rather than callbacks, and the producer is its own preview's listener, so a
 * card listening to its producer and the producer listening to its preview hold no closure per card.
 */
export class ToolExecutionProducer implements ToolCallPreviewListener {
	#params: ToolExecutionBuildParams & { isPartial: boolean; sealed: boolean };
	#callPreview: ToolCallPreview;
	/**
	 * Replaced, never mutated, so a notify walks the listeners it started with. A card subscribes
	 * once, and a one-element array is smaller than the backing store of a one-element Set.
	 */
	#listeners: readonly ToolExecutionListener[] = NO_LISTENERS;
	/**
	 * The block for the current parameters and context, or `undefined` once either changed. It is
	 * built when it is next read, never when it changes.
	 *
	 * A card changes several times before a frame draws it: a rebuilt transcript hands it the call and
	 * then the result, and its spinner starts and stops in between. Building on each change built a
	 * rebuilt 3,959-card transcript 13,210 blocks for the 3,959 its first frame drew. A card disposed
	 * with its transcript seals its producer on the way out, and building that sealed block cost a
	 * rebuilt 64k-block transcript two seconds for a block nobody read.
	 */
	#currentBlock: ToolExecutionBlock | undefined;
	/** The policies for the current parameters and context, which a card reads without building its views. */
	#currentPolicies: ToolExecutionPolicies | undefined;
	/** The arguments as the model sent them, so a repeat of the same object is recognised before conforming. */
	#rawArgs: unknown;
	/** The serialized arguments and whether the views read the frame, kept between builds of the block. */
	readonly #memo: ToolExecutionBuildMemo = { inputArgs: undefined, input: undefined, frameRead: false };

	constructor(params: ToolExecutionProducerParams) {
		const cwd = params.cwd ?? getProjectDir();
		const args = displayArguments(params.tool, params.args);
		this.#rawArgs = params.args;
		this.#params = {
			toolName: params.toolName,
			args,
			tool: params.tool,
			toolCallId: params.toolCallId,
			id: params.id,
			isPartial: true,
			sealed: false,
			timestamp: Date.now(),
		};
		this.#callPreview = new ToolCallPreview(args, {
			toolName: params.toolName,
			mode: resolveEditModeForTool(params.toolName, params.tool),
			cwd,
			snapshots: params.options?.snapshots,
			fuzzyThreshold: params.options?.editFuzzyThreshold,
			allowFuzzy: params.options?.editAllowFuzzy,
			listener: this,
		});
		this.#params.callPreview = this.#callPreview;
		this.#callPreview.update(args);
	}

	get block(): ToolExecutionBlock {
		this.#currentBlock ??= buildToolExecutionBlock(this.#params, this.#memo);
		return this.#currentBlock;
	}

	/** The arguments as the card shows them, which the block states serialized as its `input`. */
	get args(): unknown {
		return this.#params.args;
	}

	get toolName(): string {
		return this.#params.toolName;
	}

	get toolCallId(): string | undefined {
		return this.#params.toolCallId;
	}

	set toolCallId(toolCallId: string | undefined) {
		if (toolCallId === this.#params.toolCallId) return;
		this.#params.toolCallId = toolCallId;
		this.#changed();
	}

	get callPreview(): ToolCallPreview {
		return this.#callPreview;
	}

	get result(): ToolExecutionBuildParams["result"] {
		return this.#params.result;
	}

	get isPartial(): boolean {
		return this.#params.isPartial;
	}

	get sealed(): boolean {
		return this.#params.sealed;
	}

	/** The status its block reports, read without building the block. */
	get status(): ToolStatus {
		return toolExecutionStatus(this.#params);
	}

	/** Notify `listener` when the block changes, until it is unsubscribed. */
	subscribe(listener: ToolExecutionListener): void {
		if (!this.#listeners.includes(listener)) this.#listeners = [...this.#listeners, listener];
	}

	unsubscribe(listener: ToolExecutionListener): void {
		if (!this.#listeners.includes(listener)) return;
		const remaining = this.#listeners.filter(existing => existing !== listener);
		this.#listeners = remaining.length === 0 ? NO_LISTENERS : remaining;
	}

	toolCallPreviewChanged(): void {
		this.#changed();
	}

	updateArgs(rawArgs: unknown, toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		if (rawArgs === this.#rawArgs) return;
		this.#rawArgs = rawArgs;
		const args = displayArguments(this.#params.tool, rawArgs);
		this.#params.args = args;
		this.#callPreview.update(args);
		this.#changed();
	}

	setArgsComplete(toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		this.#callPreview.complete = true;
		this.#callPreview.update(this.#params.args);
		this.#changed();
	}

	updateResult(result: NonNullable<ToolExecutionBuildParams["result"]>, isPartial = false, toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		this.#params.result = result;
		this.#params.isPartial = isPartial;
		// The card draws the final result in place of the preview, so the preview computes nothing more.
		if (!isPartial) this.#callPreview.settle();
		this.#changed();
	}

	seal(): void {
		if (this.#params.sealed) return;
		this.#params.sealed = true;
		this.#callPreview.stop();
		this.#changed();
	}

	async whenSettled(): Promise<void> {
		await this.#callPreview.whenSettled();
	}

	/** The block for `context`, built on the first read after the parameters or the context changed. */
	produceBlock(context?: ToolExecutionDrawContext): ToolExecutionBlock {
		if (context) this.#applyContext(context);
		return this.block;
	}

	/**
	 * Forget the built block. Nothing changed, so no listener hears of it; the next read builds the
	 * same block from the same parameters.
	 */
	releaseBlock(): void {
		this.#currentBlock = undefined;
		this.#memo.input = undefined;
		this.#memo.inputArgs = undefined;
	}

	/**
	 * The card's presentation policies for `context`. They are the policies the block for `context`
	 * carries, resolved without building its views, so a card deciding whether to animate, freeze or
	 * give way to the next call does not project a view nobody draws.
	 */
	policies(context?: ToolExecutionDrawContext): ToolExecutionPolicies {
		if (context) this.#applyContext(context);
		this.#currentPolicies ??= this.#currentBlock?.display?.policies ?? resolveToolExecutionPolicies(this.#params);
		return this.#currentPolicies;
	}

	/**
	 * Whether the block changes with the spinner frame: a view read the frame when the block was last
	 * built, or the card declares an animation. A declared animation is rebuilt on every frame, because
	 * its renderer may state what it reads from the clock rather than from the frame.
	 */
	get followsFrame(): boolean {
		if (this.#memo.frameRead) return true;
		const policies = this.policies();
		return policies.animatedPendingPreview || policies.animatedPartialResult || policies.displaceable === "job";
	}

	/**
	 * Take the card's context, dropping the block only when it no longer matches. A spinner frame
	 * moves twelve times a second while a call streams, and a block that does not follow the frame is
	 * the same block at the next one: the generic card states only whether a frame is present, and the
	 * policies do not read it at all.
	 */
	#applyContext(context: ToolExecutionDrawContext): void {
		const params = this.#params;
		const expanded = context.expanded ?? false;
		if ((params.expanded ?? false) === expanded && params.frozen === context.frozen) {
			const previousFrame = params.frame;
			if (previousFrame === context.frame) return;
			params.frame = context.frame;
			if (this.followsFrame || (previousFrame === undefined) !== (context.frame === undefined)) {
				this.#currentBlock = undefined;
			}
			return;
		}
		params.expanded = expanded;
		params.frame = context.frame;
		params.frozen = context.frozen;
		this.#currentBlock = undefined;
		this.#currentPolicies = undefined;
	}

	#changed(): void {
		this.#currentBlock = undefined;
		this.#currentPolicies = undefined;
		for (const listener of this.#listeners) listener.toolExecutionChanged();
	}
}

export function createToolExecutionProducer(params: ToolExecutionProducerParams): ToolExecutionProducer {
	return new ToolExecutionProducer(params);
}
