/**
 * The views a tool card shows: what the tool's view renderer draws for the call and the result,
 * one result view per file of a multi-file edit, and the generic card drawn when no renderer owns
 * the card or the one that does threw.
 */
import { logger, sanitizeText } from "@veyyon/utils";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import type { ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import type {
	ToolExecutionDisplay,
	ToolExecutionGenericDisplay,
	ToolExecutionMultiFileItem,
	ToolExecutionPolicies,
} from "@veyyon/wire/presentation";
import { formatArgsInline } from "../tools/core/json-tree-render";
import { shortenEmbeddedPaths } from "../tools/core/render-utils";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";
import type { ToolExecutionBuildParams } from "./tool-execution";

/** One file's outcome in a multi-file edit result's `perFileResults`. */
interface PerFileResult {
	path: string;
	isError?: boolean;
}

/**
 * The views a tool's renderer produced for its card. A multi-file edit result sets `multiFileViews`,
 * any other card sets `callView` and `resultView`; a renderer that threw leaves its view absent and
 * records the error under `failures`.
 */
export interface ToolCardViews {
	callView?: ToolView;
	resultView?: ToolView;
	multiFileViews?: ToolExecutionMultiFileItem[];
	remainingPendingFiles?: number;
	failures?: ToolExecutionDisplay["failures"];
}

/** The views of a card no renderer draws. Shared, so it is never written to. */
export const NO_CARD_VIEWS: Readonly<ToolCardViews> = {};

export function getTextOutput(result: ToolExecutionBuildParams["result"]): string {
	if (!result?.content) return "";
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

/**
 * The views `renderer` draws for the card: one per file when the result reports more than one file's
 * outcome, else the single card's call and result views.
 */
export function renderToolCardViews(
	renderer: ToolViewRenderer,
	params: ToolExecutionBuildParams,
	renderableResult: ToolExecutionBuildParams["result"],
	neverRan: boolean,
	policies: ToolExecutionPolicies,
	viewContext: ToolViewContext,
	callArgs: unknown,
	isPartial: boolean,
): ToolCardViews {
	// Check for multi-file edit results
	let perFileResults: PerFileResult[] | undefined;
	if (
		isRecord(renderableResult?.details) &&
		"perFileResults" in renderableResult.details &&
		Array.isArray(renderableResult.details.perFileResults)
	) {
		perFileResults = renderableResult.details.perFileResults as PerFileResult[];
	}

	if (perFileResults && perFileResults.length > 1 && (!params.tool?.view || renderer.renderResult)) {
		return renderMultiFileViews(renderer, perFileResults, viewContext, callArgs, params.args, isPartial);
	}
	return renderSingleCardViews(renderer, params, renderableResult, neverRan, policies, viewContext, callArgs);
}

/**
 * One result view per file of a multi-file edit, and while the call is still running the count of
 * files its arguments name that have not reported yet.
 */
function renderMultiFileViews(
	renderer: ToolViewRenderer,
	perFileResults: PerFileResult[],
	viewContext: ToolViewContext,
	callArgs: unknown,
	args: unknown,
	isPartial: boolean,
): ToolCardViews {
	const multiFileViews: ToolExecutionMultiFileItem[] = [];
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
	return { multiFileViews, remainingPendingFiles: remaining > 0 && isPartial ? remaining : undefined };
}

/**
 * The call and result views of a single card. The call view is skipped once a merged result replaces
 * it, and for a live widget whose call never ran.
 */
function renderSingleCardViews(
	renderer: ToolViewRenderer,
	params: ToolExecutionBuildParams,
	renderableResult: ToolExecutionBuildParams["result"],
	neverRan: boolean,
	policies: ToolExecutionPolicies,
	viewContext: ToolViewContext,
	callArgs: unknown,
): ToolCardViews {
	let callView: ToolView | undefined;
	let resultView: ToolView | undefined;
	let failures: ToolExecutionDisplay["failures"];
	const shouldRenderCall = !renderableResult || !policies.mergeCallAndResult;
	const suppressMergedWidget = neverRan && policies.callIsLiveWidget;

	if (shouldRenderCall && !suppressMergedWidget && (!params.tool?.view || renderer.renderCall)) {
		try {
			callView = renderer.renderCall!(callArgs, viewContext);
		} catch (err) {
			logger.warn("Tool view call renderer threw; showing the generic card", {
				toolName: params.toolName,
				toolCallId: params.toolCallId ?? "",
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
				toolName: params.toolName,
				toolCallId: params.toolCallId ?? "",
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
	return { callView, resultView, failures };
}

/** The generic card: a status icon, the arguments inline, and the output text, marked when it parses as JSON. */
export function buildGenericDisplay(
	args: unknown,
	renderableResult: ToolExecutionBuildParams["result"],
	isPartial: boolean,
	frame: number | undefined,
): ToolExecutionGenericDisplay {
	const icon = isPartial
		? frame !== undefined
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

	return {
		icon,
		argsPreview,
		outputText,
		isJson,
	};
}
