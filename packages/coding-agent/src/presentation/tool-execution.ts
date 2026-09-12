import { type AnyAgentTool, type SyntheticToolResultDetails, toolResultNeverRan } from "@veyyon/agent-core";
import type { SnapshotStore } from "@veyyon/hashline";
import { clampLow, getProjectDir, logger, sanitizeText } from "@veyyon/utils";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import type { ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import type {
	BlockId,
	ToolExecutionBlock,
	ToolExecutionDisplay,
	ToolExecutionGenericDisplay,
	ToolExecutionImageItem,
	ToolExecutionMultiFileItem,
	ToolExecutionPolicies,
	ToolStatus,
} from "@veyyon/wire/presentation";
import { settingsOrNull } from "../config/settings-instance";
import { asyncToolState } from "../modes/terminal/utils/async-tool-state";
import { formatArgsInline } from "../tools/core/json-tree-render";
import { DEFAULT_TERMINAL_PREVIEW_LINES, shortenEmbeddedPaths, shortenPath } from "../tools/core/render-utils";
import { isWaitingPollDetails } from "../tools/shell/job-view";
import { type ToolViewDefinition, toolViewDefinitions } from "../tools/view-registry";
import type { EditMode } from "../utils/edit-mode";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";
import { toReadEntryView } from "./read-group";
import { ToolCallPreview } from "./tool-call-preview";

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

export function getImageSourceName(result: { details?: unknown } | undefined, args: unknown): string | undefined {
	const detailsRecord = isRecord(result?.details) ? result.details : undefined;
	const argsRecord = isRecord(args) ? args : undefined;
	const candidates = [detailsRecord?.resolvedPath, detailsRecord?.sourcePath, argsRecord?.file_path, argsRecord?.path];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) return shortenPath(candidate);
	}
	return undefined;
}

export function getTextOutput(result: ToolExecutionBuildParams["result"]): string {
	if (!result || !result.content) return "";
	if (typeof result.content === "string") {
		return sanitizeWithOptionalSixelPassthrough(result.content, sanitizeText);
	}
	if (Array.isArray(result.content)) {
		const textBlocks = result.content.filter(
			(c): c is { type: string; text?: string } => isRecord(c) && c.type === "text" && typeof c.text === "string",
		);
		return textBlocks.map(c => sanitizeWithOptionalSixelPassthrough(c.text || "", sanitizeText)).join("\n");
	}
	return "";
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
			const output = getTextOutput(result).trimEnd();
			context.output = output;
		}
		context.expanded = options.expanded ?? false;
		context.previewLines = DEFAULT_TERMINAL_PREVIEW_LINES;
		const timeoutVal = isRecord(args) && "timeout" in args ? args.timeout : undefined;
		context.timeout = normalizeTimeoutSeconds(timeoutVal, 3600);
	}
	context.hasResult = Boolean(result);
	context.frozen = options.frozen ?? false;
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

export function buildToolExecutionDisplay(params: ToolExecutionBuildParams): ToolExecutionDisplay {
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

	const policies: ToolExecutionPolicies = {
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

	// Call args resolution
	const callArgs = params.callPreview ? params.callPreview.arguments : args;

	// View context
	const viewContext: ToolViewContext = {
		expanded: params.expanded ?? false,
		partial: isPartial,
		frame: params.frame,
		hasResult: Boolean(renderableResult),
		frozen: backgroundTaskFrozen,
		showResolvedModel: params.showResolvedModel ?? settingsOrNull()?.get("agent.showResolvedModelBadge") ?? false,
	};

	// Tool view renderer resolution (tool's own view or registry definition's view)
	const viewRenderer = params.tool?.view ?? definition?.view;

	let callView: ToolView | undefined;
	let resultView: ToolView | undefined;
	let multiFileViews: ToolExecutionMultiFileItem[] | undefined;
	let remainingPendingFiles: number | undefined;
	let failures: ToolExecutionDisplay["failures"];

	if (viewRenderer) {
		const renderer = viewRenderer as ToolViewRenderer;
		// Check for multi-file edit results
		let perFileResults: Array<{ path: string; isError?: boolean }> | undefined;
		if (
			isRecord(renderableResult?.details) &&
			"perFileResults" in renderableResult.details &&
			Array.isArray(renderableResult.details.perFileResults)
		) {
			perFileResults = renderableResult.details.perFileResults as Array<{ path: string; isError?: boolean }>;
		}

		if (perFileResults && perFileResults.length > 1 && (!params.tool?.view || renderer.renderResult)) {
			multiFileViews = [];
			for (const fileResult of perFileResults) {
				try {
					const fv = renderer.renderResult!(
						{ content: [], details: fileResult, isError: fileResult.isError },
						viewContext,
						callArgs,
					);
					multiFileViews.push({ path: fileResult.path, isError: fileResult.isError, view: fv });
				} catch (err) {
					multiFileViews.push({
						path: fileResult.path,
						isError: true,
						errorNotice: errorMessage(err),
					});
				}
			}

			let argEdits: Array<{ path?: unknown }> | undefined;
			if (isRecord(args) && "edits" in args && Array.isArray(args.edits)) {
				argEdits = args.edits as Array<{ path?: unknown }>;
			}
			const totalFiles = argEdits
				? new Set(argEdits.map(e => (isRecord(e) && "path" in e ? e.path : undefined)).filter(Boolean)).size
				: 0;
			const remaining = Math.max(0, totalFiles - perFileResults.length);
			if (remaining > 0 && isPartial) {
				remainingPendingFiles = remaining;
			}
		} else {
			// Single card
			const shouldRenderCall = !renderableResult || !mergeCallAndResult;
			const suppressMergedWidget = neverRan && callIsLiveWidget;

			if (shouldRenderCall && !suppressMergedWidget && (!params.tool?.view || renderer.renderCall)) {
				try {
					callView = renderer.renderCall!(callArgs, viewContext);
				} catch (err) {
					logger.warn("Tool view call renderer threw; showing the generic card", {
						toolName,
						toolCallId,
						error: errorMessage(err),
					});
					failures ??= {};
					failures.call = {
						error: errorMessage(err),
					};
				}
			}

			if (renderableResult && (!params.tool?.view || renderer.renderResult)) {
				try {
					resultView = renderer.renderResult!(
						{
							content: renderableResult.content,
							details: renderableResult.details,
							isError: renderableResult.isError,
						},
						viewContext,
						callArgs,
					);
				} catch (err) {
					logger.warn("Tool view result renderer threw; showing the generic card", {
						toolName,
						toolCallId,
						error: errorMessage(err),
					});
					const raw = getTextOutput(renderableResult);
					failures ??= {};
					failures.result = {
						error: errorMessage(err),
						fallbackText: raw || undefined,
					};
				}
			}
		}
	}

	// Generic fallback presentation when no renderer owns the card, and when the one that does threw:
	// the reader gets the arguments and the output, never the exception's text.
	let generic: ToolExecutionGenericDisplay | undefined;
	if ((!viewRenderer && !params.tool?.renderCall && !params.tool?.renderResult) || failures !== undefined) {
		const icon = isPartial
			? params.frame !== undefined
				? "running"
				: "pending"
			: renderableResult?.isError
				? "error"
				: "done";

		let argsPreview: string | undefined;
		const argsObject = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
		if (argsObject && Object.keys(argsObject).length > 0) {
			argsPreview = formatArgsInline(argsObject, 60, shortenEmbeddedPaths);
		}

		let outputText: string | undefined;
		let isJson = false;
		if (renderableResult) {
			outputText = getTextOutput(renderableResult);
			const trimmed = outputText.trimStart();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					JSON.parse(trimmed);
					isJson = true;
				} catch {}
			}
		}

		generic = {
			icon,
			argsPreview,
			outputText,
			isJson,
		};
	}

	// Image extraction
	const imageBlocks = getAllImageBlocks(result);
	const imageSourcePath = getImageSourceName(result, args);
	const images: ToolExecutionImageItem[] = imageBlocks
		.filter(img => img.data && img.mimeType)
		.map(img => ({ data: img.data, mimeType: img.mimeType }));

	const isError = params.isError === true || renderableResult?.isError === true;

	return {
		toolLabel,
		callView,
		resultView,
		multiFileViews,
		remainingPendingFiles,
		readEntry: toolName === "read" ? toReadEntryView(toolCallId, args, result, isPartial, isError) : undefined,
		notExecutedReason: notExecuted,
		neverRan,
		generic,
		images: images.length > 0 ? images : undefined,
		imageSourcePath,
		policies,
		failures,
	};
}

export function buildToolExecutionBlock(params: ToolExecutionBuildParams): ToolExecutionBlock {
	const toolName = params.toolName;
	const toolCallId = params.toolCallId ?? "";
	const id = params.id ?? (toolCallId ? `tool:${toolCallId}` : `tool:${toolName}:${Date.now()}`);
	const timestamp = params.timestamp ?? Date.now();
	const isPartial = params.isPartial ?? params.result === undefined;
	const args = params.args;
	const result = params.result;
	const neverRan = isNeverRanResult(result);

	let status: ToolStatus;
	if (isPartial) {
		status = "running";
	} else if (params.isError === true || result?.isError === true) {
		if (neverRan) {
			const record = result?.details as Record<string, unknown> | undefined;
			if (record?.__skipped === true) {
				status = "aborted";
			} else {
				status = "rejected";
			}
		} else {
			status = "failed";
		}
	} else if (result === undefined) {
		status = "pending";
	} else {
		status = "succeeded";
	}

	const display = buildToolExecutionDisplay(params);
	const renderableResult = neverRan ? undefined : result;
	const isError = params.isError === true || renderableResult?.isError === true;
	const textOutput = renderableResult ? getTextOutput(renderableResult) : undefined;
	const blockOutput = isError ? undefined : textOutput;
	const blockError = isError ? textOutput : undefined;

	let inputStr = "";
	if (typeof args === "string") {
		inputStr = args;
	} else if (args !== undefined) {
		try {
			inputStr = typeof args === "object" && args !== null ? JSON.stringify(args, null, 2) : JSON.stringify(args);
		} catch {
			inputStr = "[unserializable]";
		}
	}

	return {
		kind: "tool-execution",
		id,
		toolCallId,
		toolName,
		status,
		input: inputStr,
		output: blockOutput,
		error: blockError,
		durationMs: params.durationMs,
		timestamp,
		display,
	};
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

export class ToolExecutionProducer {
	#params: ToolExecutionBuildParams & { isPartial: boolean; sealed: boolean };
	#callPreview: ToolCallPreview;
	#listeners = new Set<(block: ToolExecutionBlock) => void>();
	#currentBlock: ToolExecutionBlock;

	constructor(params: ToolExecutionProducerParams) {
		const cwd = params.cwd ?? getProjectDir();
		this.#params = {
			toolName: params.toolName,
			args: params.args,
			tool: params.tool,
			toolCallId: params.toolCallId,
			id: params.id,
			isPartial: true,
			sealed: false,
			timestamp: Date.now(),
		};
		this.#callPreview = new ToolCallPreview(params.args, {
			toolName: params.toolName,
			mode: resolveEditModeForTool(params.toolName, params.tool),
			cwd,
			snapshots: params.options?.snapshots,
			fuzzyThreshold: params.options?.editFuzzyThreshold,
			allowFuzzy: params.options?.editAllowFuzzy,
			onChange: () => this.#recompute(),
		});
		this.#params.callPreview = this.#callPreview;
		this.#currentBlock = buildToolExecutionBlock(this.#params);
		this.#callPreview.update(params.args);
	}

	get block(): ToolExecutionBlock {
		return this.#currentBlock;
	}

	get toolName(): string {
		return this.#params.toolName;
	}

	get toolCallId(): string | undefined {
		return this.#params.toolCallId;
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

	subscribe(listener: (block: ToolExecutionBlock) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		if (args === this.#params.args) return;
		this.#params.args = args;
		this.#callPreview.update(args);
		this.#recompute();
	}

	setArgsComplete(toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		this.#callPreview.complete = true;
		this.#callPreview.update(this.#params.args);
		this.#recompute();
	}

	updateResult(result: NonNullable<ToolExecutionBuildParams["result"]>, isPartial = false, toolCallId?: string): void {
		if (toolCallId) this.#params.toolCallId = toolCallId;
		this.#params.result = result;
		this.#params.isPartial = isPartial;
		if (!isPartial) this.#callPreview.complete = true;
		this.#recompute();
	}

	seal(): void {
		if (this.#params.sealed) return;
		this.#params.sealed = true;
		this.#callPreview.stop();
		this.#recompute();
	}

	async whenSettled(): Promise<void> {
		await this.#callPreview.whenSettled();
	}

	produceBlock(context?: Pick<ToolExecutionBuildParams, "expanded" | "frame" | "frozen">): ToolExecutionBlock {
		if (!context) return this.#currentBlock;
		const expanded = context.expanded ?? false;
		if (
			(this.#params.expanded ?? false) === expanded &&
			this.#params.frame === context.frame &&
			this.#params.frozen === context.frozen
		) {
			return this.#currentBlock;
		}
		this.#params.expanded = expanded;
		this.#params.frame = context.frame;
		this.#params.frozen = context.frozen;
		this.#currentBlock = buildToolExecutionBlock(this.#params);
		return this.#currentBlock;
	}

	#recompute(): void {
		this.#currentBlock = buildToolExecutionBlock(this.#params);
		for (const listener of this.#listeners) listener(this.#currentBlock);
	}
}

export function createToolExecutionProducer(params: ToolExecutionProducerParams): ToolExecutionProducer {
	return new ToolExecutionProducer(params);
}
